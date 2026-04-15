import { FastifyInstance } from 'fastify';
import dotenv from 'dotenv';
import { initiateRequestAuthentication, verifyRequestSignature } from './authenticator';
import { isUuid, httpsignature as httpsig, createServerSession } from '../audiohook';
import { SessionWebsocketStatsTracker } from './session-websocket-stats-tracker';
import { createDownstreamService, DownstreamConfig } from './tccp-integration/factory';
import { SessionRecord } from './tccp-integration/session';

dotenv.config();

const isDev = process.env['NODE_ENV'] !== 'production';

type AuthStrategy = 'request' | 'session';

export const addAudiohookTCCPRoute = (fastify: FastifyInstance, path: string): void => {

  // Load downstream service config
  const downstreamConfig: DownstreamConfig = {
    service: (process.env['TRANSCRIPTION_SERVICE'] as 'tccp' | 'deepgram') || 'deepgram',
    deepgramApiKey: process.env['DEEPGRAM_API_KEY'],
    deepgramModel: process.env['DEEPGRAM_MODEL'] || 'nova-2',
    tccpEndpoint: process.env['TCCP_ENDPOINT'],
    tccpApiKey: process.env['TCCP_API_KEY'],
    sampleRate: 8000,
    channels: 1,
  };

  const downstreamService = createDownstreamService(downstreamConfig, fastify.log);
  downstreamService.initialize().catch((err: Error) => {
    fastify.log.error({ error: err.message }, 'Failed to initialize downstream service');
  });

  fastify.log.info({ service: downstreamConfig.service }, 'TCCP downstream service initialized');

  const authStrategy: AuthStrategy = (process.env['SESSION_AUTH_STRATEGY'] === 'request') ? 'request' : 'session';
  
  fastify.get<{
    Headers: {
      'audiohook-session-id'?: string;
      'audiohook-organization-id'?: string;
      'audiohook-correlation-id'?: string;
      'x-api-key'?: string;
      'signature'?: string;
      'signature-input'?: string;
    }
  }>(path, {
    websocket: true,
    onRequest: async (request, reply): Promise<unknown> => {
      request.authenticated = false;
      if(authStrategy === 'request') {
        const result = await verifyRequestSignature({ request });
        if(result.code !== 'VERIFIED') {
          request.log.info(`Signature verification failure: ${JSON.stringify(result)}`);
          reply.code(401);
          return reply.send('Signature verification failed');
        }
        request.authenticated = true;
      }
      return;
    },
    
  }, (connection, request) => {

    request.log.info(`TCCP WebSocket Request - URI: <${request.url}>, RemoteAddr: ${request.socket.remoteAddress}`);

    const sessionId = httpsig.queryCanonicalizedHeaderField(request.headers, 'audiohook-session-id');
    const correlationId = httpsig.queryCanonicalizedHeaderField(request.headers, 'audiohook-correlation-id');
    const organizationId = httpsig.queryCanonicalizedHeaderField(request.headers, 'audiohook-organization-id') ?? undefined;

    if(!sessionId || !isUuid(sessionId)) {
      throw new RangeError('Missing or invalid "audiohook-session-id" header field');
    }
    if(isDev && (connection.socket.binaryType !== 'nodebuffer')) {
      throw new Error(`WebSocket binary type '${connection.socket.binaryType}' not supported`);
    }

    const logLevel = isDev ? 'debug' : 'info';
    const logger = request.log.child({ session: sessionId, correlationId, organizationId }, { level: logLevel });
    
    const ws = new SessionWebsocketStatsTracker(connection.socket);

    const session = createServerSession({
      ws,
      id: sessionId,
      logger
    });
    
    if(!(request.authenticated ?? false)) {
      initiateRequestAuthentication({ session, request });
    }

    // Track transcription session
    let transcriptionSessionId: string | null = null;
    let audioChunkCount = 0;

    // Start transcription when session opens
    session.addOpenHandler((context) => {
      logger.info({ 
        media: context.selectedMedia,
        language: context.openParams.language 
      }, 'Starting TCCP transcription session');

      transcriptionSessionId = correlationId || sessionId;
      
      const sessionRecord: SessionRecord = {
        sessionId: transcriptionSessionId,
        conversationId: sessionId,
        correlationId: correlationId || sessionId,
        startedAt: new Date(),
        state: 'active',
        events: [],
        audioChunkCount: 0,
        metadata: {
          organizationId,
          language: context.openParams.language,
          openParams: context.openParams,
        },
      };
      
      // Initialize downstream transcription
      downstreamService.startTranscription(transcriptionSessionId, sessionRecord).catch((err: Error) => {
        logger.error({ error: err.message }, 'Failed to start transcription');
      });

      return undefined;
    });

    // Handle incoming audio frames
    session.on('audio', (frame) => {
      if (!transcriptionSessionId) return;

      // Get audio data from frame - audio is in frame.audio.data as Int16Array or Uint8Array
      const audioData = frame.audio.data;
      
      // Convert to Buffer for downstream service
      let buffer: Buffer;
      if (audioData instanceof Int16Array) {
        buffer = Buffer.from(audioData.buffer);
      } else if (audioData instanceof Uint8Array) {
        buffer = Buffer.from(audioData);
      } else {
        logger.warn('Unknown audio data type');
        return;
      }

      audioChunkCount++;

      // Send to downstream transcription
      downstreamService.sendAudioChunk(transcriptionSessionId, {
        streamId: sessionId,
        sequenceNumber: audioChunkCount,
        timestamp: new Date(),
        payload: buffer,
      }).catch((err: Error) => {
        logger.error({ error: err.message }, 'Failed to send audio chunk');
      });
    });

    // Handle session close
    session.addCloseHandler(() => {
      if (!transcriptionSessionId) return Promise.resolve();

      logger.info({ audioChunkCount }, 'Stopping TCCP transcription session');
      
      return downstreamService.stopTranscription(transcriptionSessionId).then((results) => {
        logger.info({ transcriptCount: results.length }, 'Transcription complete');
        
        // Send transcription results back to Genesys as events
        results.forEach((result) => {
          if (result.isFinal && result.transcript) {
            const transcriptEntity = {
              type: 'transcript' as const,
              data: {
                id: transcriptionSessionId!,
                channelId: '0',
                isFinal: true,
                alternatives: [{
                  confidence: result.confidence,
                  interpretations: [{
                    type: 'display' as const,
                    transcript: result.transcript,
                  }],
                }],
              }
            };
            
            session.sendEvent([transcriptEntity]);
          }
        });
      }).catch((err: Error) => {
        logger.error({ error: err.message }, 'Error stopping transcription');
      });
    });

    // Handle pause/resume
    session.on('paused', () => {
      logger.info('Session paused - transcription continuing');
    });

    session.on('resumed', () => {
      logger.info('Session resumed');
    });

    // Register with lifecycle
    const lifecycleToken = fastify.lifecycle.registerSession(() => {
      logger.info('Service shutdown announced, triggering reconnect');
    });

    session.addFiniHandler(() => {
      lifecycleToken.unregister();
    });

    // Statistics tracking
    session.addOpenHandler(ws.createTrackingHandler());
    session.addFiniHandler(() => {
      fastify.log.info({ session: sessionId }, `TCCP Session statistics - ${ws.loggableSummary()}`);
    });
  });
};
