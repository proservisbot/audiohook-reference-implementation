import { createClient } from '@deepgram/sdk';
import { DownstreamService, TranscriptionResult, DownstreamConfig } from './downstream';
import { SessionRecord } from './session';
import { Logger } from 'pino';

/**
 * Deepgram Adapter - Local testing transcription service
 */
export class DeepgramAdapter implements DownstreamService {
  readonly name = 'Deepgram';
  private config: DownstreamConfig;
  private deepgram: ReturnType<typeof createClient>;
  private activeSessions = new Map<string, ReturnType<ReturnType<typeof createClient>['listen']['live']>>();
  private transcripts = new Map<string, TranscriptionResult[]>();
  private logger: Logger;

  constructor(config: DownstreamConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    
    if (!config.deepgramApiKey) {
      throw new Error('Deepgram API key is required');
    }
    
    this.deepgram = createClient(config.deepgramApiKey);
  }

  async initialize(): Promise<void> {
    this.logger.info({ model: this.config.deepgramModel || 'nova-2' }, 'Deepgram adapter initialized');
  }

  async startTranscription(sessionId: string, _session: SessionRecord): Promise<void> {
    const connection = this.deepgram.listen.live({
      model: this.config.deepgramModel || 'nova-2',
      language: 'en-US',
      smart_format: true,
      encoding: 'linear16',
      sample_rate: this.config.sampleRate || 8000,
      channels: this.config.channels || 1,
      interim_results: true,
      endpointing: 300,
    });

    this.transcripts.set(sessionId, []);

    connection.on('open', () => {
      this.logger.info('Deepgram transcription connection opened');
    });

    connection.on('transcript', (data: Record<string, unknown>) => {
      const channel = data['channel'] as Record<string, unknown>;
      const alternatives = channel?.['alternatives'] as Array<Record<string, unknown>>;
      const transcript = alternatives?.[0];
      
      if (!transcript?.['transcript']) return;

      const result: TranscriptionResult = {
        transcript: transcript['transcript'] as string,
        confidence: (transcript['confidence'] as number) || 0,
        isFinal: (data['is_final'] as boolean) || false,
        words: (transcript['words'] as Array<Record<string, unknown>>)?.map((w) => ({
          word: w['word'] as string,
          start: w['start'] as number,
          end: w['end'] as number,
          confidence: w['confidence'] as number,
        })),
        metadata: {
          deepgramRequestId: (data['metadata'] as Record<string, unknown>)?.['request_id'] as string,
          duration: (data['metadata'] as Record<string, unknown>)?.['duration'] as number,
        },
      };

      const sessionTranscripts = this.transcripts.get(sessionId) || [];
      sessionTranscripts.push(result);
      this.transcripts.set(sessionId, sessionTranscripts);

      if (result.isFinal) {
        this.logger.info({ transcript: result.transcript, confidence: result.confidence }, 'Final transcript');
      }
    });

    connection.on('error', (err: Error) => {
      this.logger.error({ error: err.message }, 'Deepgram error');
    });

    connection.on('close', () => {
      this.logger.info('Deepgram transcription connection closed');
    });

    this.activeSessions.set(sessionId, connection);
  }

  async sendAudioChunk(sessionId: string, chunk: { payload: Buffer }): Promise<void> {
    const connection = this.activeSessions.get(sessionId);
    if (!connection) {
      this.logger.warn({ sessionId }, 'No active Deepgram session');
      return;
    }

    connection.send(chunk.payload);
  }

  async stopTranscription(sessionId: string): Promise<TranscriptionResult[]> {
    const connection = this.activeSessions.get(sessionId);
    
    if (connection) {
      connection.requestClose();
      this.activeSessions.delete(sessionId);
    }

    const finalTranscripts = this.transcripts.get(sessionId) || [];
    this.transcripts.delete(sessionId);

    this.logger.info({ transcriptCount: finalTranscripts.length }, 'Stopped Deepgram transcription');

    return finalTranscripts;
  }

  async shutdown(): Promise<void> {
    this.logger.info('Deepgram adapter shutdown');
    
    for (const [, connection] of this.activeSessions) {
      connection.requestClose();
    }
    
    this.activeSessions.clear();
    this.transcripts.clear();
  }
}
