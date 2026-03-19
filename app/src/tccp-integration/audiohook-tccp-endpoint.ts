import { FastifyInstance } from 'fastify';
import dotenv from 'dotenv';
import { initiateRequestAuthentication, verifyRequestSignature } from '../authenticator';
import { isUuid, httpsignature as httpsig, ServerSession, createServerSession, MediaDataFrame } from '../../audiohook';
import { SessionWebsocketStatsTracker } from '../session-websocket-stats-tracker';
import { createDownstreamService, DownstreamService, DownstreamConfig, AudioChunk, TranscriptionResult } from './factory';
import { SessionRecord } from './session';
import { DeepgramAdapter } from './deepgram-adapter';
import { TCCPAdapter } from './tccp-adapter';

dotenv.config();

const isDev = process.env['NODE_ENV'] !== 'production';

declare module 'fastify' {
    interface FastifyRequest {
        authenticated?: boolean;
    }
}

type AuthStrategy = 'request' | 'session';

/**
 * Downstream services manager - handles both Deepgram and TCCP
 * Deepgram: receives audio, produces transcripts
 * TCCP: receives transcripts and AudioHook events (no audio)
 */
class DownstreamServiceManager {
    private deepgram: DeepgramAdapter | null = null;
    private tccp: TCCPAdapter | null = null;
    private logger: FastifyInstance['log'];
    private config: DownstreamConfig;

    constructor(config: DownstreamConfig, logger: FastifyInstance['log']) {
        this.config = config;
        this.logger = logger;
    }

    async initialize(): Promise<void> {
        const serviceType = this.config.service;

        // Always initialize Deepgram for transcription if API key provided
        if (this.config.deepgramApiKey && (serviceType === 'deepgram' || serviceType === 'both')) {
            this.deepgram = new DeepgramAdapter(this.config, this.logger);
            await this.deepgram.initialize();
            this.logger.info('Deepgram transcription service initialized');
        }

        // Initialize TCCP for receiving transcripts/events
        // Check for either legacy TCCP config OR AudioCodes config
        const hasTccpConfig = (this.config.tccpEndpoint && this.config.tccpApiKey) || 
                              (this.config.audioCodesBotUrl && this.config.audioCodesApiKey);
        
        if (hasTccpConfig && (serviceType === 'tccp' || serviceType === 'both')) {
            this.tccp = new TCCPAdapter(this.config, this.logger);
            await this.tccp.initialize();
            this.logger.info({ 
                audioCodesBotUrl: this.config.audioCodesBotUrl,
                eventWebhookUrl: this.config.eventWebhookUrl,
            }, 'TCCP event service initialized');
        }

        // If only TCCP was requested but no Deepgram, we still need transcription
        // In that case, TCCP would need to handle audio (not implemented in this adapter)
        if (serviceType === 'tccp' && !this.deepgram && !this.tccp) {
            throw new Error('TCCP configuration incomplete - need endpoint and API key');
        }
    }

    async startTranscription(sessionId: string, session: SessionRecord): Promise<void> {
        // Start Deepgram transcription (receives audio)
        if (this.deepgram) {
            // Listen for real-time transcripts from Deepgram and forward to TCCP
            this.deepgram.on('transcript', (sid: string, transcript: TranscriptionResult) => {
                if (sid === sessionId) {
                    this.logger.info({ transcript: transcript.transcript }, 'Forwarding transcript to TCCP');
                    this.sendTranscriptToTCCP(sessionId, transcript)
                        .catch((err) => this.logger.error({ error: (err as Error).message }, 'Failed to forward transcript to TCCP'));
                }
            });
            
            await this.deepgram.startTranscription(sessionId, session);
        }

        // Start TCCP session (receives events)
        if (this.tccp) {
            await this.tccp.startTranscription(sessionId, session);
        }
    }

    async sendAudioChunk(sessionId: string, chunk: AudioChunk): Promise<void> {
        // Only Deepgram receives audio
        if (this.deepgram) {
            await this.deepgram.sendAudioChunk(sessionId, chunk);
        }
    }

    async sendTranscriptToTCCP(sessionId: string, transcript: TranscriptionResult, leg: 'inbound' | 'outbound' = 'inbound'): Promise<void> {
        // Forward transcript from Deepgram to TCCP with leg information
        if (this.tccp) {
            await this.tccp.sendTranscript(sessionId, transcript, leg);
        }
    }

    async sendParticipantEvent(sessionId: string, participant: { id: string; ani: string; aniName: string; dnis: string }, leg: 'inbound' | 'outbound' = 'inbound'): Promise<void> {
        // Forward AudioHook participant info to TCCP/AudioCodes
        if (this.tccp) {
            await this.tccp.sendParticipantEvent(sessionId, participant, leg);
        }
    }

    async pauseSession(sessionId: string): Promise<void> {
        if (this.tccp) {
            await this.tccp.pauseSession(sessionId);
        }
    }

    async resumeSession(sessionId: string): Promise<void> {
        if (this.tccp) {
            await this.tccp.resumeSession(sessionId);
        }
    }

    async stopTranscription(sessionId: string): Promise<TranscriptionResult[]> {
        const transcripts: TranscriptionResult[] = [];

        // Get transcripts from Deepgram
        if (this.deepgram) {
            const deepgramTranscripts = await this.deepgram.stopTranscription(sessionId);
            transcripts.push(...deepgramTranscripts);
            
            // Forward final transcripts to TCCP
            for (const t of deepgramTranscripts) {
                await this.sendTranscriptToTCCP(sessionId, t);
            }
        }

        // Stop TCCP session
        if (this.tccp) {
            await this.tccp.stopTranscription(sessionId);
        }

        return transcripts;
    }

    get hasDeepgram(): boolean {
        return this.deepgram !== null;
    }

    get hasTCCP(): boolean {
        return this.tccp !== null;
    }

    onTranscript(sessionId: string, handler: (transcript: TranscriptionResult) => void): void {
        // Hook into Deepgram's transcript events to forward to TCCP
        // This would need to be implemented in DeepgramAdapter to emit events
    }
}
export const addAudiohookTccpRoute = (fastify: FastifyInstance, path: string): void => {
    // Initialize downstream transcription services
    const config: DownstreamConfig = {
        service: (process.env['TRANSCRIPTION_SERVICE'] as 'deepgram' | 'tccp' | 'both') || 'deepgram',
        deepgramApiKey: process.env['DEEPGRAM_API_KEY'],
        deepgramModel: process.env['DEEPGRAM_MODEL'] || 'nova-2',
        tccpEndpoint: process.env['TCCP_ENDPOINT'],
        tccpApiKey: process.env['TCCP_API_KEY'],
        audioCodesBotUrl: process.env['AUDIOCODES_BOT_URL'],
        audioCodesApiKey: process.env['AUDIOCODES_API_KEY'],
        eventWebhookUrl: process.env['EVENT_WEBHOOK_URL'],
        sampleRate: parseInt(process.env['AUDIO_SAMPLE_RATE'] || '8000', 10),
        channels: parseInt(process.env['AUDIO_CHANNELS'] || '1', 10),
    };

    let serviceManager: DownstreamServiceManager | null = null;
    const activeSessions = new Map<string, SessionRecord>();

    // Initialize downstream services
    const initializeService = async (): Promise<void> => {
        if (serviceManager) return;
        
        try {
            serviceManager = new DownstreamServiceManager(config, fastify.log);
            await serviceManager.initialize();
            fastify.log.info({ 
                service: config.service,
                hasDeepgram: serviceManager.hasDeepgram,
                hasTCCP: serviceManager.hasTCCP,
            }, 'TCCP downstream services initialized');
        } catch (err) {
            fastify.log.error({ error: (err as Error).message }, 'Failed to initialize downstream services');
            serviceManager = null;
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
        // In dev mode, skip auth to allow unsigned test requests
        if (!isDev && !(request.authenticated ?? false)) {
            initiateRequestAuthentication({ session, request });
        } else if (isDev) {
            logger.info('Dev mode: Skipping signature authentication');
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
            logger.info({ conversationId: openParams.conversationId, participant: openParams.participant }, 'TCCP session opened');
            
            sessionRecord.state = 'open';
            sessionRecord.conversationId = openParams.conversationId;
            sessionRecord.metadata = {
                organizationId: openParams.organizationId,
                participant: openParams.participant,
            };

            // Start transcription with downstream services
            if (serviceManager) {
                serviceManager.startTranscription(sessionId, sessionRecord)
                    .then(() => {
                        logger.info('Downstream transcription started');
                        // Forward participant info to TCCP/AudioCodes
                        if (openParams.participant && serviceManager) {
                            return serviceManager.sendParticipantEvent(sessionId, openParams.participant, 'inbound');
                        }
                        return Promise.resolve();
                    })
                    .catch((err) => logger.error({ error: (err as Error).message }, 'Failed to start transcription or send participant event'));
            }
        });

        // Handle audio data - forward to transcription service
        let audioSequence = 0;
        let lastLogTime = Date.now();
        let chunksSinceLog = 0;
        session.on('audio', function(this: ServerSession, frame: MediaDataFrame) {
            if (!serviceManager) return;

            // Get audio payload from the frame's audio view
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

            serviceManager.sendAudioChunk(sessionId, chunk)
                .catch((err) => logger.error({ error: (err as Error).message }, 'Failed to send audio chunk'));
        });

        // Handle pause using event emitter
        session.on('paused', function(this: ServerSession) {
            logger.info('Session paused');
            sessionRecord.state = 'paused';
            if (serviceManager) {
                serviceManager.pauseSession(sessionId)
                    .catch((err) => logger.error({ error: (err as Error).message }, 'Failed to notify TCCP of pause'));
            }
        });

        // Handle resume using event emitter
        session.on('resumed', function(this: ServerSession) {
            logger.info('Session resumed');
            sessionRecord.state = 'open';
            if (serviceManager) {
                serviceManager.resumeSession(sessionId)
                    .catch((err) => logger.error({ error: (err as Error).message }, 'Failed to notify TCCP of resume'));
            }
        });

        // Handle session close - stop transcription and cleanup
        session.addFiniHandler(async () => {
            logger.info('TCCP session closing');
            sessionRecord.state = 'closed';
            sessionRecord.endedAt = new Date();

            if (serviceManager) {
                try {
                    const transcripts = await serviceManager.stopTranscription(sessionId);
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
