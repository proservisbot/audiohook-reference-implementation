import WebSocket from 'ws';
import https from 'https';
import { URL } from 'url';
import { DownstreamService, TranscriptionResult, DownstreamConfig, AudioChunk } from './downstream';
import { SessionRecord } from './session';
import { FastifyBaseLogger } from 'fastify';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// AudioCodes Bot API Message Format (compatible with existing TCCP projects)
// ============================================================================

interface AudioCodesWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
  punctuated_word: string;
  speaker: number;
}

interface AudioCodesAlternative {
  transcript: string;
  confidence: number;
  words: AudioCodesWord[];
}

interface AudioCodesChannel {
  alternatives: AudioCodesAlternative[];
}

interface AudioCodesMetadata {
  request_id: string;
  model_info?: Record<string, unknown>;
  model_uuid?: string;
}

interface AudioCodesProvider {
  name: string;
  type: string;
}

interface AudioCodesRecognitionOutput {
  type: string;
  channel_index: number[];
  duration: number;
  start: number;
  is_final: boolean;
  speech_final: boolean;
  channel: AudioCodesChannel;
  metadata?: AudioCodesMetadata;
  from_finalize: boolean;
  provider?: AudioCodesProvider;
}

interface AudioCodesActivityParameters {
  confidence: number;
  recognitionOutput: AudioCodesRecognitionOutput;
  participant: string;
  participantUriUser: string;
  turnId?: string;
  // Start event parameters
  callee?: string;
  calleeHost?: string;
  caller?: string;
  callerHost?: string;
  participants?: Array<{
    participant: string;
    uriUser: string;
    uriHost?: string;
  }>;
  vaigConversationId?: string;
  CallSid?: string;
  'X-Twilio-CallSid'?: string;
}

interface AudioCodesActivity {
  id: string;
  timestamp: string;
  language: string;
  type: 'message' | 'event';
  text?: string;
  name?: string; // for event type: 'start', 'disconnect', etc.
  parameters: AudioCodesActivityParameters;
}

interface AudioCodesMessage {
  conversation: string;
  activities: AudioCodesActivity[];
}

// ============================================================================
// TCCP WebSocket Message Wrapper
// ============================================================================

interface TCCPMessage {
  type: 'activity' | 'disconnect' | 'error' | 'ack';
  sessionId: string;
  timestamp: string;
  payload: AudioCodesMessage | { reason?: string; reasonCode?: string };
}

/**
 * TCCP Adapter - AudioCodes Bot API Compatible
 * 
 * This adapter connects to external TCCP service via WebSocket using the
 * AudioCodes Bot API message format for compatibility with existing projects.
 * 
 * Unlike Deepgram adapter, it does NOT receive raw audio.
 * Instead, it receives:
 * - Transcription results from Deepgram (forwarded as AudioCodes activities)
 * - Session lifecycle events from AudioHook (forwarded as AudioCodes events)
 */
export class TCCPAdapter implements DownstreamService {
  readonly name = 'TCCP';
  private config: DownstreamConfig;
  private logger: FastifyBaseLogger;
  
  // Session management - tracks TCCP WebSocket connections and state
  private sessions = new Map<string, {
    ws: WebSocket;
    sessionId: string;
    conversationId: string;
    connected: boolean;
    transcripts: TranscriptionResult[];
    turnId: string;
    participants: {
      inbound: { id: string; uriUser: string };
      outbound: { id: string; uriUser: string };
    };
  }>();

  constructor(config: DownstreamConfig, logger: FastifyBaseLogger) {
    this.config = config;
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    // Support both legacy TCCP env vars and new AudioCodes env vars
    const botUrl = this.config.audioCodesBotUrl || this.config.tccpEndpoint;
    const apiKey = this.config.audioCodesApiKey || this.config.tccpApiKey;
    
    if (!botUrl) {
      throw new Error('AUDIOCODES_BOT_URL or TCCP_ENDPOINT is required');
    }
    if (!apiKey) {
      throw new Error('AUDIOCODES_API_KEY or TCCP_API_KEY is required');
    }
    
    this.logger.info({ 
      botUrl,
      hasEventWebhook: !!this.config.eventWebhookUrl,
    }, 'TCCP adapter initialized (AudioCodes format, no audio)');
  }

  /**
   * Start TCCP session - connects to TCCP service and sends AudioCodes start activity
   * Called when AudioHook session opens
   */
  async startTranscription(sessionId: string, session: SessionRecord): Promise<void> {
    const ws = await this.connectToTCCP(sessionId, session);
    
    // Generate turnId for this conversation (matches Go implementation)
    const turnId = uuidv4();
    
    // Setup participants (inbound/outbound legs)
    const participants = {
      inbound: { id: 'participant', uriUser: 'inbound' },
      outbound: { id: 'participant-2', uriUser: 'outbound' },
    };
    
    this.sessions.set(sessionId, {
      ws,
      sessionId,
      conversationId: session.conversationId,
      connected: true,
      transcripts: [],
      turnId,
      participants,
    });

    // Send AudioCodes start activity (matches Go: sendStartActivity)
    const startActivity: AudioCodesMessage = {
      conversation: session.conversationId,
      activities: [{
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        language: 'en-US',
        type: 'event',
        name: 'start',
        parameters: {
          confidence: 1.0,
          recognitionOutput: {
            type: 'Event',
            channel_index: [0],
            duration: 0,
            start: 0,
            is_final: true,
            speech_final: true,
            channel: {
              alternatives: [],
            },
            from_finalize: false,
          },
          participant: 'system',
          participantUriUser: 'system',
          // Start event specific parameters (matching Go format)
          callee: '+1111',
          calleeHost: 'sip.twilio.com',
          caller: 'SRC',
          callerHost: 'sip.twilio.com',
          participants: [
            { participant: 'participant', uriUser: 'inbound', uriHost: 'twilio.com' },
            { participant: 'participant-2', uriUser: 'outbound', uriHost: 'twilio.com' },
          ],
          vaigConversationId: session.conversationId,
          CallSid: session.conversationId,
          'X-Twilio-CallSid': session.conversationId,
        },
      }],
    };

    this.sendTCCPMessage(sessionId, 'activity', startActivity);
    this.logger.info({ sessionId, conversationId: session.conversationId, turnId }, 'TCCP session initialized (AudioCodes format)');
  }

  /**
   * Connect to TCCP WebSocket endpoint
   */
  private async connectToTCCP(sessionId: string, session: SessionRecord): Promise<WebSocket> {
    // Use AudioCodes env vars if available, fallback to legacy TCCP vars
    const botUrl = this.config.audioCodesBotUrl || this.config.tccpEndpoint!;
    const apiKey = this.config.audioCodesApiKey || this.config.tccpApiKey!;

    // Build connection URL with query params (similar to Go approach)
    const wsUrl = new URL(botUrl);
    wsUrl.searchParams.set('apiKey', apiKey);
    wsUrl.searchParams.set('conversation', session.conversationId);
    wsUrl.searchParams.set('sessionId', sessionId);

    const ws = new WebSocket(wsUrl.toString(), {
      headers: {
        'X-API-Key': apiKey,
        'X-Conversation-Id': session.conversationId,
        'X-Session-Id': sessionId,
      },
      timeout: 10000,
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('TCCP connection timeout'));
      }, 10000);

      ws.on('open', () => {
        clearTimeout(timeout);
        this.logger.debug({ sessionId }, 'TCCP WebSocket connected');
        resolve(ws);
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString()) as TCCPMessage;
          this.handleTCCPMessage(sessionId, message);
        } catch {
          // Ignore non-JSON messages
        }
      });

      ws.on('close', (code, reason) => {
        const sessionData = this.sessions.get(sessionId);
        if (sessionData) {
          sessionData.connected = false;
        }
        this.logger.warn({ sessionId, code, reason: reason.toString() }, 'TCCP connection closed');
      });
    });
  }

  private sendTCCPMessage(sessionId: string, type: TCCPMessage['type'], payload: unknown): void {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData || !sessionData.connected) {
      this.logger.warn({ sessionId }, 'Cannot send message - TCCP not connected');
      return;
    }

    const message: TCCPMessage = {
      type,
      sessionId,
      timestamp: new Date().toISOString(),
      payload: payload as AudioCodesMessage,
    };

    sessionData.ws.send(JSON.stringify(message));
  }

  private handleTCCPMessage(sessionId: string, message: TCCPMessage): void {
    switch (message.type) {
      case 'ack':
        this.logger.debug({ sessionId, ack: message.payload }, 'TCCP acknowledged');
        break;
      case 'error':
        this.logger.error({ sessionId, error: message.payload }, 'TCCP error');
        break;
      default:
        this.logger.debug({ sessionId, type: message.type }, 'TCCP message received');
    }
  }

  /**
   * Send transcript to TCCP using AudioCodes format
   * Called when Deepgram produces a transcript
   */
  async sendTranscript(sessionId: string, transcript: TranscriptionResult, leg: 'inbound' | 'outbound' = 'inbound'): Promise<void> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData || !sessionData.connected) {
      this.logger.warn({ sessionId }, 'Cannot send transcript - TCCP not connected');
      return;
    }

    sessionData.transcripts.push(transcript);

    // Determine participant based on leg (matching Go implementation)
    const participant = leg === 'outbound' ? 'participant-2' : 'participant';
    const participantUriUser = leg === 'outbound' ? 'outbound' : 'inbound';
    const channelIndex = leg === 'outbound' ? [1] : [0];
    const speaker = leg === 'outbound' ? 1 : 0;

    // Convert words to AudioCodes format
    const words: AudioCodesWord[] = (transcript.words || []).map((w, idx) => ({
      word: w.word,
      start: w.start,
      end: w.end,
      confidence: w.confidence,
      punctuated_word: w.word, // Deepgram doesn't provide punctuated separately
      speaker,
    }));

    // Get duration from words or default
    const duration = words.length > 0 
      ? words[words.length - 1].end - words[0].start 
      : 0;
    const start = words.length > 0 ? words[0].start : 0;

    // Build AudioCodes activity message (matches Go: sendToAudioCodes)
    const activity: AudioCodesMessage = {
      conversation: sessionData.conversationId,
      activities: [{
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        language: transcript.language || 'en-US',
        type: 'message',
        text: transcript.transcript,
        parameters: {
          confidence: transcript.confidence,
          recognitionOutput: {
            type: 'Results',
            channel_index: channelIndex,
            duration,
            start,
            is_final: transcript.isFinal,
            speech_final: transcript.isFinal,
            channel: {
              alternatives: [{
                transcript: transcript.transcript,
                confidence: transcript.confidence,
                words,
              }],
            },
            metadata: transcript.metadata?.['deepgramRequestId'] ? {
              request_id: transcript.metadata['deepgramRequestId'] as string,
            } : undefined,
            from_finalize: false,
            provider: {
              name: uuidv4(), // Unique provider instance ID
              type: 'deepgram',
            },
          },
          participant,
          participantUriUser,
          turnId: sessionData.turnId,
        },
      }],
    };

    this.sendTCCPMessage(sessionId, 'activity', activity);

    if (transcript.isFinal) {
      this.logger.info({ 
        sessionId, 
        transcript: transcript.transcript,
        confidence: transcript.confidence,
        leg,
      }, 'Sent final transcript to TCCP (AudioCodes format)');
    }
  }

  /**
   * Signal session pause to TCCP
   * Sends a pause event activity
   */
  async pauseSession(sessionId: string): Promise<void> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData || !sessionData.connected) return;

    const pauseActivity: AudioCodesMessage = {
      conversation: sessionData.conversationId,
      activities: [{
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        language: 'en-US',
        type: 'event',
        name: 'pause',
        parameters: {
          confidence: 1.0,
          recognitionOutput: {
            type: 'Event',
            channel_index: [0],
            duration: 0,
            start: 0,
            is_final: true,
            speech_final: true,
            channel: { alternatives: [] },
            from_finalize: false,
          },
          participant: 'system',
          participantUriUser: 'system',
        },
      }],
    };

    this.sendTCCPMessage(sessionId, 'activity', pauseActivity);
    this.logger.info({ sessionId }, 'TCCP session pause event sent');
  }

  /**
   * Signal session resume to TCCP
   * Sends a resume event activity
   */
  async resumeSession(sessionId: string): Promise<void> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData || !sessionData.connected) return;

    const resumeActivity: AudioCodesMessage = {
      conversation: sessionData.conversationId,
      activities: [{
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        language: 'en-US',
        type: 'event',
        name: 'resume',
        parameters: {
          confidence: 1.0,
          recognitionOutput: {
            type: 'Event',
            channel_index: [0],
            duration: 0,
            start: 0,
            is_final: true,
            speech_final: true,
            channel: { alternatives: [] },
            from_finalize: false,
          },
          participant: 'system',
          participantUriUser: 'system',
        },
      }],
    };

    this.sendTCCPMessage(sessionId, 'activity', resumeActivity);
    this.logger.info({ sessionId }, 'TCCP session resume event sent');
  }

  /**
   * NO-OP: TCCP does not receive audio
   * Audio goes to Deepgram only
   */
  async sendAudioChunk(_sessionId: string, _chunk: AudioChunk): Promise<void> {
    // TCCP adapter does NOT receive audio
    // Audio is handled by Deepgram adapter
    // TCCP only receives transcripts via sendTranscript()
  }

  /**
   * Close TCCP session
   * Called when AudioHook session closes
   * Sends AudioCodes disconnect message (matches Go: sendAudioCodesDisconnect)
   */
  async stopTranscription(sessionId: string): Promise<TranscriptionResult[]> {
    const sessionData = this.sessions.get(sessionId);
    
    if (sessionData) {
      // Send AudioCodes disconnect (matches Go implementation)
      const disconnectMessage: TCCPMessage = {
        type: 'disconnect',
        sessionId,
        timestamp: new Date().toISOString(),
        payload: {
          reason: 'Client Disconnected',
          reasonCode: 'client-disconnected',
        },
      };

      try {
        sessionData.ws.send(JSON.stringify(disconnectMessage));
        sessionData.ws.close(1000, 'Session ended');
      } catch {
        // Ignore errors during cleanup
      }

      this.sessions.delete(sessionId);
      
      this.logger.info({ 
        sessionId, 
        conversationId: sessionData.conversationId,
        transcriptCount: sessionData.transcripts.length,
      }, 'TCCP session closed (AudioCodes disconnect sent)');

      return sessionData.transcripts;
    }

    return [];
  }

  async shutdown(): Promise<void> {
    this.logger.info('TCCP adapter shutdown');
    
    for (const [sessionId, sessionData] of this.sessions) {
      try {
        // Send disconnect for each active session
        const disconnectMessage: TCCPMessage = {
          type: 'disconnect',
          sessionId,
          timestamp: new Date().toISOString(),
          payload: {
            reason: 'Service shutdown',
            reasonCode: 'service-shutdown',
          },
        };
        sessionData.ws.send(JSON.stringify(disconnectMessage));
        sessionData.ws.close(1000, 'Service shutdown');
      } catch {
        // Ignore errors during shutdown
      }
    }
    
    this.sessions.clear();
  }

  /**
   * Send event webhook for call status events (initiated, in-progress, completed)
   * Matches Go implementation: sendEventWebhook
   */
  private async sendEventWebhook(
    conversationId: string, 
    callStatus: 'initiated' | 'in-progress' | 'completed', 
    leg: string,
    startTime?: Date
  ): Promise<void> {
    if (!this.config.eventWebhookUrl) {
      return; // Event webhook not configured
    }

    // Calculate duration for completed events
    let duration = '';
    let callDuration = '';
    if (callStatus === 'completed' && startTime) {
      const elapsed = Math.floor((Date.now() - startTime.getTime()) / 1000);
      duration = elapsed.toString();
      callDuration = duration;
    }

    // Map leg to direction
    const direction = leg === 'outbound' ? 'outbound-dial' : 'inbound';

    // Build form data matching Twilio format (same as Go code)
    const formData = new URLSearchParams();
    formData.set('ApiVersion', '2010-04-01');
    formData.set('CallSid', conversationId);
    formData.set('ParentCallSid', conversationId);
    formData.set('CallStatus', callStatus);
    formData.set('Direction', direction);
    formData.set('Timestamp', new Date().toUTCString());
    formData.set('SequenceNumber', '0');
    formData.set('Leg', leg);
    formData.set('AccountSid', 'STT-SERVER');
    formData.set('CallbackSource', 'call-progress-events');
    formData.set('From', leg);
    formData.set('Caller', leg);
    formData.set('To', 'diarmuid.wrenne');
    formData.set('Called', 'diarmuid.wrenne');

    if (callStatus === 'completed') {
      formData.set('Duration', duration);
      formData.set('CallDuration', callDuration);
    }

    this.logger.info({ 
      callStatus, 
      leg, 
      url: this.config.eventWebhookUrl 
    }, 'Sending event webhook');

    try {
      const url = new URL(this.config.eventWebhookUrl);
      const body = formData.toString();
      
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Content-Length': Buffer.byteLength(body),
          ...(this.config.audioCodesApiKey && {
            'x-auth-token': this.config.audioCodesApiKey,
            'Authorization': `Bearer ${this.config.audioCodesApiKey}`,
            'Api-Key': this.config.audioCodesApiKey,
          }),
        },
      };

      await new Promise<void>((resolve, reject) => {
        const req = https.request(options, (res) => {
          let responseData = '';
          res.on('data', (chunk) => {
            responseData += chunk;
          });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              this.logger.info({ callStatus, leg }, 'Event webhook sent successfully');
              resolve();
            } else {
              this.logger.warn({ status: res.statusCode, body: responseData }, 'Event webhook returned non-OK status');
              resolve(); // Resolve anyway, don't block
            }
          });
        });

        req.on('error', (err) => {
          this.logger.error({ error: err.message }, 'Failed to send event webhook');
          reject(err);
        });

        req.write(body);
        req.end();
      });
    } catch (err) {
      this.logger.error({ error: (err as Error).message }, 'Failed to send event webhook');
    }
  }
}
