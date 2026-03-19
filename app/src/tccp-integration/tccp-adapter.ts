import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
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
  // Source identifier for filtering
  source?: string;
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
  // Participant event parameters (for AudioHook participant info)
  participantId?: string;
  participantAni?: string;
  participantAniName?: string;
  participantDnis?: string;
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
    logFile: string;
    // URLs returned from bot initialization
    activitiesUrl?: string;
    disconnectUrl?: string;
    refreshUrl?: string;
    baseUrl?: string;
  }>();

  // Log directory for per-call logs
  private logDir: string;

  constructor(config: DownstreamConfig, logger: FastifyBaseLogger) {
    this.config = config;
    this.logger = logger;
    this.logDir = path.join(process.cwd(), 'logs', 'tccp-calls');
  }

  async initialize(): Promise<void> {
    const botUrl = this.config.audioCodesBotUrl || this.config.tccpEndpoint;
    const apiKey = this.config.audioCodesApiKey || this.config.tccpApiKey;
    
    // Create log directory if it doesn't exist
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
      this.logger.info({ logDir: this.logDir }, 'Created TCCP call log directory');
    }
    
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
   * Write a line to the per-call log file
   */
  private writeCallLog(logFile: string, message: string): void {
    try {
      const timestamp = new Date().toISOString();
      fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Failed to write to call log');
    }
  }

  /**
   * Log an HTTP request/response to the per-call log file
   */
  private logHttpRequest(
    sessionId: string,
    method: string,
    url: string,
    requestBody: string,
    responseStatus?: number,
    responseBody?: string
  ): void {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData?.logFile) return;

    this.writeCallLog(sessionData.logFile, `\n--- HTTP ${method} ---`);
    this.writeCallLog(sessionData.logFile, `URL: ${url}`);
    this.writeCallLog(sessionData.logFile, `Request Body:`);
    
    // Pretty print JSON if possible
    try {
      const parsed = JSON.parse(requestBody);
      this.writeCallLog(sessionData.logFile, JSON.stringify(parsed, null, 2));
    } catch {
      this.writeCallLog(sessionData.logFile, requestBody);
    }
    
    if (responseStatus !== undefined) {
      this.writeCallLog(sessionData.logFile, `Response Status: ${responseStatus}`);
      if (responseBody) {
        this.writeCallLog(sessionData.logFile, `Response Body: ${responseBody}`);
      }
    }
    this.writeCallLog(sessionData.logFile, `--- END ---\n`);
  }

  /**
   * Initialize AudioCodes bot and get conversation URLs
   * Returns { activitiesUrl, disconnectUrl, refreshUrl, baseUrl }
   */
  private async initializeBot(
    conversationId: string,
    sessionId: string
  ): Promise<{ activitiesUrl: string; disconnectUrl: string; refreshUrl: string; baseUrl: string } | null> {
    const botUrl = this.config.audioCodesBotUrl || this.config.tccpEndpoint;
    const apiKey = this.config.audioCodesApiKey || this.config.tccpApiKey;
    
    if (!botUrl || !apiKey) {
      throw new Error('TCCP not configured');
    }

    // Extract base URL from bot URL
    const url = new URL(botUrl);
    const baseUrl = `${url.protocol}//${url.host}`;

    // Create init request (matching Go implementation)
    const initRequest = {
      conversation: conversationId,
      bot: uuidv4(),
      capabilities: ['websocket'],
    };

    const body = JSON.stringify(initRequest);
    url.searchParams.set('apiKey', apiKey);
    const urlString = url.toString();

    this.logger.info({ 
      url: urlString,
      conversationId,
    }, '📤 Initializing AudioCodes bot');

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
          ...(apiKey && {
            'Authorization': `Bearer ${apiKey}`,
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
          // Log to per-call file
          this.logHttpRequest(sessionId, 'POST (bot init)', urlString, body, res.statusCode, responseData);
          
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const response = JSON.parse(responseData);
              const urls = {
                activitiesUrl: baseUrl + response.activitiesURL,
                disconnectUrl: baseUrl + response.disconnectURL,
                refreshUrl: baseUrl + (response.refreshURL || ''),
                baseUrl,
              };
              
              this.logger.info({ 
                activitiesUrl: urls.activitiesUrl,
                disconnectUrl: urls.disconnectUrl,
              }, '✅ Bot initialized, got conversation URLs');
              
              resolve(urls);
            } catch (err) {
              this.logger.warn({ error: (err as Error).message, body: responseData }, 'Failed to parse bot init response');
              resolve(null);
            }
          } else {
            this.logger.warn({ status: res.statusCode, body: responseData }, 'Bot init returned non-OK status');
            resolve(null);
          }
        });
      });

      req.on('error', (err) => {
        this.logHttpRequest(sessionId, 'POST (bot init)', urlString, body, 0, `ERROR: ${err.message}`);
        this.logger.error({ error: err.message }, 'Failed to initialize bot');
        resolve(null); // Don't reject, just return null
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Send HTTP POST request to AudioCodes activities endpoint
   */
  private async sendPostRequest(
    message: AudioCodesMessage,
    sessionId?: string
  ): Promise<void> {
    const sessionData = sessionId ? this.sessions.get(sessionId) : undefined;
    
    // Use activitiesUrl if available (from bot init), otherwise fall back to bot URL
    let targetUrl: string;
    if (sessionData?.activitiesUrl) {
      targetUrl = sessionData.activitiesUrl;
    } else {
      const botUrl = this.config.audioCodesBotUrl || this.config.tccpEndpoint;
      if (!botUrl) {
        throw new Error('TCCP not configured');
      }
      targetUrl = botUrl;
    }
    
    const apiKey = this.config.audioCodesApiKey || this.config.tccpApiKey;
    if (!apiKey) {
      throw new Error('TCCP not configured');
    }

    const url = new URL(targetUrl);
    url.searchParams.set('apiKey', apiKey);
    url.searchParams.set('conversation', message.conversation);

    const body = JSON.stringify(message);
    const urlString = url.toString();

    this.logger.info({ 
      endpoint: urlString,
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
          // Log to per-call file
          if (sessionId) {
            this.logHttpRequest(sessionId, 'POST', urlString, body, res.statusCode, responseData);
          }
          
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
        // Log error to per-call file
        if (sessionId) {
          this.logHttpRequest(sessionId, 'POST', urlString, body, 0, `ERROR: ${err.message}`);
        }
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
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(this.logDir, `call-${session.conversationId}-${timestamp}.log`);
    
    // Create log file with header
    this.writeCallLog(logFile, `=== TCCP Call Log ===`);
    this.writeCallLog(logFile, `Session ID: ${sessionId}`);
    this.writeCallLog(logFile, `Conversation ID: ${session.conversationId}`);
    this.writeCallLog(logFile, `Started: ${new Date().toISOString()}`);
    this.writeCallLog(logFile, `Bot URL: ${this.config.audioCodesBotUrl || this.config.tccpEndpoint}`);
    this.writeCallLog(logFile, `Event Webhook URL: ${this.config.eventWebhookUrl || 'N/A'}`);
    this.writeCallLog(logFile, `${'='.repeat(50)}\n`);
    
    // Create session first (needed for logging in initializeBot)
    this.sessions.set(sessionId, {
      sessionId,
      conversationId: session.conversationId,
      turnId,
      transcripts: [],
      startTime: new Date(),
      logFile,
    });

    // STEP 1: Initialize bot and get conversation URLs (matching Go implementation)
    const urls = await this.initializeBot(session.conversationId, sessionId);
    
    // Update session with URLs if we got them
    if (urls) {
      const sessionData = this.sessions.get(sessionId);
      if (sessionData) {
        sessionData.activitiesUrl = urls.activitiesUrl;
        sessionData.disconnectUrl = urls.disconnectUrl;
        sessionData.refreshUrl = urls.refreshUrl;
        sessionData.baseUrl = urls.baseUrl;
      }
      this.writeCallLog(logFile, `Activities URL: ${urls.activitiesUrl}`);
      this.writeCallLog(logFile, `Disconnect URL: ${urls.disconnectUrl}`);
      this.writeCallLog(logFile, `${'='.repeat(50)}\n`);
    }

    // STEP 2: Send AudioCodes start activity to activitiesUrl
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
          source: 'televoiceaudiohook',
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

    await this.sendPostRequest(startMessage, sessionId);
    
    this.logger.info({ sessionId, conversationId: session.conversationId, turnId, logFile }, 'TCCP session initialized (AudioCodes HTTP format)');

    // Send event webhooks in correct sequence (matching Go implementation):
    // 1. initiated - call is being set up
    // 2. in-progress - call is now active
    await this.sendEventWebhook(session.conversationId, 'initiated', 'inbound', 0, sessionId);
    await this.sendEventWebhook(session.conversationId, 'in-progress', 'inbound', 0, sessionId);
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
          source: 'televoiceaudiohook',
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

    await this.sendPostRequest(activityMessage, sessionId);

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
          source: 'televoiceaudiohook',
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

    await this.sendPostRequest(pauseMessage, sessionId);
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
          source: 'televoiceaudiohook',
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

    await this.sendPostRequest(resumeMessage, sessionId);
    this.logger.info({ sessionId }, 'TCCP session resume event sent');
  }

  /**
   * Send disconnect to the disconnectUrl (from bot init response)
   */
  private async sendDisconnect(
    disconnectUrl: string,
    conversationId: string,
    sessionId: string
  ): Promise<void> {
    const apiKey = this.config.audioCodesApiKey || this.config.tccpApiKey;
    if (!apiKey) return;

    const url = new URL(disconnectUrl);
    url.searchParams.set('apiKey', apiKey);
    url.searchParams.set('conversation', conversationId);

    const body = JSON.stringify({ conversation: conversationId });
    const urlString = url.toString();

    this.logger.info({ url: urlString, conversationId }, '📤 Sending disconnect to disconnectUrl');

    return new Promise((resolve) => {
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
          'Authorization': `Bearer ${apiKey}`,
        },
      };

      const requestModule = isHttps ? https : http;
      
      const req = requestModule.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        res.on('end', () => {
          this.logHttpRequest(sessionId, 'POST (disconnect)', urlString, body, res.statusCode, responseData);
          
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            this.logger.info({ status: res.statusCode }, '✅ Disconnect sent successfully');
          } else {
            this.logger.warn({ status: res.statusCode, body: responseData }, 'Disconnect returned non-OK status');
          }
          resolve();
        });
      });

      req.on('error', (err) => {
        this.logHttpRequest(sessionId, 'POST (disconnect)', urlString, body, 0, `ERROR: ${err.message}`);
        this.logger.error({ error: err.message }, 'Failed to send disconnect');
        resolve(); // Don't reject, just resolve
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * NO-OP: TCCP does not receive audio
   */
  async sendAudioChunk(_sessionId: string, _chunk: AudioChunk): Promise<void> {
    // TCCP adapter does NOT receive audio
  }

  /**
   * Send participant info as an AudioCodes activity event
   * Called when AudioHook session opens with participant details
   */
  async sendParticipantEvent(
    sessionId: string, 
    participant: { id: string; ani: string; aniName: string; dnis: string },
    leg: 'inbound' | 'outbound' = 'inbound'
  ): Promise<void> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) {
      this.logger.warn({ sessionId }, 'Cannot send participant event - session not found');
      return;
    }

    const participantMessage: AudioCodesMessage = {
      conversation: sessionData.conversationId,
      activities: [{
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        language: 'en-US',
        type: 'event',
        name: 'participantJoined',
        parameters: {
          confidence: 1.0,
          recognitionOutput: {
            type: 'Event',
            channel_index: leg === 'outbound' ? [1] : [0],
            duration: 0,
            start: 0,
            is_final: true,
            speech_final: true,
            channel: { alternatives: [] },
            from_finalize: false,
          },
          participant: leg === 'outbound' ? 'participant-2' : 'participant',
          participantUriUser: leg === 'outbound' ? 'outbound' : 'inbound',
          source: 'televoiceaudiohook',
          // Include AudioHook participant details
          participantId: participant.id,
          participantAni: participant.ani,
          participantAniName: participant.aniName,
          participantDnis: participant.dnis,
          turnId: sessionData.turnId,
        },
      }],
    };

    await this.sendPostRequest(participantMessage, sessionId);
    
    this.logger.info({ 
      sessionId, 
      participantId: participant.id,
      ani: participant.ani,
      leg,
    }, '📤 Sent participant event to AudioCodes');
  }

  /**
   * Close TCCP session
   */
  async stopTranscription(sessionId: string): Promise<TranscriptionResult[]> {
    const sessionData = this.sessions.get(sessionId);
    
    if (sessionData) {
      // Send disconnect to disconnectUrl if available (from bot init)
      if (sessionData.disconnectUrl) {
        await this.sendDisconnect(sessionData.disconnectUrl, sessionData.conversationId, sessionId);
      } else {
        // Fallback: Send disconnect event as activity
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
              source: 'televoiceaudiohook',
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
          await this.sendPostRequest(disconnectMessage, sessionId);
        } catch {
          // Ignore errors during cleanup
        }
      }

      // Send completed event webhook
      const duration = Math.floor((Date.now() - sessionData.startTime.getTime()) / 1000);
      await this.sendEventWebhook(sessionData.conversationId, 'completed', 'inbound', duration, sessionId);

      // Write final log entry
      this.writeCallLog(sessionData.logFile, `\n${'='.repeat(50)}`);
      this.writeCallLog(sessionData.logFile, `Call ended: ${new Date().toISOString()}`);
      this.writeCallLog(sessionData.logFile, `Duration: ${duration} seconds`);
      this.writeCallLog(sessionData.logFile, `Transcripts: ${sessionData.transcripts.length}`);
      this.writeCallLog(sessionData.logFile, `${'='.repeat(50)}`);

      this.sessions.delete(sessionId);
      
      this.logger.info({ 
        sessionId, 
        conversationId: sessionData.conversationId,
        transcriptCount: sessionData.transcripts.length,
        logFile: sessionData.logFile,
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
              source: 'televoiceaudiohook',
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
        await this.sendPostRequest(disconnectMessage, sessionData.sessionId);
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
    duration: number = 0,
    sessionId?: string
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
      const urlString = url.toString();
      
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
            // Log to per-call file
            if (sessionId) {
              this.logHttpRequest(sessionId, 'POST (webhook)', urlString, body, res.statusCode, responseData);
            }
            
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
          // Log error to per-call file
          if (sessionId) {
            this.logHttpRequest(sessionId, 'POST (webhook)', urlString, body, 0, `ERROR: ${err.message}`);
          }
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
