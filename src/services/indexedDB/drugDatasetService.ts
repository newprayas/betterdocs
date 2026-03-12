import { db } from './db';
import type { DrugDatasetRecord } from '@/types';

export class DrugDatasetService {
  async getDataset(id: string): Promise<DrugDatasetRecord | undefined> {
    if (!db) return undefined;
    return await db.drugDatasets.get(id);
  }

  async saveDataset(record: DrugDatasetRecord): Promise<void> {
    if (!db) {
      throw new Error('Database not available');
    }
    await db.drugDatasets.put(record);
  }

  async deleteDataset(id: string): Promise<void> {
    if (!db) return;
    await db.drugDatasets.delete(id);
  }
}
