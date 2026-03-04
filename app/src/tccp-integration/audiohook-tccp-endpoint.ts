import { FastifyInstance } from 'fastify';
import dotenv from 'dotenv';
import { initiateRequestAuthentication, verifyRequestSignature } from '../authenticator';
import { isUuid, httpsignature as httpsig, ServerSession, createServerSession, MediaDataFrame } from '../../audiohook';
import { SessionWebsocketStatsTracker } from '../session-websocket-stats-tracker';
import { createDownstreamService, DownstreamService, DownstreamConfig, AudioChunk } from './factory';
import { SessionRecord } from './session';

dotenv.config();

const isDev = process.env['NODE_ENV'] !== 'production';

declare module 'fastify' {
    interface FastifyRequest {
        authenticated?: boolean;
    }
}

type AuthStrategy = 'request' | 'session';

/**
 * TCCP Integration Endpoint
 * Routes AudioHook audio to downstream transcription services (Deepgram, TCCP)
 */
export const addAudiohookTccpRoute = (fastify: FastifyInstance, path: string): void => {
    // Initialize downstream transcription service
    const config: DownstreamConfig = {
        service: (process.env['TRANSCRIPTION_SERVICE'] as 'deepgram' | 'tccp') || 'deepgram',
        deepgramApiKey: process.env['DEEPGRAM_API_KEY'],
        deepgramModel: process.env['DEEPGRAM_MODEL'] || 'nova-2',
        tccpEndpoint: process.env['TCCP_ENDPOINT'],
        tccpApiKey: process.env['TCCP_API_KEY'],
        sampleRate: parseInt(process.env['AUDIO_SAMPLE_RATE'] || '8000', 10),
        channels: parseInt(process.env['AUDIO_CHANNELS'] || '1', 10),
    };

    let downstreamService: DownstreamService | null = null;
    const activeSessions = new Map<string, SessionRecord>();

    // Initialize downstream service
    const initializeService = async (): Promise<void> => {
        if (downstreamService) return;
        
        try {
            downstreamService = createDownstreamService(config, fastify.log);
            await downstreamService.initialize();
            fastify.log.info({ service: config.service }, 'TCCP downstream service initialized');
        } catch (err) {
            fastify.log.error({ error: (err as Error).message }, 'Failed to initialize downstream service');
            downstreamService = null;
        }
    };

    // Initialize on startup
    initializeService().catch((err) => {
        fastify.log.error({ error: (err as Error).message }, 'Downstream service initialization failed');
    });

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
            if (authStrategy === 'request') {
                const result = await verifyRequestSignature({ request });
                if (result.code !== 'VERIFIED') {
                    request.log.info(`Signature verification failure: ${JSON.stringify(result)}`);
                    reply.code(401);
                    return reply.send('Signature verification failed');
                }
                request.authenticated = true;
            }
            return;
        },
    }, (connection, request) => {
        request.log.info(`TCCP Websocket Request - URI: <${request.url}>, SocketRemoteAddr: ${request.socket.remoteAddress}`);

        const sessionId = httpsig.queryCanonicalizedHeaderField(request.headers, 'audiohook-session-id');
        if (!sessionId || !isUuid(sessionId)) {
            throw new RangeError('Missing or invalid "audiohook-session-id" header field');
        }

        const correlationId = httpsig.queryCanonicalizedHeaderField(request.headers, 'audiohook-correlation-id') || sessionId;
        const organizationId = httpsig.queryCanonicalizedHeaderField(request.headers, 'audiohook-organization-id') || 'unknown';

        if (isDev && (connection.socket.binaryType !== 'nodebuffer')) {
            throw new Error(`WebSocket binary type '${connection.socket.binaryType}' not supported`);
        }

        const logLevel = isDev ? 'debug' : 'info';
        const logger = request.log.child({ session: sessionId }, { level: logLevel });

        // Create WebSocket stats tracker
        const ws = new SessionWebsocketStatsTracker(connection.socket);

        // Create server session
        const session: ServerSession = createServerSession({
            ws,
            id: sessionId,
            logger
        });

        // Create session record for tracking
        const sessionRecord: SessionRecord = {
            sessionId,
            conversationId: organizationId,
            correlationId,
            startedAt: new Date(),
            state: 'connecting',
            events: [],
            audioChunkCount: 0,
        };
        activeSessions.set(sessionId, sessionRecord);

        // Handle authentication if not already done
        if (!(request.authenticated ?? false)) {
            initiateRequestAuthentication({ session, request });
        }

        // Add media selector to accept PCMU format from microphone client
        session.addMediaSelector((_session, offered, _openParams) => {
            // Find PCMU format at 8kHz (what microphone client sends)
            const pcmuMedia = offered.find(m => m.format === 'PCMU' && m.rate === 8000);
            if (pcmuMedia) {
                logger.info('Selected PCMU 8kHz media format');
                return Promise.resolve([pcmuMedia]);
            }
            // Fallback to first offered format
            logger.info({ format: offered[0]?.format, rate: offered[0]?.rate }, 'Selected media format');
            return Promise.resolve([offered[0]]);
        });

        // Track audio sequence numbers per stream
        const streamSequences = new Map<string, number>();

        // Handle session open - start transcription
        session.addOpenHandler((context) => {
            const { openParams } = context;
            logger.info({ conversationId: openParams.conversationId }, 'TCCP session opened');
            
            sessionRecord.state = 'open';
            sessionRecord.conversationId = openParams.conversationId;
            sessionRecord.metadata = {
                organizationId: openParams.organizationId,
                participant: openParams.participant,
            };

            // Start transcription with downstream service
            if (downstreamService) {
                downstreamService.startTranscription(sessionId, sessionRecord)
                    .then(() => logger.info('Downstream transcription started'))
                    .catch((err) => logger.error({ error: (err as Error).message }, 'Failed to start transcription'));
            }
        });

        // Handle audio data - forward to transcription service using event emitter
        let audioSequence = 0;
        let lastLogTime = Date.now();
        let chunksSinceLog = 0;
        session.on('audio', function(this: ServerSession, frame: MediaDataFrame) {
            if (!downstreamService) return;

            // Get audio payload from the frame's audio view
            // frame.audio is a MultiChannelView with a data property (Uint8Array for PCMU, Int16Array for L16)
            const audioData = frame.audio.data;
            if (!audioData || audioData.length === 0) return;

            const chunk: AudioChunk = {
                streamId: sessionId,
                sequenceNumber: audioSequence++,
                timestamp: new Date(),
                payload: Buffer.from(audioData.buffer, audioData.byteOffset, audioData.byteLength),
            };

            sessionRecord.audioChunkCount++;
            chunksSinceLog++;

            // Log every 1 second
            const now = Date.now();
            if (now - lastLogTime >= 1000) {
                logger.info({ 
                    chunksReceived: chunksSinceLog, 
                    totalChunks: sessionRecord.audioChunkCount,
                    bytesPerChunk: audioData.length 
                }, 'Audio chunks received');
                chunksSinceLog = 0;
                lastLogTime = now;
            }

            downstreamService.sendAudioChunk(sessionId, chunk)
                .catch((err) => logger.error({ error: (err as Error).message }, 'Failed to send audio chunk'));
        });

        // Handle pause using event emitter
        session.on('paused', function(this: ServerSession) {
            logger.info('Session paused');
            sessionRecord.state = 'paused';
        });

        // Handle resume using event emitter
        session.on('resumed', function(this: ServerSession) {
            logger.info('Session resumed');
            sessionRecord.state = 'open';
        });

        // Handle session close - stop transcription and cleanup
        session.addFiniHandler(async () => {
            logger.info('TCCP session closing');
            sessionRecord.state = 'closed';
            sessionRecord.endedAt = new Date();

            if (downstreamService) {
                try {
                    const transcripts = await downstreamService.stopTranscription(sessionId);
                    logger.info({ 
                        transcriptCount: transcripts.length,
                        audioChunks: sessionRecord.audioChunkCount 
                    }, 'Transcription completed');
                } catch (err) {
                    logger.error({ error: (err as Error).message }, 'Failed to stop transcription');
                }
            }

            activeSessions.delete(sessionId);
        });

        // Register lifecycle handler
        const lifecycleToken = fastify.lifecycle.registerSession(() => {
            logger.info('Service shutdown announced');
        });

        session.addFiniHandler(() => {
            lifecycleToken.unregister();
        });

        // Register stats tracking
        session.addOpenHandler(ws.createTrackingHandler());
        session.addFiniHandler(() => {
            fastify.log.info({ session: sessionId }, `TCCP Session statistics - ${ws.loggableSummary()}`);
        });
    });
};
