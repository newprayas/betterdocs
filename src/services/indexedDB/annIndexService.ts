import { db } from './db';
import type { AnnIndexRecord, AnnIndexParams } from '@/types';

interface SaveAnnIndexInput {
  documentId: string;
  graphData: ArrayBuffer;
  idMap: string[];
  params: AnnIndexParams;
  embeddingDimensions: number;
  artifactName?: string;
  artifactChecksum?: string;
  artifactSize?: number;
  idMapName?: string;
  idMapChecksum?: string;
  idMapSize?: number;
  version?: string;
}

interface MarkMissingInput {
  documentId: string;
  embeddingDimensions: number;
  reason: string;
  params?: AnnIndexParams;
  version?: string;
}

export class AnnIndexService {
  private buildRecordId(documentId: string, algorithm: string, embeddingDimensions: number, version: string): string {
    return `${documentId}:${algorithm}:${embeddingDimensions}:${version}`;
  }

  async saveIndexForDocument(input: SaveAnnIndexInput): Promise<AnnIndexRecord> {
    if (!db) {
      throw new Error('Database not initialized');
    }

    const now = new Date();
    const version = input.version || '1.0';
    const id = this.buildRecordId(input.documentId, 'hnsw', input.embeddingDimensions, version);

    const record: AnnIndexRecord = {
      id,
      documentId: input.documentId,
      algorithm: 'hnsw',
      embeddingDimensions: input.embeddingDimensions,
      distance: 'cosine',
      version,
      params: input.params,
      graphData: input.graphData,
      idMap: input.idMap,
      artifactName: input.artifactName,
      artifactChecksum: input.artifactChecksum,
      artifactSize: input.artifactSize,
      idMapName: input.idMapName,
      idMapChecksum: input.idMapChecksum,
      idMapSize: input.idMapSize,
      state: 'ready',
      createdAt: now,
      updatedAt: now
    };

    await db.annIndexes.put(record);
    return record;
  }

  async loadIndexForDocument(documentId: string, embeddingDimensions: number = 1024): Promise<AnnIndexRecord | undefined> {
    if (!db) return undefined;

    const candidates = await db.annIndexes
      .where('documentId')
      .equals(documentId)
      .and((entry: AnnIndexRecord) =>
        entry.algorithm === 'hnsw' &&
        entry.embeddingDimensions === embeddingDimensions &&
        entry.state === 'ready')
      .toArray();

    if (candidates.length === 0) {
      return undefined;
    }

    candidates.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return candidates[0];
  }

  async verifyIndexChecksum(recordId: string): Promise<boolean> {
    if (!db) return false;
    const record = await db.annIndexes.get(recordId);
    if (!record) return false;

    if (!record.artifactChecksum) {
      return true;
    }

    const computed = await this.sha256Hex(record.graphData);
    const isValid = computed.toLowerCase() === record.artifactChecksum.toLowerCase();

    if (!isValid) {
      await this.markIndexCorrupt(recordId, `Checksum mismatch: expected ${record.artifactChecksum}, got ${computed}`);
    }

    return isValid;
  }

  async markIndexCorrupt(recordId: string, error?: string): Promise<void> {
    if (!db) return;
    const existing = await db.annIndexes.get(recordId);
    if (!existing) return;

    await db.annIndexes.put({
      ...existing,
      state: 'corrupt',
      lastError: error || existing.lastError,
      updatedAt: new Date()
    });
  }

  async listIndexedDocuments(): Promise<Array<{
    documentId: string;
    state: 'ready' | 'missing' | 'corrupt';
    algorithm: 'hnsw';
    embeddingDimensions: number;
    updatedAt: Date;
  }>> {
    if (!db) return [];
    const entries = await db.annIndexes.toArray();
    return entries.map((entry) => ({
      documentId: entry.documentId,
      state: entry.state,
      algorithm: entry.algorithm,
      embeddingDimensions: entry.embeddingDimensions,
      updatedAt: entry.updatedAt
    }));
  }

  async markMissingIndexForDocument(input: MarkMissingInput): Promise<void> {
    if (!db) return;

    const version = input.version || '1.0';
    const id = this.buildRecordId(input.documentId, 'hnsw', input.embeddingDimensions, version);
    const now = new Date();
    const existing = await db.annIndexes.get(id);

    const record: AnnIndexRecord = {
      id,
      documentId: input.documentId,
      algorithm: 'hnsw',
      embeddingDimensions: input.embeddingDimensions,
      distance: 'cosine',
      version,
      params: input.params || { m: 0, efConstruction: 0, efSearch: 0 },
      graphData: new ArrayBuffer(0),
      idMap: [],
      state: 'missing',
      lastError: input.reason,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };

    await db.annIndexes.put(record);
  }

  async cloneIndexForDocument(sourceDocumentId: string, targetDocumentId: string): Promise<void> {
    if (!db) return;

    const sourceIndexes = await db.annIndexes.where('documentId').equals(sourceDocumentId).toArray();
    if (sourceIndexes.length === 0) return;

    const now = new Date();
    const cloned = sourceIndexes.map((entry) => {
      const newId = this.buildRecordId(targetDocumentId, entry.algorithm, entry.embeddingDimensions, entry.version);
      return {
        ...entry,
        id: newId,
        documentId: targetDocumentId,
        createdAt: now,
        updatedAt: now
      };
    });

    await db.annIndexes.bulkPut(cloned);
  }

  private async sha256Hex(buffer: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const arr = Array.from(new Uint8Array(digest));
    return arr.map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

export const annIndexService = new AnnIndexService();
