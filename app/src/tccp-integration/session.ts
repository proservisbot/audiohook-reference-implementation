/**
 * Session types for TCCP integration
 */

export interface SessionRecord {
  sessionId: string;
  conversationId: string;
  correlationId: string;
  startedAt: Date;
  endedAt?: Date;
  state: string;
  events: unknown[];
  audioChunkCount: number;
  metadata?: Record<string, unknown>;
}
