import Dexie from 'dexie';
import { db } from './db';
import type { SavedAnswer, SavedAnswerCreate } from '@/types';
import { ensureDate } from '@/utils/date';

const DEFAULT_SESSION_NAME = 'Conversation';

export class SavedAnswerService {
  private normalizeSavedAnswer(answer: SavedAnswer): SavedAnswer {
    return {
      ...answer,
      savedAt: ensureDate(answer.savedAt),
    };
  }

  async getSavedAnswers(userId?: string): Promise<SavedAnswer[]> {
    if (!db) return [];

    const records = userId
      ? await db.savedAnswers
          .where('[userId+savedAt]')
          .between([userId, Dexie.minKey], [userId, Dexie.maxKey])
          .reverse()
          .toArray()
      : await db.savedAnswers.orderBy('savedAt').reverse().toArray();

    return records.map((record) => this.normalizeSavedAnswer(record));
  }

  async getSavedAnswer(id: string): Promise<SavedAnswer | undefined> {
    if (!db) return undefined;
    const record = await db.savedAnswers.get(id);
    return record ? this.normalizeSavedAnswer(record) : undefined;
  }

  async isSaved(id: string): Promise<boolean> {
    if (!db) return false;
    return Boolean(await db.savedAnswers.get(id));
  }

  async saveAnswer(payload: SavedAnswerCreate): Promise<SavedAnswer> {
    if (!db) {
      throw new Error('Database not available');
    }

    const saved: SavedAnswer = {
      id: payload.sourceMessageId,
      sourceMessageId: payload.sourceMessageId,
      userId: payload.userId,
      sessionId: payload.sessionId,
      sessionName: payload.sessionName.trim() || DEFAULT_SESSION_NAME,
      content: payload.content,
      savedAt: ensureDate(payload.savedAt || new Date()),
    };

    await db.savedAnswers.put(saved);
    return this.normalizeSavedAnswer(saved);
  }

  async removeSavedAnswer(id: string): Promise<void> {
    if (!db) return;
    await db.savedAnswers.delete(id);
  }

  async toggleSavedAnswer(payload: SavedAnswerCreate): Promise<{ saved: boolean; item?: SavedAnswer }> {
    if (!db) {
      throw new Error('Database not available');
    }

    const existing = await db.savedAnswers.get(payload.sourceMessageId);
    if (existing) {
      await db.savedAnswers.delete(payload.sourceMessageId);
      return { saved: false };
    }

    const item = await this.saveAnswer(payload);
    return { saved: true, item };
  }
}

export const savedAnswerService = new SavedAnswerService();
