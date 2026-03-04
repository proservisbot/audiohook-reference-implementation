import https from 'https';
import http from 'http';
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

interface TCCPMessage {
  type: 'activity' | 'disconnect' | 'error' | 'ack';
  sessionId: string;
  timestamp: string;
  payload: AudioCodesMessage | { reason?: string; reasonCode?: string };
}

/**
 * TCCP Adapter - AudioCodes Bot API Compatible (HTTP POST)
 * 
 * This adapter sends events to the AudioCodes Bot API via HTTP POST requests.
 * Unlike the previous WebSocket implementation, this uses HTTP for compatibility
 * with standard AudioCodes deployments.
 * 
 * It does NOT receive raw audio - only transcripts and events from AudioHook.
 */
export class TCCPAdapter implements DownstreamService {
  readonly name = 'TCCP';
  private config: DownstreamConfig;
  private logger: FastifyBaseLogger;
  
  // Session tracking
  private sessions = new Map<string, {
    sessionId: string;
    conversationId: string;
    turnId: string;
    transcripts: TranscriptionResult[];
    startTime: Date;
  }>();

  constructor(config: DownstreamConfig, logger: FastifyBaseLogger) {
    this.config = config;
    this.logger = logger;
  }

  async initialize(): Promise<void> {
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
    }, 'TCCP adapter initialized (AudioCodes HTTP format, no audio)');
  }

  /**
   * Send HTTP POST request to AudioCodes endpoint
   */
  private async sendPostRequest(
    message: AudioCodesMessage
  ): Promise<void> {
    const botUrl = this.config.audioCodesBotUrl || this.config.tccpEndpoint;
    const apiKey = this.config.audioCodesApiKey || this.config.tccpApiKey;
    
    if (!botUrl || !apiKey) {
      throw new Error('TCCP not configured');
    }

    const url = new URL(botUrl);
    url.searchParams.set('apiKey', apiKey);
    url.searchParams.set('conversation', message.conversation);

    const body = JSON.stringify(message);

    this.logger.info({ 
      endpoint: url.toString(),
      conversationId: message.conversation,
      json: body,
    }, '📤 Sending AudioCodes POST request');

    return new Promise((resolve, reject) => {
      const isHttps = url.protocol === 'https:';
      const port = url.port || (isHttps ? 443 : 80);
      
      const options = {
        hostname: url.hostname,
        port: port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-API-Key': apiKey,
          ...(this.config.audioCodesApiKey && {
            'Authorization': `Bearer ${this.config.audioCodesApiKey}`,
          }),
        },
      };

      const requestModule = isHttps ? https : http;
      
      const req = requestModule.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            this.logger.info({ status: res.statusCode }, '✅ TCCP POST successful');
            resolve();
          } else {
            this.logger.warn({ status: res.statusCode, body: responseData }, 'TCCP POST returned non-OK status');
            resolve(); // Resolve anyway, don't block
          }
        });
      });

      req.on('error', (err) => {
        this.logger.error({ error: err.message }, 'Failed to send TCCP POST request');
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Start TCCP session - sends AudioCodes start activity via HTTP POST
   * Called when AudioHook session opens
   */
  async startTranscription(sessionId: string, session: SessionRecord): Promise<void> {
    const turnId = uuidv4();
    
    this.sessions.set(sessionId, {
      sessionId,
      conversationId: session.conversationId,
      turnId,
      transcripts: [],
      startTime: new Date(),
    });

    // Send AudioCodes start activity (direct format matching Go implementation)
    const startMessage: AudioCodesMessage = {
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
            channel: { alternatives: [] },
            from_finalize: false,
          },
          participant: 'system',
          participantUriUser: 'system',
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

    await this.sendPostRequest(startMessage);
    
    this.logger.info({ sessionId, conversationId: session.conversationId, turnId }, 'TCCP session initialized (AudioCodes HTTP format)');

    // Send event webhooks in correct sequence (matching Go implementation):
    // 1. initiated - call is being set up
    // 2. in-progress - call is now active
    await this.sendEventWebhook(session.conversationId, 'initiated', 'inbound');
    await this.sendEventWebhook(session.conversationId, 'in-progress', 'inbound');
  }

  /**
   * Send transcript to TCCP using AudioCodes format via HTTP POST
   */
  async sendTranscript(sessionId: string, transcript: TranscriptionResult, leg: 'inbound' | 'outbound' = 'inbound'): Promise<void> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) {
      this.logger.warn({ sessionId }, 'Cannot send transcript - session not found');
      return;
    }

    sessionData.transcripts.push(transcript);

    const participant = leg === 'outbound' ? 'participant-2' : 'participant';
    const participantUriUser = leg === 'outbound' ? 'outbound' : 'inbound';
    const channelIndex = leg === 'outbound' ? [1] : [0];
    const speaker = leg === 'outbound' ? 1 : 0;

    const words: AudioCodesWord[] = (transcript.words || []).map((w) => ({
      word: w.word,
      start: w.start,
      end: w.end,
      confidence: w.confidence,
      punctuated_word: w.word,
      speaker,
    }));

    const duration = words.length > 0 
      ? words[words.length - 1].end - words[0].start 
      : 0;
    const start = words.length > 0 ? words[0].start : 0;

    // Direct AudioCodes format matching Go implementation
    const activityMessage: AudioCodesMessage = {
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
              name: uuidv4(),
              type: 'deepgram',
            },
          },
          participant,
          participantUriUser,
          turnId: sessionData.turnId,
        },
      }],
    };

    await this.sendPostRequest(activityMessage);

    if (transcript.isFinal) {
      this.logger.info({ 
        sessionId, 
        transcript: transcript.transcript,
        confidence: transcript.confidence,
        leg,
      }, '✅ Sent AudioCodes transcript (HTTP POST)');
    }
  }

  /**
   * Signal session pause to TCCP
   */
  async pauseSession(sessionId: string): Promise<void> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return;

    const pauseMessage: AudioCodesMessage = {
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

    await this.sendPostRequest(pauseMessage);
    this.logger.info({ sessionId }, 'TCCP session pause event sent');
  }

  /**
   * Signal session resume to TCCP
   */
  async resumeSession(sessionId: string): Promise<void> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return;

    const resumeMessage: AudioCodesMessage = {
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

    await this.sendPostRequest(resumeMessage);
    this.logger.info({ sessionId }, 'TCCP session resume event sent');
  }

  /**
   * NO-OP: TCCP does not receive audio
   */
  async sendAudioChunk(_sessionId: string, _chunk: AudioChunk): Promise<void> {
    // TCCP adapter does NOT receive audio
  }

  /**
   * Close TCCP session
   */
  async stopTranscription(sessionId: string): Promise<TranscriptionResult[]> {
    const sessionData = this.sessions.get(sessionId);
    
    if (sessionData) {
      // Send disconnect event (as an activity with event type)
      const disconnectMessage: AudioCodesMessage = {
        conversation: sessionData.conversationId,
        activities: [{
          id: uuidv4(),
          timestamp: new Date().toISOString(),
          language: 'en-US',
          type: 'event',
          name: 'disconnect',
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

      try {
        await this.sendPostRequest(disconnectMessage);
      } catch {
        // Ignore errors during cleanup
      }

      // Send completed event webhook
      const duration = Math.floor((Date.now() - sessionData.startTime.getTime()) / 1000);
      await this.sendEventWebhook(sessionData.conversationId, 'completed', 'inbound', duration);

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
    
    for (const [, sessionData] of this.sessions) {
      try {
        const disconnectMessage: AudioCodesMessage = {
          conversation: sessionData.conversationId,
          activities: [{
            id: uuidv4(),
            timestamp: new Date().toISOString(),
            language: 'en-US',
            type: 'event',
            name: 'disconnect',
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
        await this.sendPostRequest(disconnectMessage);
      } catch {
        // Ignore errors during shutdown
      }
    }
    
    this.sessions.clear();
  }

  /**
   * Send event webhook for call status events
   */
  private async sendEventWebhook(
    conversationId: string, 
    callStatus: 'initiated' | 'in-progress' | 'completed', 
    leg: string,
    duration: number = 0
  ): Promise<void> {
    if (!this.config.eventWebhookUrl) {
      return;
    }

    const direction = leg === 'outbound' ? 'outbound-dial' : 'inbound';

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
    formData.set('To', 'stt-server');
    formData.set('Called', 'stt-server');

    if (callStatus === 'completed') {
      formData.set('Duration', duration.toString());
      formData.set('CallDuration', duration.toString());
    }

    this.logger.info({ callStatus, leg, url: this.config.eventWebhookUrl }, '📤 Sending event webhook');

    try {
      const url = new URL(this.config.eventWebhookUrl);
      const body = formData.toString();
      
      const isHttps = url.protocol === 'https:';
      const port = url.port || (isHttps ? 443 : 80);
      
      const options = {
        hostname: url.hostname,
        port: port,
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
        const requestModule = isHttps ? https : http;
        const req = requestModule.request(options, (res) => {
          let responseData = '';
          res.on('data', (chunk) => {
            responseData += chunk;
          });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              this.logger.info({ callStatus, leg }, '📡 Event webhook sent successfully');
              resolve();
            } else {
              this.logger.warn({ status: res.statusCode, body: responseData }, 'Event webhook returned non-OK status');
              resolve();
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
