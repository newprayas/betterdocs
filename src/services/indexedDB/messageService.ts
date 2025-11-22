import { db } from './db';
import type { Message, MessageCreate } from '@/types';
import { ensureDate } from '@/utils/date';
import { userIdLogger } from '@/utils/userIdDebugLogger';

export class MessageService {
  /**
   * Create a new message
   */
  async createMessage(data: MessageCreate, userId?: string): Promise<Message> {
    userIdLogger.logServiceCall('messageService', 'createMessage', 'create', userId || null);
    
    if (!db) throw new Error('Database not available');
    
    // If userId is provided, verify session ownership
    if (userId) {
      const session = await db.sessions.get(data.sessionId);
      if (!session) {
        userIdLogger.logError('messageService.createMessage', new Error('Attempt to create message for non-existent session'), userId);
        throw new Error('Session not found');
      }
      
      if (session.userId !== userId) {
        userIdLogger.logError('messageService.createMessage', new Error('Attempt to create message for session belonging to different user'), userId);
        throw new Error('Access denied');
      }
    }
    
    const message: Message = {
      id: crypto.randomUUID(),
      sessionId: data.sessionId,
      content: data.content,
      role: data.role,
      timestamp: new Date(),
      citations: data.citations,
    };

    // DEBUG: Log message content before storing
    console.log('[MESSAGE SERVICE CREATE DEBUG]', {
      messageId: message.id,
      content: data.content,
      hasNewlines: data.content.includes('\n'),
      newlineCount: (data.content.match(/\n/g) || []).length,
      bulletCount: (data.content.match(/^\* /gm) || []).length,
      firstFewLines: data.content.split('\n').slice(0, 5)
    });

    await db.messages.add(message);
    
    // DEBUG: Verify what was actually stored
    const storedMessage = await db.messages.get(message.id);
    if (storedMessage) {
      console.log('[MESSAGE SERVICE STORED DEBUG]', {
        messageId: storedMessage.id,
        content: storedMessage.content,
        hasNewlines: storedMessage.content.includes('\n'),
        newlineCount: (storedMessage.content.match(/\n/g) || []).length,
        bulletCount: (storedMessage.content.match(/^\* /gm) || []).length,
        firstFewLines: storedMessage.content.split('\n').slice(0, 5),
        contentMatches: data.content === storedMessage.content
      });
    }
    
    return message;
  }

  /**
   * Get all messages for a session ordered by createdAt
   */
  async getMessagesBySession(sessionId: string, userId?: string): Promise<Message[]> {
    userIdLogger.logServiceCall('messageService', 'getMessagesBySession', 'read', userId || null);
    
    if (!db) return [];
    
    // If userId is provided, verify session ownership
    if (userId) {
      const session = await db.sessions.get(sessionId);
      if (!session) {
        userIdLogger.logError('messageService.getMessagesBySession', new Error('Attempt to get messages for non-existent session'), userId);
        return []; // Return empty array if session doesn't exist or doesn't belong to user
      }
      
      if (session.userId !== userId) {
        userIdLogger.logError('messageService.getMessagesBySession', new Error('Attempt to get messages for session belonging to different user'), userId);
        return []; // Return empty array if session doesn't exist or doesn't belong to user
      }
    }
    
    const messages = await db.messages
      .where('sessionId')
      .equals(sessionId)
      .sortBy('timestamp');
    
    // Ensure timestamp is a Date object (handles IndexedDB serialization)
    const processedMessages = messages.map(message => {
      const processedMessage = {
        ...message,
        timestamp: ensureDate(message.timestamp)
      };
      
      // DEBUG: Log each retrieved message
      console.log('[MESSAGE SERVICE RETRIEVE DEBUG]', {
        messageId: message.id,
        content: message.content,
        hasNewlines: message.content.includes('\n'),
        newlineCount: (message.content.match(/\n/g) || []).length,
        bulletCount: (message.content.match(/^\* /gm) || []).length,
        firstFewLines: message.content.split('\n').slice(0, 5)
      });
      
      return processedMessage;
    });
    
    return processedMessages;
  }

  /**
   * Get a specific message by ID
   */
  async getMessage(id: string, userId?: string): Promise<Message | undefined> {
    userIdLogger.logServiceCall('messageService', 'getMessage', 'read', userId || null);
    
    if (!db) return undefined;
    const message = await db.messages.get(id);
    if (!message) return undefined;
    
    // If userId is provided, verify session ownership
    if (userId) {
      const session = await db.sessions.get(message.sessionId);
      if (!session) {
        userIdLogger.logError('messageService.getMessage', new Error('Attempt to get message for non-existent session'), userId);
        return undefined;
      }
      
      if (session.userId !== userId) {
        userIdLogger.logError('messageService.getMessage', new Error('Attempt to get message for session belonging to different user'), userId);
        return undefined;
      }
    }
    
    // Ensure timestamp is a Date object (handles IndexedDB serialization)
    return {
      ...message,
      timestamp: ensureDate(message.timestamp)
    };
  }

  /**
   * Update a message
   */
  async updateMessage(id: string, updates: Partial<Message>, userId?: string): Promise<void> {
    userIdLogger.logServiceCall('messageService', 'updateMessage', 'update', userId || null);
    
    if (!db) return;
    const existing = await db.messages.get(id);
    if (!existing) return;
    
    // If userId is provided, verify session ownership
    if (userId) {
      const session = await db.sessions.get(existing.sessionId);
      if (!session) {
        userIdLogger.logError('messageService.updateMessage', new Error('Attempt to update message for non-existent session'), userId);
        return;
      }
      
      if (session.userId !== userId) {
        userIdLogger.logError('messageService.updateMessage', new Error('Attempt to update message for session belonging to different user'), userId);
        return;
      }
    }
    
    const updated = { ...existing, ...updates };
    await db.messages.put(updated);
  }

  /**
   * Delete a message
   */
  async deleteMessage(id: string, userId?: string): Promise<void> {
    userIdLogger.logServiceCall('messageService', 'deleteMessage', 'delete', userId || null);
    
    if (!db) return;
    
    // If userId is provided, verify session ownership
    if (userId) {
      const message = await db.messages.get(id);
      if (!message) {
        userIdLogger.logError('messageService.deleteMessage', new Error('Attempt to delete non-existent message'), userId);
        return;
      }
      
      const session = await db.sessions.get(message.sessionId);
      if (!session) {
        userIdLogger.logError('messageService.deleteMessage', new Error('Attempt to delete message for non-existent session'), userId);
        return;
      }
      
      if (session.userId !== userId) {
        userIdLogger.logError('messageService.deleteMessage', new Error('Attempt to delete message for session belonging to different user'), userId);
        return;
      }
    }
    
    await db.messages.delete(id);
  }

  /**
   * Delete all messages for a session
   */
  async deleteMessagesBySession(sessionId: string, userId?: string): Promise<void> {
    userIdLogger.logServiceCall('messageService', 'deleteMessagesBySession', 'delete', userId || null);
    
    if (!db) return;
    
    // If userId is provided, verify session ownership
    if (userId) {
      const session = await db.sessions.get(sessionId);
      if (!session) {
        userIdLogger.logError('messageService.deleteMessagesBySession', new Error('Attempt to delete messages for non-existent session'), userId);
        return;
      }
      
      if (session.userId !== userId) {
        userIdLogger.logError('messageService.deleteMessagesBySession', new Error('Attempt to delete messages for session belonging to different user'), userId);
        return;
      }
    }
    
    await db.messages.where('sessionId').equals(sessionId).delete();
  }

  /**
   * Get message count for a session
   */
  async getMessageCount(sessionId: string): Promise<number> {
    if (!db) return 0;
    return await db.messages.where('sessionId').equals(sessionId).count();
  }

  /**
   * Get last message for a session
   */
  async getLastMessage(sessionId: string, userId?: string): Promise<Message | undefined> {
    userIdLogger.logServiceCall('messageService', 'getLastMessage', 'read', userId || null);
    
    if (!db) return undefined;
    
    // If userId is provided, verify session ownership
    if (userId) {
      const session = await db.sessions.get(sessionId);
      if (!session) {
        userIdLogger.logError('messageService.getLastMessage', new Error('Attempt to get last message for non-existent session'), userId);
        return undefined;
      }
      
      if (session.userId !== userId) {
        userIdLogger.logError('messageService.getLastMessage', new Error('Attempt to get last message for session belonging to different user'), userId);
        return undefined;
      }
    }
    
    const messages = await db.messages
      .where('sessionId')
      .equals(sessionId)
      .reverse()
      .sortBy('timestamp');
    
    if (messages.length === 0) return undefined;
    
    // Ensure timestamp is a Date object (handles IndexedDB serialization)
    const lastMessage = messages[0];
    return {
      ...lastMessage,
      timestamp: ensureDate(lastMessage.timestamp)
    };
  }
}

export const messageService = new MessageService();