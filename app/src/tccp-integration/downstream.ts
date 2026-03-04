/**
 * Downstream transcription service abstraction
 * Defines the interface for sending audio to transcription services (TCCP, Deepgram, etc.)
 */

import { SessionRecord } from './session';

export interface TranscriptionResult {
  transcript: string;
  isFinal: boolean;
  confidence: number;
  language?: string;
  words?: Array<{
    word: string;
    start: number;
    end: number;
    confidence: number;
  }>;
  metadata?: Record<string, unknown>;
}

export interface AudioChunk {
  streamId: string;
  sequenceNumber: number;
  timestamp: Date;
  payload: Buffer;
}

export interface DownstreamService {
  /**
   * Initialize the service (e.g., setup auth, validate config)
   */
  initialize(): Promise<void>;

  /**
   * Shutdown the service gracefully
   */
  shutdown(): Promise<void>;

  /**
   * Start a new transcription session
   */
  startTranscription(sessionId: string, session: SessionRecord): Promise<void>;

  /**
   * Send audio chunk for transcription
   */
  sendAudioChunk(sessionId: string, chunk: AudioChunk): Promise<void>;

  /**
   * Stop transcription and return results
   */
  stopTranscription(sessionId: string): Promise<TranscriptionResult[]>;
}

export interface DownstreamConfig {
  service: 'tccp' | 'deepgram' | 'both';
  deepgramApiKey?: string;
  deepgramModel?: string;
  tccpEndpoint?: string;
  tccpApiKey?: string;
  audioCodesBotUrl?: string;
  audioCodesApiKey?: string;
  eventWebhookUrl?: string;
  sampleRate: number;
  channels: number;
}
