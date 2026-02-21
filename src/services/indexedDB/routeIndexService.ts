import { db } from './db';
import type {
  PreprocessedChunk,
  RouteCompanionPayload,
  RouteCompanionBook,
  RouteCompanionSection,
  RouteIndexRecord,
  RouteSectionRecord,
} from '@/types';

interface SaveRouteCompanionInput {
  documentId: string;
  companion: RouteCompanionPayload;
  chunks: PreprocessedChunk[];
  needsNewId: boolean;
}

export class RouteIndexService {
  private buildRecordId(documentId: string): string {
    return `route:${documentId}:1`;
  }

  private normalizeVector(values: number[]): Float32Array | null {
    if (!Array.isArray(values) || values.length === 0) return null;
    const vec = new Float32Array(values);
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm <= 0) return null;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
  }

  private selectBook(companion: RouteCompanionPayload): RouteCompanionBook | null {
    if (!companion?.books || companion.books.length === 0) return null;
    return companion.books[0] || null;
  }

  private buildChunkIdMap(
    documentId: string,
    chunks: PreprocessedChunk[],
    needsNewId: boolean,
    chunkIdMap?: Record<string, string>
  ): Record<string, string> {
    if (chunkIdMap) return chunkIdMap;

    const mapping: Record<string, string> = {};
    for (let i = 0; i < chunks.length; i++) {
      const originalId = chunks[i].id;
      const finalId = needsNewId ? `chunk_${documentId}_${i}` : originalId;
      mapping[originalId] = finalId;
    }
    return mapping;
  }

  private mapSection(
    section: RouteCompanionSection,
    chunkIdMap: Record<string, string>
  ): RouteSectionRecord | null {
    const vector = this.normalizeVector(section.vector || []);
    if (!vector) return null;

    const originalChunkIds = Array.isArray(section.chunk_ids) ? section.chunk_ids : [];
    const mappedChunkIds = originalChunkIds
      .map((id) => chunkIdMap[id])
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    return {
      sectionId: section.section_id || crypto.randomUUID(),
      title: section.title || 'Section',
      pageStart: Number(section.page_start || 1),
      pageEnd: Number(section.page_end || section.page_start || 1),
      chunkCount: Number(section.chunk_count || mappedChunkIds.length),
      chunkIds: mappedChunkIds,
      vector,
      semanticLabel: section.semantic_label,
      semanticScore: typeof section.semantic_score === 'number' ? section.semantic_score : undefined,
    };
  }

  async saveRouteCompanionForDocument(input: SaveRouteCompanionInput): Promise<RouteIndexRecord | null> {
    if (!db) throw new Error('Database not initialized');
    const book = this.selectBook(input.companion);
    if (!book || !book.book_vector) return null;

    const bookVector = this.normalizeVector(book.book_vector);
    if (!bookVector) return null;

    const chunkIdMap = this.buildChunkIdMap(input.documentId, input.chunks, input.needsNewId);

    const sectionsRaw = Array.isArray(book.sections) ? book.sections : [];
    const sections = sectionsRaw
      .map((section) => this.mapSection(section, chunkIdMap))
      .filter((section): section is RouteSectionRecord => section !== null);

    const now = new Date();
    const record: RouteIndexRecord = {
      id: this.buildRecordId(input.documentId),
      documentId: input.documentId,
      sourceBin: book.source_bin,
      formatVersion: input.companion.format_version || 'route-1.0',
      sectionPages: Number(input.companion.section_pages || 20),
      embeddingDimensions: bookVector.length,
      bookVector,
      sections,
      createdAt: now,
      updatedAt: now,
    };

    await db.routeIndexes.put(record);
    return record;
  }

  async loadRouteIndexForDocument(documentId: string): Promise<RouteIndexRecord | undefined> {
    if (!db) return undefined;
    return db.routeIndexes.get(this.buildRecordId(documentId));
  }

  async cloneRouteIndexForDocument(
    sourceDocumentId: string,
    targetDocumentId: string,
    chunkIdMap?: Record<string, string>
  ): Promise<void> {
    if (!db) return;
    const source = await this.loadRouteIndexForDocument(sourceDocumentId);
    if (!source) return;

    const now = new Date();
    const remappedSections = source.sections.map((section) => ({
      ...section,
      chunkIds: chunkIdMap
        ? section.chunkIds.map((id) => chunkIdMap[id]).filter((id): id is string => Boolean(id))
        : section.chunkIds,
    }));

    const cloned: RouteIndexRecord = {
      ...source,
      id: this.buildRecordId(targetDocumentId),
      documentId: targetDocumentId,
      sections: remappedSections,
      createdAt: now,
      updatedAt: now,
    };

    await db.routeIndexes.put(cloned);
  }

  async deleteRouteIndexForDocument(documentId: string): Promise<void> {
    if (!db) return;
    await db.routeIndexes.delete(this.buildRecordId(documentId));
  }
}

export const routeIndexService = new RouteIndexService();
