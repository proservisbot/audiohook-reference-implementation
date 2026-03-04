import WebSocket from 'ws';
import { DownstreamService, TranscriptionResult, DownstreamConfig, AudioChunk } from './downstream';
import { SessionRecord } from './session';
import { FastifyBaseLogger } from 'fastify';

interface TCCPMessage {
  type: 'session_init' | 'session_close' | 'session_pause' | 'session_resume' | 'transcript' | 'error' | 'ack';
  sessionId: string;
  timestamp: string;
  payload?: unknown;
}

interface TCCPTranscriptPayload {
  transcript: string;
  confidence: number;
  isFinal: boolean;
  words?: Array<{
    word: string;
    start: number;
    end: number;
    confidence: number;
  }>;
  channel?: 'external' | 'internal';
  metadata?: {
    duration: number;
    deepgramRequestId?: string;
  };
}

interface TCCPSessionPayload {
  conversationId: string;
  correlationId: string;
  organizationId?: string;
  participant?: {
    id: string;
    ani?: string;
    aniName?: string;
    dnis?: string;
  };
  media?: {
    format: string;
    rate: number;
    channels: number;
  };
}

/**
 * TCCP Adapter - Receives Deepgram transcripts and AudioHook events
 * 
 * This adapter connects to external TCCP service via WebSocket.
 * Unlike Deepgram adapter, it does NOT receive raw audio.
 * Instead, it receives:
 * - Transcription results from Deepgram
 * - Session lifecycle events from AudioHook
 * 
 * This allows TCCP to work with existing transcription infrastructure
 * while maintaining its own workflow signaling.
 */
export class TCCPAdapter implements DownstreamService {
  readonly name = 'TCCP';
  private config: DownstreamConfig;
  private logger: FastifyBaseLogger;
  
  // Session management - tracks TCCP WebSocket connections
  private sessions = new Map<string, {
    ws: WebSocket;
    sessionId: string;
    connected: boolean;
    transcripts: TranscriptionResult[];
  }>();

  constructor(config: DownstreamConfig, logger: FastifyBaseLogger) {
    this.config = config;
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    if (!this.config.tccpEndpoint) {
      throw new Error('TCCP_ENDPOINT is required');
    }
    if (!this.config.tccpApiKey) {
      throw new Error('TCCP_API_KEY is required');
    }
    
    this.logger.info({ 
      endpoint: this.config.tccpEndpoint,
    }, 'TCCP adapter initialized (event-based, no audio)');
  }

  /**
   * Start TCCP session - connects to TCCP service and signals session start
   * Called when AudioHook session opens
   */
  async startTranscription(sessionId: string, session: SessionRecord): Promise<void> {
    const ws = await this.connectToTCCP(sessionId, session);
    
    this.sessions.set(sessionId, {
      ws,
      sessionId,
      connected: true,
      transcripts: [],
    });

    // Send session_init to trigger TCCP workflow
    const initMessage: TCCPMessage = {
      type: 'session_init',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        conversationId: session.conversationId,
        correlationId: session.correlationId,
        organizationId: session.metadata?.['organizationId'],
        participant: session.metadata?.['participant'],
        startedAt: session.startedAt,
      } as TCCPSessionPayload,
    };

    ws.send(JSON.stringify(initMessage));
    this.logger.info({ sessionId, conversationId: session.conversationId }, 'TCCP session initialized');
  }

  /**
   * Connect to TCCP WebSocket endpoint
   */
  private async connectToTCCP(sessionId: string, session: SessionRecord): Promise<WebSocket> {
    const tccpEndpoint = this.config.tccpEndpoint!;
    const tccpApiKey = this.config.tccpApiKey!;

    // Build connection URL
    const wsUrl = new URL(tccpEndpoint);
    wsUrl.searchParams.set('apiKey', tccpApiKey);
    wsUrl.searchParams.set('sessionId', sessionId);

    const ws = new WebSocket(wsUrl.toString(), {
      headers: {
        'X-API-Key': tccpApiKey,
        'X-Session-Id': sessionId,
        'X-Conversation-Id': session.conversationId,
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

  private handleTCCPMessage(sessionId: string, message: TCCPMessage): void {
    switch (message.type) {
      case 'ack':
        this.logger.debug({ sessionId, ack: message.payload }, 'TCCP acknowledged');
        break;
      case 'error':
        this.logger.error({ sessionId, error: message.payload }, 'TCCP error');
        break;
      default:
        this.logger.debug({ sessionId, type: message.type }, 'TCCP message');
    }
  }

  /**
   * Send transcript to TCCP
   * Called when Deepgram produces a transcript
   */
  async sendTranscript(sessionId: string, transcript: TranscriptionResult): Promise<void> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData || !sessionData.connected) {
      this.logger.warn({ sessionId }, 'Cannot send transcript - TCCP not connected');
      return;
    }

    sessionData.transcripts.push(transcript);

    const message: TCCPMessage = {
      type: 'transcript',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        transcript: transcript.transcript,
        confidence: transcript.confidence,
        isFinal: transcript.isFinal,
        words: transcript.words,
        metadata: transcript.metadata,
      } as TCCPTranscriptPayload,
    };

    sessionData.ws.send(JSON.stringify(message));

    if (transcript.isFinal) {
      this.logger.info({ 
        sessionId, 
        transcript: transcript.transcript,
        confidence: transcript.confidence,
      }, 'Sent final transcript to TCCP');
    }
  }

  /**
   * Signal session pause to TCCP
   */
  async pauseSession(sessionId: string): Promise<void> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData || !sessionData.connected) return;

    const message: TCCPMessage = {
      type: 'session_pause',
      sessionId,
      timestamp: new Date().toISOString(),
    };

    sessionData.ws.send(JSON.stringify(message));
    this.logger.info({ sessionId }, 'TCCP session paused');
  }

  /**
   * Signal session resume to TCCP
   */
  async resumeSession(sessionId: string): Promise<void> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData || !sessionData.connected) return;

    const message: TCCPMessage = {
      type: 'session_resume',
      sessionId,
      timestamp: new Date().toISOString(),
    };

    sessionData.ws.send(JSON.stringify(message));
    this.logger.info({ sessionId }, 'TCCP session resumed');
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
   */
  async stopTranscription(sessionId: string): Promise<TranscriptionResult[]> {
    const sessionData = this.sessions.get(sessionId);
    
    if (sessionData) {
      // Send session_close
      const message: TCCPMessage = {
        type: 'session_close',
        sessionId,
        timestamp: new Date().toISOString(),
        payload: {
          transcriptCount: sessionData.transcripts.length,
        },
      };

      try {
        sessionData.ws.send(JSON.stringify(message));
        sessionData.ws.close(1000, 'Session ended');
      } catch {
        // Ignore errors during cleanup
      }

      this.sessions.delete(sessionId);
      
      this.logger.info({ 
        sessionId, 
        transcriptCount: sessionData.transcripts.length,
      }, 'TCCP session closed');

      return sessionData.transcripts;
    }

    return [];
  }

  async shutdown(): Promise<void> {
    this.logger.info('TCCP adapter shutdown');
    
    for (const [sessionId, sessionData] of this.sessions) {
      try {
        sessionData.ws.close(1000, 'Service shutdown');
      } catch {
        // Ignore errors during shutdown
      }
    }
    
    this.sessions.clear();
  }
}
