import { DownstreamService, DownstreamConfig } from './downstream';
import { DeepgramAdapter } from './deepgram-adapter';
import { TCCPAdapter } from './tccp-adapter';
import { FastifyBaseLogger } from 'fastify';

export { DownstreamService, TranscriptionResult, AudioChunk, DownstreamConfig } from './downstream';

/**
 * Factory function to create the appropriate downstream service based on config
 */
export function createDownstreamService(config: DownstreamConfig, logger: FastifyBaseLogger): DownstreamService {
  switch (config.service) {
    case 'deepgram':
      return new DeepgramAdapter(config, logger);
    case 'tccp':
      return new TCCPAdapter(config, logger);
    default:
      throw new Error(`Unknown transcription service: ${config.service}`);
  }
}
