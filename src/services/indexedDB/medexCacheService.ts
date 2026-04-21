import { db } from './db';
import type { MedexCacheRecord } from '@/types';

export class MedexCacheService {
  async getCache(id: string): Promise<MedexCacheRecord | undefined> {
    if (!db) return undefined;
    return await db.medexCache.get(id);
  }

  async saveCache(record: MedexCacheRecord): Promise<void> {
    if (!db) {
      throw new Error('Database not available');
    }
    await db.medexCache.put(record);
  }

  async deleteCache(id: string): Promise<void> {
    if (!db) return;
    await db.medexCache.delete(id);
  }
}
