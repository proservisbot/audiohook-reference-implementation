import { DownstreamService, DownstreamConfig } from './downstream';
import { DeepgramAdapter } from './deepgram-adapter';
import { Logger } from 'pino';

export { DownstreamService, TranscriptionResult, AudioChunk, DownstreamConfig } from './downstream';

/**
 * Factory function to create the appropriate downstream service based on config
 */
export function createDownstreamService(config: DownstreamConfig, logger: Logger): DownstreamService {
  switch (config.service) {
    case 'deepgram':
      return new DeepgramAdapter(config, logger);
    case 'tccp':
      // Placeholder for TCCP adapter
      throw new Error('TCCP adapter not yet implemented');
    default:
      throw new Error(`Unknown transcription service: ${config.service}`);
  }
}
