/**
 * Conversation Manager for SIPREC-style multi-leg call tracking
 * Manages multiple AudioHook sessions (legs) that belong to the same conversation
 */

import { EventEmitter } from 'events';
import { SessionRecord } from './session';

export type CallLeg = 'caller' | 'agent';

export interface ConversationSession {
  sessionId: string;
  leg: CallLeg;
  participantId: string; // 'participant' or 'participant-2'
  session: SessionRecord;
  joinedAt: Date;
  audioCodesConversationId?: string;
}

export interface ActiveConversation {
  conversationId: string;
  organizationId: string;
  sessions: Map<string, ConversationSession>; // sessionId -> session
  createdAt: Date;
  audioCodesConversationId?: string;
  callerInfo?: {
    id: string;
    ani: string;
    aniName: string;
    dnis: string;
  };
  agentInfo?: {
    id: string;
    ani: string;
    aniName: string;
    dnis: string;
  };
}

export class ConversationManager extends EventEmitter {
  private conversations = new Map<string, ActiveConversation>(); // conversationId -> conversation
  private sessionToConversation = new Map<string, string>(); // sessionId -> conversationId
  
  // In-memory storage for now - can be replaced with Redis for distributed deployments
  
  /**
   * Create or get an existing conversation
   */
  getOrCreateConversation(
    conversationId: string, 
    organizationId: string
  ): ActiveConversation {
    let conversation = this.conversations.get(conversationId);
    
    if (!conversation) {
      conversation = {
        conversationId,
        organizationId,
        sessions: new Map(),
        createdAt: new Date(),
      };
      this.conversations.set(conversationId, conversation);
      this.emit('conversationCreated', conversation);
    }
    
    return conversation;
  }
  
  /**
   * Add a session (leg) to a conversation
   * Returns the assigned leg (caller/agent) and participant ID
   */
  addSessionToConversation(
    conversationId: string,
    sessionId: string,
    session: SessionRecord,
    participant: { id: string; ani: string; aniName: string; dnis: string }
  ): { leg: CallLeg; participantId: string } {
    const conversation = this.conversations.get(conversationId);
    
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }
    
    // Determine leg assignment
    // First session = caller, second session = agent
    const existingSessions = Array.from(conversation.sessions.values());
    const hasCaller = existingSessions.some(s => s.leg === 'caller');
    
    const leg: CallLeg = hasCaller ? 'agent' : 'caller';
    const participantId = leg === 'caller' ? 'participant' : 'participant-2';
    
    const conversationSession: ConversationSession = {
      sessionId,
      leg,
      participantId,
      session,
      joinedAt: new Date(),
    };
    
    conversation.sessions.set(sessionId, conversationSession);
    this.sessionToConversation.set(sessionId, conversationId);
    
    // Store participant info
    if (leg === 'caller') {
      conversation.callerInfo = participant;
    } else {
      conversation.agentInfo = participant;
    }
    
    this.emit('sessionJoined', conversation, conversationSession);
    
    return { leg, participantId };
  }
  
  /**
   * Get conversation by ID
   */
  getConversation(conversationId: string): ActiveConversation | undefined {
    return this.conversations.get(conversationId);
  }
  
  /**
   * Get conversation by session ID
   */
  getConversationBySession(sessionId: string): ActiveConversation | undefined {
    const conversationId = this.sessionToConversation.get(sessionId);
    if (conversationId) {
      return this.conversations.get(conversationId);
    }
    return undefined;
  }
  
  /**
   * Get session info within a conversation
   */
  getSession(conversationId: string, sessionId: string): ConversationSession | undefined {
    const conversation = this.conversations.get(conversationId);
    return conversation?.sessions.get(sessionId);
  }
  
  /**
   * Get all sessions for a conversation
   */
  getAllSessions(conversationId: string): ConversationSession[] {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return [];
    return Array.from(conversation.sessions.values());
  }
  
  /**
   * Remove a session from a conversation
   * Returns true if conversation should be cleaned up (no more sessions)
   */
  removeSession(sessionId: string): { conversationId: string; shouldCleanup: boolean } | null {
    const conversationId = this.sessionToConversation.get(sessionId);
    if (!conversationId) return null;
    
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return null;
    
    const session = conversation.sessions.get(sessionId);
    conversation.sessions.delete(sessionId);
    this.sessionToConversation.delete(sessionId);
    
    if (session) {
      this.emit('sessionLeft', conversation, session);
    }
    
    const shouldCleanup = conversation.sessions.size === 0;
    
    return { conversationId, shouldCleanup };
  }
  
  /**
   * Clean up a conversation entirely
   */
  cleanupConversation(conversationId: string): void {
    const conversation = this.conversations.get(conversationId);
    if (conversation) {
      // Remove all session mappings
      for (const sessionId of conversation.sessions.keys()) {
        this.sessionToConversation.delete(sessionId);
      }
      this.conversations.delete(conversationId);
      this.emit('conversationEnded', conversation);
    }
  }
  
  /**
   * Get all active conversations
   */
  getAllConversations(): ActiveConversation[] {
    return Array.from(this.conversations.values());
  }
  
  /**
   * Get stats for monitoring
   */
  getStats(): { conversations: number; sessions: number } {
    let sessions = 0;
    for (const conv of this.conversations.values()) {
      sessions += conv.sessions.size;
    }
    return {
      conversations: this.conversations.size,
      sessions,
    };
  }
  
  /**
   * Set AudioCodes conversation ID for tracking
   */
  setAudioCodesConversationId(
    conversationId: string, 
    audioCodesConversationId: string
  ): void {
    const conversation = this.conversations.get(conversationId);
    if (conversation) {
      conversation.audioCodesConversationId = audioCodesConversationId;
    }
  }
  
  /**
   * Get AudioCodes conversation ID
   */
  getAudioCodesConversationId(conversationId: string): string | undefined {
    return this.conversations.get(conversationId)?.audioCodesConversationId;
  }
}

// Singleton instance
let conversationManager: ConversationManager | null = null;

export const getConversationManager = (): ConversationManager => {
  if (!conversationManager) {
    conversationManager = new ConversationManager();
  }
  return conversationManager;
};

export const resetConversationManager = (): void => {
  conversationManager = null;
};
