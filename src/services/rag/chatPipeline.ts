import { getIndexedDBServices } from '../indexedDB';
import { chatService, embeddingService } from '../gemini';
import { groqService } from '../groq/groqService';
import { vectorSearchService } from './vectorSearch';
import { documentProcessor } from './documentProcessor';
import { citationService } from './citationService';
import { classifyQueryIntent, type QueryIntent } from './queryIntent';
import {
  applyAnswerContract,
  buildContractFallbackResponse,
  buildContractPromptInstructions,
  getAnswerContract,
  type AnswerContract,
} from './answerContract';
import { postProcessRetrievalResults } from './retrievalPostprocess';
import { MessageSender, type MessageCreate, type Message } from '@/types';
import type { Document, RouteIndexRecord } from '@/types';
import type { ChatStreamEvent } from '../gemini/chatService';
import type { SimplifiedCitation, SimplifiedCitationGroup, StructuredAnswerResponse } from '@/types/citation';
import type { EmbeddingChunk, VectorSearchResult } from '@/types/embedding';
import { cosineSimilarity, calculateVectorNorm } from '@/utils/vectorUtils';

const ANSWER_GENERATION_MODEL = 'openai/gpt-oss-120b';

interface RouteSectionCandidate {
  score: number;
  chunkIds: string[];
}

interface RouteDocumentCandidate {
  documentId: string;
  bookScore: number;
  sourceBin?: string;
  sections: RouteSectionCandidate[];
}

interface RoutePrefilterPlan {
  documentIds?: string[];
  allowedChunkIds?: string[];
}

interface RetrievedChunkDebugInfo {
  origin: 'base_retrieval' | 'neighbor_added';
  isNeighborChunk: boolean;
  neighborType: 'none' | 'top_chunk_adjacent' | 'page_neighbor' | 'neighbor_unknown';
  neighborOfChunkId?: string;
  neighborRelation?: 'above' | 'below';
}

interface SimplifiedGenerationMetrics {
  postprocessMs: number;
  contractPassBeforeFix: boolean;
  contractPassAfterFix: boolean;
  hadNumberingFix: boolean;
  hadMissingSectionFill: boolean;
}

interface ChunkQualityAssessment {
  score: number;
  reasons: string[];
  shouldExclude: boolean;
  exclusionType: 'bibliography' | 'index' | 'caption-only' | 'mixed' | 'other';
}

interface RetrievedChunkGenerationDecision {
  fedToGenerator: boolean;
  reason?: string;
}

interface GenerationPageSelectionDebug {
  strongestCluster: {
    documentId: string;
    page: number | null;
    score: number;
    chunkCount: number;
  } | null;
  localFocusActive: boolean;
  preferredLocalWindow: {
    documentId: string;
    pages: number[];
  } | null;
  rankedClusters: Array<{
    documentId: string;
    page: number | null;
    score: number;
    chunkCount: number;
    preferredLocal: boolean;
  }>;
  selectedChunkCount: number;
  selectedPages: Array<{
    documentId: string;
    page: number | null;
    count: number;
    chunkIds: string[];
  }>;
}

interface RetrievalAnchorWindowDebug {
  mode: 'anchor_window_only' | 'anchor_window_plus_fallback' | 'multi_page_fallback' | 'insufficient_input';
  queryIntent?: QueryIntent;
  anchor: {
    documentId: string;
    page: number | null;
    anchorScore: number;
    baseScore: number;
    intentScore: number;
    chunkCount: number;
    marginVsNext: number;
  } | null;
  localPages: number[];
  localBaseChunkCount: number;
  localWindowChunkCount: number;
  rankedPageGroups: Array<{
    documentId: string;
    page: number | null;
    anchorScore: number;
    baseScore: number;
    intentScore: number;
    chunkCount: number;
  }>;
  reason: string;
}

interface StructuredSourceGroup {
  key: string;
  order: number;
  documentTitle: string;
  page?: number;
  heading: string | null;
  content: string;
}

interface DirectCitationPageGroup {
  key: string;
  documentId: string;
  documentTitle: string;
  page: number;
  chunks: Array<{
    id: string;
    content: string;
    similarity: number;
  }>;
  combinedContent: string;
  maxSimilarity: number;
}

interface RenderedStructuredAnswerWithCitations {
  content: string;
  citations: SimplifiedCitation[];
}

interface SessionWarmCacheEntry {
  enabledDocSignature: string;
  hasAnyEmbeddings: boolean;
  warmedAt: number;
}

interface DocumentEmbeddingCacheEntry {
  embeddings: EmbeddingChunk[];
  loadedAt: number;
}

interface RetrievalWarmupEmbeddingCacheEntry {
  embedding: Float32Array;
  warmedAt: number;
}

interface StandaloneRewriteResult {
  query: string;
  wasRewritten: boolean;
  usedImmediateContext: boolean;
  mode: 'skipped_clear' | 'rewritten' | 'fallback_original';
}

interface RewriteTelemetry {
  totalRequests: number;
  skippedClear: number;
  rewritten: number;
  rewrittenWithImmediateContext: number;
  fallbackToOriginal: number;
  fallbackDueToError: number;
  fallbackDueToRateLimit: number;
  fallbackDueToWeak: number;
  fallbackDueToTruncated: number;
  structuredParseSuccess: number;
  zeroHitAfterRewrite: number;
  searchFallbackAttempts: number;
  searchFallbackRecovered: number;
}

const STAGE_TIMEOUT_MS = {
  sessionLookup: 8000,
  historyLookup: 8000,
};
const SESSION_WARM_CACHE_TTL_MS = 2 * 60 * 1000;
const EMBEDDING_CACHE_TTL_MS = 10 * 60 * 1000;
const RETRIEVAL_WARMUP_EMBEDDING_TTL_MS = 10 * 60 * 1000;
const RETRIEVAL_WARMUP_PROBE_TEXT = 'retrieval warmup probe';
const MAX_EMBEDDING_CACHE_ENTRIES = 24;

const withStageTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  stageName: string
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${stageName} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export class ChatPipeline {
  private indexedDBServices = getIndexedDBServices();
  private sessionWarmCache = new Map<string, SessionWarmCacheEntry>();
  private documentEmbeddingCache = new Map<string, DocumentEmbeddingCacheEntry>();
  private retrievalWarmupEmbeddingCache: RetrievalWarmupEmbeddingCacheEntry | null = null;
  private lastRetrievalAnchorWindowDebug: RetrievalAnchorWindowDebug | null = null;
  private lastGenerationPageSelectionDebug: GenerationPageSelectionDebug | null = null;
  private rewriteTelemetry: RewriteTelemetry = {
    totalRequests: 0,
    skippedClear: 0,
    rewritten: 0,
    rewrittenWithImmediateContext: 0,
    fallbackToOriginal: 0,
    fallbackDueToError: 0,
    fallbackDueToRateLimit: 0,
    fallbackDueToWeak: 0,
    fallbackDueToTruncated: 0,
    structuredParseSuccess: 0,
    zeroHitAfterRewrite: 0,
    searchFallbackAttempts: 0,
    searchFallbackRecovered: 0,
  };

  private buildEnabledDocSignature(documentIds: string[]): string {
    return [...documentIds].sort().join('|');
  }

  private isFresh(timestamp: number, ttlMs: number): boolean {
    return Date.now() - timestamp < ttlMs;
  }

  private getEmbeddingCacheKey(sessionId: string, documentId: string): string {
    return `${sessionId}:${documentId}`;
  }

  private pruneEmbeddingCache(maxEntries: number = MAX_EMBEDDING_CACHE_ENTRIES): void {
    if (this.documentEmbeddingCache.size <= maxEntries) return;

    const sorted = Array.from(this.documentEmbeddingCache.entries())
      .sort((a, b) => a[1].loadedAt - b[1].loadedAt);
    const overflow = this.documentEmbeddingCache.size - maxEntries;

    for (let i = 0; i < overflow; i++) {
      this.documentEmbeddingCache.delete(sorted[i][0]);
    }
  }

  private async getCachedEmbeddingsForDocuments(sessionId: string, documentIds: string[]): Promise<EmbeddingChunk[]> {
    const uniqueDocIds = Array.from(new Set(documentIds.filter(Boolean)));
    if (uniqueDocIds.length === 0) return [];

    const now = Date.now();
    const combined: EmbeddingChunk[] = [];
    const missingDocIds: string[] = [];

    for (const documentId of uniqueDocIds) {
      const key = this.getEmbeddingCacheKey(sessionId, documentId);
      const cached = this.documentEmbeddingCache.get(key);

      if (cached && this.isFresh(cached.loadedAt, EMBEDDING_CACHE_TTL_MS)) {
        combined.push(...cached.embeddings);
        continue;
      }

      if (cached) {
        this.documentEmbeddingCache.delete(key);
      }
      missingDocIds.push(documentId);
    }

    if (missingDocIds.length > 0) {
      const fetchedByDoc = await Promise.all(
        missingDocIds.map(async (documentId) => {
          const embeddings = await this.indexedDBServices.embeddingService.getEmbeddingsByDocument(documentId);
          return { documentId, embeddings };
        })
      );

      for (const { documentId, embeddings } of fetchedByDoc) {
        const key = this.getEmbeddingCacheKey(sessionId, documentId);
        this.documentEmbeddingCache.set(key, {
          embeddings,
          loadedAt: now,
        });
        combined.push(...embeddings);
      }

      this.pruneEmbeddingCache();
    }

    return combined;
  }

  private async getEmbeddingsForRetrievedDocs(
    sessionId: string,
    baseResults: VectorSearchResult[]
  ): Promise<EmbeddingChunk[]> {
    if (baseResults.length === 0) return [];
    const docIds = baseResults.map((result) => result.document.id);
    return this.getCachedEmbeddingsForDocuments(sessionId, docIds);
  }

  private async getHasEnabledEmbeddingsFast(sessionId: string, enabledDocIds: string[]): Promise<boolean> {
    if (enabledDocIds.length === 0) {
      return false;
    }

    const enabledDocSignature = this.buildEnabledDocSignature(enabledDocIds);
    const warm = this.sessionWarmCache.get(sessionId);

    if (
      warm &&
      warm.enabledDocSignature === enabledDocSignature &&
      this.isFresh(warm.warmedAt, SESSION_WARM_CACHE_TTL_MS)
    ) {
      return warm.hasAnyEmbeddings;
    }

    const hasAnyEmbeddings = await this.indexedDBServices.embeddingService.hasAnyEmbeddingsForDocuments(enabledDocIds);
    this.sessionWarmCache.set(sessionId, {
      enabledDocSignature,
      hasAnyEmbeddings,
      warmedAt: Date.now(),
    });
    return hasAnyEmbeddings;
  }

  private isLibrarySourcePath(path?: string): boolean {
    return typeof path === 'string' && path.startsWith('library:');
  }

  private isLibraryCacheLinkDocument(document: Document): boolean {
    return typeof document.storedPath === 'string' && document.storedPath.startsWith('library-cache-ref:');
  }

  private async resolveRetrievalDocuments(
    userId: string,
    enabledDocuments: Document[]
  ): Promise<Document[]> {
    if (enabledDocuments.length === 0) return [];

    const hasLibraryDocuments = enabledDocuments.some((doc) => this.isLibrarySourcePath(doc.originalPath));
    if (!hasLibraryDocuments) {
      return enabledDocuments;
    }

    const allUserDocuments = await this.indexedDBServices.documentService.getAllDocumentsForUser(userId);
    const byLibrarySource = new Map<string, Document[]>();

    for (const doc of allUserDocuments) {
      if (!this.isLibrarySourcePath(doc.originalPath)) continue;
      const key = doc.originalPath as string;
      const existing = byLibrarySource.get(key);
      if (existing) {
        existing.push(doc);
      } else {
        byLibrarySource.set(key, [doc]);
      }
    }

    const embeddingPresenceCache = new Map<string, boolean>();
    const hasEmbeddings = async (documentId: string): Promise<boolean> => {
      if (embeddingPresenceCache.has(documentId)) {
        return embeddingPresenceCache.get(documentId) as boolean;
      }
      const present = await this.indexedDBServices.embeddingService.hasAnyEmbeddingsForDocuments([documentId]);
      embeddingPresenceCache.set(documentId, present);
      return present;
    };

    const resolvedById = new Map<string, Document>();

    for (const enabledDoc of enabledDocuments) {
      if (!this.isLibrarySourcePath(enabledDoc.originalPath)) {
        resolvedById.set(enabledDoc.id, enabledDoc);
        continue;
      }

      const libraryKey = enabledDoc.originalPath as string;
      const candidates = byLibrarySource.get(libraryKey) || [enabledDoc];
      const rankedCandidates = [...candidates].sort((a, b) => {
        if (a.id === enabledDoc.id && b.id !== enabledDoc.id) return -1;
        if (b.id === enabledDoc.id && a.id !== enabledDoc.id) return 1;
        if (a.status === 'completed' && b.status !== 'completed') return -1;
        if (b.status === 'completed' && a.status !== 'completed') return 1;
        if (!this.isLibraryCacheLinkDocument(a) && this.isLibraryCacheLinkDocument(b)) return -1;
        if (!this.isLibraryCacheLinkDocument(b) && this.isLibraryCacheLinkDocument(a)) return 1;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

      let chosen: Document | null = null;
      for (const candidate of rankedCandidates) {
        if (await hasEmbeddings(candidate.id)) {
          chosen = candidate;
          break;
        }
      }

      const fallback = rankedCandidates[0] || enabledDoc;
      const selected = chosen || fallback;
      resolvedById.set(selected.id, selected);
    }

    const resolved = Array.from(resolvedById.values());
    console.log(
      '[RETRIEVAL DOC RESOLUTION] enabled=%d resolved=%d libraryEnabled=%d',
      enabledDocuments.length,
      resolved.length,
      enabledDocuments.filter((doc) => this.isLibrarySourcePath(doc.originalPath)).length
    );
    return resolved;
  }

  private async getWarmupEmbeddingVector(): Promise<Float32Array | null> {
    const cached = this.retrievalWarmupEmbeddingCache;
    if (cached && this.isFresh(cached.warmedAt, RETRIEVAL_WARMUP_EMBEDDING_TTL_MS)) {
      return cached.embedding;
    }

    try {
      const embedding = await embeddingService.generateEmbedding(RETRIEVAL_WARMUP_PROBE_TEXT);
      this.retrievalWarmupEmbeddingCache = {
        embedding,
        warmedAt: Date.now(),
      };
      return embedding;
    } catch (error) {
      console.warn('[PRELOAD] Embedding warm-up probe failed:', error);
      return null;
    }
  }

  async preloadSessionRetrievalData(sessionId: string): Promise<void> {
    if (!sessionId) return;

    const warm = this.sessionWarmCache.get(sessionId);
    if (warm && this.isFresh(warm.warmedAt, SESSION_WARM_CACHE_TTL_MS)) {
      return;
    }

    const session = await this.indexedDBServices.sessionService.getSession(sessionId);
    if (!session) return;

    const enabledDocuments = await this.indexedDBServices.documentService.getEnabledDocumentsBySession(
      sessionId,
      session.userId
    );
    const retrievalDocuments = await this.resolveRetrievalDocuments(session.userId, enabledDocuments);
    const enabledDocIds = retrievalDocuments.map((doc) => doc.id);
    const enabledDocSignature = this.buildEnabledDocSignature(enabledDocIds);
    const hasAnyEmbeddings = enabledDocIds.length > 0
      ? await this.indexedDBServices.embeddingService.hasAnyEmbeddingsForDocuments(enabledDocIds)
      : false;

    this.sessionWarmCache.set(sessionId, {
      enabledDocSignature,
      hasAnyEmbeddings,
      warmedAt: Date.now(),
    });

    const routeWarmupPromise = Promise.all(
      enabledDocIds.map(async (documentId) => {
        try {
          await this.indexedDBServices.routeIndexService.loadRouteIndexForDocument(documentId);
        } catch (error) {
          console.warn('[PRELOAD] Route index warm-up failed for document:', documentId, error);
        }
      })
    );

    const retrievalWarmupPromise = hasAnyEmbeddings
      ? (async () => {
        const warmupEmbedding = await this.getWarmupEmbeddingVector();
        await vectorSearchService.prewarmSessionRetrieval(sessionId, {
          documentIds: enabledDocIds,
          warmupEmbedding: warmupEmbedding || undefined,
        });
      })()
      : Promise.resolve();

    await Promise.all([routeWarmupPromise, retrievalWarmupPromise]);
  }

  invalidateSessionRetrievalCache(sessionId: string): void {
    this.sessionWarmCache.delete(sessionId);

    const prefix = `${sessionId}:`;
    for (const key of this.documentEmbeddingCache.keys()) {
      if (key.startsWith(prefix)) {
        this.documentEmbeddingCache.delete(key);
      }
    }
  }

  invalidateDocumentRetrievalCache(sessionId: string, documentId: string): void {
    this.sessionWarmCache.delete(sessionId);
    this.documentEmbeddingCache.delete(this.getEmbeddingCacheKey(sessionId, documentId));
  }

  /**
   * Enhance user query with context information
   */
  private async enhanceQueryWithContext(sessionId: string, content: string, queryIntent?: QueryIntent): Promise<string> {
    try {
      console.log('\n=== QUERY ENHANCEMENT PROCESS START ===');
      console.log('[ORIGINAL QUERY]', content);

      // Get session information
      const session = await this.indexedDBServices.sessionService.getSession(sessionId);
      const sessionName = session?.name || 'Unknown Session';
      console.log('[SESSION INFO]', `Name: ${sessionName}, ID: ${sessionId}`);

      // Get enabled documents for the session
      if (!session) {
        console.log('[CONTEXT ENHANCEMENT]', 'Session not found - returning original query');
        console.log('=== QUERY ENHANCEMENT PROCESS END ===\n');
        return content;
      }
      const enabledDocuments = await this.indexedDBServices.documentService.getEnabledDocumentsBySession(sessionId, session.userId);
      console.log('[DOCUMENTS FOUND]', `${enabledDocuments.length} enabled documents`);

      // Extract document names (use title if available, otherwise filename)
      const documentNames = enabledDocuments.map(doc => doc.title || doc.filename).filter(Boolean);

      // If no documents are enabled, return the original query
      if (documentNames.length === 0) {
        console.log('[CONTEXT ENHANCEMENT]', 'No enabled documents found - returning original query');
        console.log('=== QUERY ENHANCEMENT PROCESS END ===\n');
        return content;
      }

      // Format the related documents string
      const relatedDocuments = documentNames.join(', ');
      console.log('[CONTEXT DOCUMENTS]', relatedDocuments);

      // Create the enhanced query with context — use document names only.
      // Session name is intentionally excluded: a session named "drugs" would
      // contaminate the embedding for unrelated queries like "sepsis management".
      const retrievalHints = this.buildRetrievalHints(content, queryIntent);
      const enhancedQuery = `${content} [Context - related to ${relatedDocuments}]${retrievalHints}`;

      console.log('[ENHANCED QUERY]', enhancedQuery);
      console.log('=== QUERY ENHANCEMENT PROCESS END ===\n');

      return enhancedQuery;
    } catch (error) {
      console.error('[CONTEXT ENHANCEMENT ERROR]', error);
      console.log('=== QUERY ENHANCEMENT PROCESS END (WITH ERROR) ===\n');
      // If there's an error, return the original query
      return content;
    }
  }

  private shouldUseExpandedRetrieval(query: string, queryIntent?: QueryIntent): boolean {
    const normalized = (query || '').toLowerCase();
    const wordCount = normalized.split(/\s+/).filter(Boolean).length;

    if (queryIntent !== 'generic_fallback' && queryIntent !== 'position_location') {
      return false;
    }

    return (
      wordCount <= 8 ||
      /\b(when|what|how|which|where|why)\b/.test(normalized) ||
      /\b(trigger|threshold|criteria|indication|indications|levels?|table|figure|summary box|box)\b/.test(normalized)
    );
  }

  private buildRetrievalHints(query: string, queryIntent?: QueryIntent): string {
    if (!this.shouldUseExpandedRetrieval(query, queryIntent)) {
      return '';
    }

    const normalized = (query || '').toLowerCase();
    const hints: string[] = [];

    if (/\b(blood|transfus|haemoglobin|hemoglobin|hb|anaemi|anemi)\b/.test(normalized)) {
      hints.push('Hb threshold', 'transfusion criteria', 'g/dL');
    }

    if (queryIntent === 'position_location' || /\b(position|positions|location|locations|anatomical|where)\b/.test(normalized)) {
      hints.push('anatomy', 'anatomical position', 'location', 'figure', 'figure caption', 'overview');
    }

    hints.push('table', 'summary box', 'figure caption', 'criteria list');

    const dedupedHints = Array.from(new Set(hints));
    return ` [Retrieval hints: ${dedupedHints.join(', ')}]`;
  }

  private normalizeCommonMedicalTypos(text: string): string {
    return text
      .replace(/\bmanamgnet\b/gi, 'management')
      .replace(/\bmanagment\b/gi, 'management')
      .replace(/\bmanagemnt\b/gi, 'management')
      .replace(/\btrematnet\b/gi, 'treatment')
      .replace(/\btretment\b/gi, 'treatment')
      .replace(/\buclers\b/gi, 'ulcers')
      .replace(/\bulser\b/gi, 'ulcer')
      .replace(/\bsings\b/gi, 'signs')
      .replace(/\binflammed\b/gi, 'inflamed')
      .replace(/\bpiotiosnt\b/gi, 'positions')
      .replace(/\bpiotiosnts\b/gi, 'positions')
      .replace(/\bpotisions\b/gi, 'positions')
      .replace(/\bpoistions\b/gi, 'positions')
      .replace(/\bopistions\b/gi, 'positions')
      .replace(/\bliek\b/gi, 'like')
      .replace(/\boft\s+he\b/gi, 'of the')
      .replace(/\bchoelcytitisi\b/gi, 'cholecystitis')
      .replace(/\bchoelcystitis\b/gi, 'cholecystitis')
      .replace(/\bcholecytitis\b/gi, 'cholecystitis')
      .replace(/\bposiitiosn\b/gi, 'positions')
      .replace(/\bposiitiosns\b/gi, 'positions')
      .replace(/\bposiitoin\b/gi, 'position')
      .replace(/\bdiffren(?:t|ti)ate\b/gi, 'differentiate');
  }

  private isLikelyTruncatedRewrite(rewritten: string, original: string): boolean {
    const rewrittenNorm = (rewritten || '').trim().toLowerCase();
    const originalNorm = (original || '').trim().toLowerCase();
    if (!rewrittenNorm || !originalNorm) return false;

    // Reject obvious clipped endings like "types of ch".
    if (/\bof\s+[a-z]{1,2}$/.test(rewrittenNorm)) {
      return true;
    }

    // If rewrite is much shorter and ends with a tiny token, treat as truncation.
    const rewrittenWords = rewrittenNorm.split(/\s+/).filter(Boolean);
    const originalWords = originalNorm.split(/\s+/).filter(Boolean);
    const lastWord = rewrittenWords[rewrittenWords.length - 1] || '';
    if (
      rewrittenWords.length >= 2 &&
      originalWords.length >= 3 &&
      rewrittenNorm.length < Math.max(10, Math.floor(originalNorm.length * 0.7)) &&
      lastWord.length <= 2
    ) {
      return true;
    }

    return false;
  }

  private sanitizeRewriterOutput(raw: string): string {
    const firstLine = raw
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) || '';

    return firstLine
      .replace(/^standalone\s+query\s*:\s*/i, '')
      .replace(/^rewritten\s+query\s*:\s*/i, '')
      .replace(/^[-*]\s+/, '')
      .replace(/^["'`]|["'`]$/g, '')
      .trim();
  }

  private parseStructuredRewriteOutput(raw: string): string {
    const trimmed = (raw || '').trim();
    if (!trimmed) return '';

    const directJson = this.tryParseRewriteJson(trimmed);
    if (directJson) {
      this.rewriteTelemetry.structuredParseSuccess += 1;
      return directJson;
    }

    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
      const fencedJson = this.tryParseRewriteJson(fencedMatch[1].trim());
      if (fencedJson) {
        this.rewriteTelemetry.structuredParseSuccess += 1;
        return fencedJson;
      }
    }

    const objectMatch = trimmed.match(/\{[\s\S]*\}/);
    if (objectMatch?.[0]) {
      const objectJson = this.tryParseRewriteJson(objectMatch[0]);
      if (objectJson) {
        this.rewriteTelemetry.structuredParseSuccess += 1;
        return objectJson;
      }
    }

    // Fallback for non-JSON model outputs.
    return this.sanitizeRewriterOutput(trimmed);
  }

  private tryParseRewriteJson(jsonText: string): string | null {
    try {
      const parsed = JSON.parse(jsonText) as { query?: unknown };
      if (typeof parsed?.query !== 'string') return null;
      const cleaned = this.sanitizeRewriterOutput(parsed.query);
      return cleaned || null;
    } catch {
      return null;
    }
  }

  private buildRewriteQueryResponse(query: string): string {
    return JSON.stringify({ query });
  }

  private logRewriteTelemetrySummary(): void {
    const t = this.rewriteTelemetry;
    const safePct = (num: number, den: number) => den > 0 ? Number(((num / den) * 100).toFixed(1)) : 0;

    console.log('[QUERY REWRITER METRICS]', {
      total_requests: t.totalRequests,
      skipped_clear: t.skippedClear,
      rewritten: t.rewritten,
      rewritten_with_immediate_context: t.rewrittenWithImmediateContext,
      fallback_to_original: t.fallbackToOriginal,
      fallback_error: t.fallbackDueToError,
      fallback_rate_limit: t.fallbackDueToRateLimit,
      fallback_weak: t.fallbackDueToWeak,
      fallback_truncated: t.fallbackDueToTruncated,
      structured_parse_success: t.structuredParseSuccess,
      zero_hit_after_rewrite: t.zeroHitAfterRewrite,
      search_fallback_attempts: t.searchFallbackAttempts,
      search_fallback_recovered: t.searchFallbackRecovered,
      rewrite_fallback_rate_pct: safePct(t.fallbackToOriginal, t.totalRequests),
      zero_hit_after_rewrite_rate_pct: safePct(t.zeroHitAfterRewrite, Math.max(1, t.rewritten)),
      search_fallback_recovery_rate_pct: safePct(t.searchFallbackRecovered, Math.max(1, t.searchFallbackAttempts)),
    });
  }

  private isPronounTopic(topic: string): boolean {
    const normalized = topic.trim().toLowerCase();
    return ['it', 'this', 'that', 'these', 'those', 'them', 'they', 'their', 'its'].includes(normalized);
  }

  private sanitizeExtractedTopic(rawTopic: string): string | null {
    const topic = rawTopic
      .replace(/^(the|a|an)\s+/i, '')
      .replace(/\s+(?:and|with)\s+(?:their|its|the)\b.*$/i, '')
      .replace(/[?!.]+$/g, '')
      .trim();

    if (!topic) return null;
    if (this.isPronounTopic(topic)) return null;
    return topic;
  }

  private normalizeStandaloneQueryShape(query: string): string {
    let normalized = (query || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return normalized;

    normalized = this.normalizeCommonMedicalTypos(normalized);

    // Remove dangling truncated punctuation from model outputs.
    while (/[([{<"'`]\s*$/.test(normalized)) {
      normalized = normalized.slice(0, -1).trim();
    }
    normalized = normalized.replace(/[:;,\-]\s*$/g, '').trim();

    // Common anatomy phrasing cleanup.
    normalized = normalized.replace(/\bo\s*clock\s+pos(?:ition|itions)\b/gi, 'positions');
    normalized = normalized.replace(/\blike\s+o\s*clock\b/gi, 'in o clock positions');
    normalized = normalized.replace(/\bo\s*clock\b/gi, 'o clock positions');
    normalized = normalized.replace(/\bpositions?\s+of\s+the\s+appendix\b/gi, 'positions of appendix');
    normalized = normalized.replace(/\bpositions?\s+of\s+appendix\s+in\s+o\s*clock\s+positions\b/gi, 'positions of appendix');
    normalized = normalized.replace(
      /^locations?\s+of\s+(.+?)\s+as\s+in\s+positions$/i,
      'positions of $1'
    );
    normalized = normalized.replace(
      /^what\s+are\s+(?:the\s+)?positions?\s+of\s+appendix(?:\s+in\s+o\s*clock\s+positions)?$/i,
      'what are the positions of appendix'
    );

    normalized = normalized.replace(/\s+/g, ' ').trim();
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  private hasExplicitNonClinicalFeatureFacet(query: string): boolean {
    const normalized = (query || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) return false;

    return /\b(investigations?|investigation|imaging|image|radiolog(?:y|ical)?|ct|mri|x-?ray|ultra(?:sound|sonography)|scan|diagnos(?:is|tic)?|management|treatment|therapy|surg(?:ery|ical)?|classification|types?|causes?|etiolog(?:y|ical)?|complications?|pathophysiolog(?:y|ical)?|prognos(?:is|tic)?)\b/.test(normalized);
  }

  private shouldExpandToClinicalHistoryAndExam(query: string): boolean {
    const normalized = (query || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) return false;
    if (!/\b(clinical features?|features?)\b/.test(normalized)) return false;
    return !this.hasExplicitNonClinicalFeatureFacet(normalized);
  }

  private buildClinicalFeaturesHistoryExamRewrite(topic: string): string {
    return `What are the clinical features, including patient history and physical examination findings, of ${topic}?`;
  }

  private enforceRewriteScope(
    originalQuery: string,
    rewrittenQuery: string,
    immediateRewriteQuery: string | null
  ): string {
    if (!this.shouldExpandToClinicalHistoryAndExam(originalQuery)) {
      return rewrittenQuery;
    }

    const topic =
      this.extractTopicFromClarifiedQuery(rewrittenQuery) ||
      this.extractTopicFromQuery(rewrittenQuery) ||
      this.extractTopicFromClarifiedQuery(originalQuery) ||
      this.extractTopicFromQuery(originalQuery) ||
      (immediateRewriteQuery
        ? (this.extractTopicFromClarifiedQuery(immediateRewriteQuery) || this.extractTopicFromQuery(immediateRewriteQuery))
        : null);

    if (!topic) {
      return rewrittenQuery;
    }

    const enforced = this.buildClinicalFeaturesHistoryExamRewrite(topic);
    if (enforced.toLowerCase() !== rewrittenQuery.toLowerCase()) {
      console.log('[QUERY REWRITER SCOPE GUARD]', {
        reason: 'clinical_features_to_history_and_exam_only',
        originalQuery,
        rewrittenQuery,
        enforcedQuery: enforced,
      });
    }

    return enforced;
  }

  private extractMostRecentClarifiedQuery(history: any[]): string | null {
    const assistantMessages = (history || [])
      .filter((msg) => msg?.role === 'assistant' && typeof msg?.content === 'string')
      .map((msg) => msg.content as string);

    for (let i = assistantMessages.length - 1; i >= 0; i--) {
      const content = assistantMessages[i];
      const match = content.match(/\*\*Answer for:\*\*\s*"([^"]+)"/i)
        || content.match(/Answer for:\s*"([^"]+)"/i);
      const clarified = match?.[1]?.trim();
      const normalizedClarified = clarified ? this.normalizeStandaloneQueryShape(clarified) : '';
      if (normalizedClarified) {
        return normalizedClarified;
      }
    }

    return null;
  }

  private extractMostRecentAnswerForLine(history: any[]): string | null {
    const assistantMessages = (history || [])
      .filter((msg) => msg?.role === 'assistant' && typeof msg?.content === 'string')
      .map((msg) => msg.content as string);

    for (let i = assistantMessages.length - 1; i >= 0; i--) {
      const content = assistantMessages[i];
      const match = content.match(/(?:\*\*Answer for:\*\*|Answer for:)\s*"[^"\n]*"/i);
      if (match?.[0]) {
        return match[0].replace(/\*\*/g, '').trim();
      }
    }

    return null;
  }

  private extractMostRecentTopicClarifiedQuery(history: any[]): string | null {
    const assistantMessages = (history || [])
      .filter((msg) => msg?.role === 'assistant' && typeof msg?.content === 'string')
      .map((msg) => msg.content as string);

    for (let i = assistantMessages.length - 1; i >= 0; i--) {
      const content = assistantMessages[i];
      const match = content.match(/\*\*Answer for:\*\*\s*"([^"]+)"/i)
        || content.match(/Answer for:\s*"([^"]+)"/i);
      const clarified = match?.[1]?.trim();
      if (!clarified) continue;

      const normalizedClarified = this.normalizeStandaloneQueryShape(clarified);
      if (!normalizedClarified) continue;

      const topic = this.extractTopicFromClarifiedQuery(normalizedClarified);
      if (topic) {
        return normalizedClarified;
      }
    }

    return null;
  }

  private isLikelyContextContinuation(query: string): boolean {
    const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) return false;

    // Clear continuation signals (pronouns / referential phrases).
    if (/\b(it|its|this|that|these|those|they|them|their|same|above|previous|former|latter)\b/.test(normalized)) {
      return true;
    }

    if (/^(and|also)\b/.test(normalized)) return true;
    if (/\b(of it|for it|about it)\b/.test(normalized)) return true;
    if (/^(what about|how about)\b/.test(normalized)) return true;

    return false;
  }

  private extractPreviousUserQuery(
    history: any[],
    currentQuery: string
  ): string | null {
    const normalizedCurrent = currentQuery.toLowerCase().replace(/\s+/g, ' ').trim();
    const userMessages = (history || [])
      .filter((msg) => msg?.role === 'user' && typeof msg?.content === 'string')
      .map((msg) => msg.content.trim())
      .filter((text) => text.length > 0);

    for (let i = userMessages.length - 1; i >= 0; i--) {
      const normalizedCandidate = userMessages[i].toLowerCase().replace(/\s+/g, ' ').trim();
      if (normalizedCandidate !== normalizedCurrent) {
        return userMessages[i];
      }
    }

    return null;
  }

  private extractTopicFromQuery(query: string): string | null {
    const cleaned = query
      .replace(/\s+/g, ' ')
      .replace(/[?!.]+$/g, '')
      .trim();
    if (!cleaned) return null;

    const ofPattern = /\b(?:types?|classification|histological\s+types?|indications?|causes?|features?|management|treatment|diagnosis|investigations?|definition|details)\s+of\s+(.+)$/i;
    const ofMatch = cleaned.match(ofPattern);
    if (ofMatch?.[1]) {
      return this.sanitizeExtractedTopic(ofMatch[1]);
    }

    const definePattern = /\b(?:what\s+is|define|explain)\s+(.+)$/i;
    const defineMatch = cleaned.match(definePattern);
    if (defineMatch?.[1]) {
      return this.sanitizeExtractedTopic(defineMatch[1]);
    }

    return null;
  }

  private extractTopicFromClarifiedQuery(clarifiedQuery: string): string | null {
    const fromKnownPatterns = this.extractTopicFromQuery(clarifiedQuery);
    if (fromKnownPatterns) return fromKnownPatterns;

    const cleaned = clarifiedQuery
      .replace(/\s+/g, ' ')
      .replace(/[?!.]+$/g, '')
      .trim();
    if (!cleaned) return null;

    const genericOfMatch = cleaned.match(/\bof\s+(.+)$/i);
    if (genericOfMatch?.[1]) {
      return this.sanitizeExtractedTopic(genericOfMatch[1]);
    }

    const betweenMatch = cleaned.match(/\bbetween\s+(.+?)\s+and\s+(.+)$/i);
    if (betweenMatch?.[1] && betweenMatch?.[2]) {
      return this.sanitizeExtractedTopic(`${betweenMatch[1]} and ${betweenMatch[2]}`);
    }

    // Heuristic for noun-phrase clarified queries without "of", e.g.
    // "appendix anatomical positions relative to colon" -> "appendix".
    const normalized = cleaned
      .toLowerCase()
      .replace(/\b(relative to|regarding|about|in relation to)\b.*$/i, '')
      .replace(/\b(anatomical|clinical|different|common|major|normal|abnormal)\b/gi, ' ')
      .replace(/\b(positions?|location|locations?|position|types?|classification|signs?|symptoms?|causes?|management|treatment|diagnosis|pathophysiology|components?|features?|characteristics?)\b/gi, ' ')
      .replace(/[^\w\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (normalized) {
      const stopwords = new Set([
        'the', 'a', 'an', 'of', 'for', 'to', 'with', 'and', 'or', 'in', 'on', 'at', 'by', 'from',
        'what', 'is', 'are', 'if', 'it', 'this', 'that', 'these', 'those'
      ]);
      const tokens = normalized.split(' ').filter((token) => token.length > 1 && !stopwords.has(token));
      if (tokens.length > 0) {
        return this.sanitizeExtractedTopic(tokens[0]);
      }
    }

    return null;
  }

  private buildContextualRewriteFallback(
    originalQuery: string,
    mostRecentClarifiedQuery: string | null
  ): string | null {
    if (!mostRecentClarifiedQuery) return null;

    const topic = this.extractTopicFromClarifiedQuery(mostRecentClarifiedQuery);
    if (!topic) return null;

    const normalizedOriginal = originalQuery
      .replace(/\s+/g, ' ')
      .replace(/[?!.]+$/g, '')
      .trim();
    if (!normalizedOriginal) return null;

    const isContinuation =
      this.isLikelyContextContinuation(normalizedOriginal) ||
      this.isLikelyFacetFollowUp(normalizedOriginal);
    if (!isContinuation) return null;

    // If the user already specifies a concrete topic, do not override.
    if (/\bof\s+(?!it\b|this\b|that\b|these\b|those\b|them\b)[a-z0-9]/i.test(normalizedOriginal)) {
      return null;
    }

    const replacedPronouns = normalizedOriginal
      .replace(/\bof\s+(it|this|that|these|those|them)\b/gi, `of ${topic}`)
      .replace(/\b(for|about)\s+(it|this|that|these|those|them)\b/gi, `$1 ${topic}`)
      .replace(/\b(it|this|that|these|those|them)\b/gi, topic)
      .replace(/\s+/g, ' ')
      .trim();

    const containsTopic = replacedPronouns.toLowerCase().includes(topic.toLowerCase());
    const fallback = containsTopic
      ? replacedPronouns
      : `${replacedPronouns} of ${topic}`.replace(/\s+/g, ' ').trim();

    return this.normalizeStandaloneQueryShape(fallback);
  }

  private isLikelyFacetFollowUp(query: string): boolean {
    const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) return false;
    const wordCount = normalized.split(' ').filter(Boolean).length;
    if (wordCount > 5) return false;

    const facetPattern = /\b(types?|classification|histolog(?:y|ical)|causes?|features?|signs?|symptoms?|management|treatment|indications?|diagnosis|investigations?|definition|complications?)\b/;
    return facetPattern.test(normalized);
  }

  private applyContinuationFallback(
    rewrittenQuery: string,
    originalQuery: string,
    previousUserQuery: string | null
  ): string {
    if (!previousUserQuery) return rewrittenQuery;

    const topic = this.extractTopicFromQuery(previousUserQuery);
    if (!topic) return rewrittenQuery;

    const normalizedRewritten = rewrittenQuery.toLowerCase();
    const normalizedTopic = topic.toLowerCase();

    // If topic already present, keep as-is.
    if (normalizedRewritten.includes(normalizedTopic)) {
      return rewrittenQuery;
    }

    // If query explicitly names another subject using "of ...", do not override.
    if (/\bof\s+[a-z0-9]/i.test(rewrittenQuery)) {
      return rewrittenQuery;
    }

    const shouldApply = this.isLikelyContextContinuation(originalQuery) || this.isLikelyFacetFollowUp(originalQuery);
    if (!shouldApply) return rewrittenQuery;

    const resolved = `${rewrittenQuery} of ${topic}`.replace(/\s+/g, ' ').trim();
    console.log('[QUERY REWRITER CONTEXT]', `Continuation fallback applied: "${rewrittenQuery}" -> "${resolved}"`);
    return resolved;
  }

  private isInsufficientEvidenceResponse(text: string): boolean {
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) return false;

    // If the response already contains inline citations, we treat it as a mixed
    // answer rather than a pure refusal. This prevents section-level
    // "Not found in provided sources" fallbacks from wiping out valid refs.
    if (this.hasInlineCitations(normalized)) {
      return false;
    }

    return (
      normalized.includes('i cannot answer this question based on the provided documents') ||
      normalized.includes('cannot answer this question based on the provided documents') ||
      normalized.includes('not found in provided sources') ||
      normalized.includes('insufficient information in the provided documents') ||
      normalized.includes('not enough information in the provided documents')
    );
  }

  private extractRateLimitNotice(text: string): string | null {
    const normalized = (text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return null;

    const looksRateLimited =
      /too many questions too fast/i.test(normalized) ||
      /high traffic/i.test(normalized) ||
      /please wait for \d+\s*seconds?/i.test(normalized) ||
      /try again soon/i.test(normalized) ||
      /\b429\b/i.test(normalized);

    if (!looksRateLimited) return null;

    // Keep provider wait-time if present.
    const waitMatch = normalized.match(/please wait for \d+\s*seconds?/i);
    if (waitMatch) {
      return `⚠️ ${waitMatch[0].charAt(0).toUpperCase()}${waitMatch[0].slice(1)} before asking again.`;
    }

    if (/high traffic/i.test(normalized) || /try again soon/i.test(normalized)) {
      return '⚠️ We are experiencing high traffic right now. Please try again in a few seconds.';
    }

    return '⚠️ You are asking too many questions too fast. Please wait for a few seconds and try again.';
  }

  private hasInlineCitations(text: string): boolean {
    if (!text) return false;
    return /\[\s*\d+(?:\s*,\s*\d+)*[^\]]*\]/.test(text);
  }

  private removeUncitedSubstantiveLines(text: string): { content: string; kept: number; dropped: number } {
    const blocks = text
      .split(/\n\s*\n/g)
      .map((b) => b.trim())
      .filter((b) => b.length > 0);

    const keptBlocks: string[] = [];
    let dropped = 0;

    const isStructuralBlock = (block: string): boolean => {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) return true;

      return lines.every((line) =>
        /^#{1,6}\s/.test(line) ||
        /^\*\*[^*]+\*\*:?\s*$/.test(line) ||
        /^✅\s+\*\*.+\*\*:?\s*$/.test(line) ||
        /^[-*•]\s*$/.test(line) ||
        /^\d+\.\s*$/.test(line) ||
        /^---+$/.test(line) ||
        line.endsWith(':')
      );
    };

    const isCitationOnlyBlock = (block: string): boolean => {
      const compact = block.replace(/\s+/g, ' ').trim();
      if (!compact) return false;
      if (!/\[[^\]]+\]/.test(compact)) return false;

      const withoutCitations = compact
        .replace(/citation\s*:/gi, '')
        .replace(/\[[^\]]+\]/g, '')
        .replace(/[,\s]/g, '')
        .trim();

      return withoutCitations.length === 0;
    };

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const hasCitation = this.hasInlineCitations(block);
      const structural = isStructuralBlock(block);

      const textWithoutCitations = block
        .replace(/\[[^\]]+\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const wordCount = textWithoutCitations.split(/\s+/).filter(Boolean).length;
      const isSubstantive = textWithoutCitations.length >= 80 && wordCount >= 12;

      // Keep substantive blocks when a neighboring citation-only block supports them.
      const neighborHasCitationOnly =
        (i > 0 && isCitationOnlyBlock(blocks[i - 1])) ||
        (i < blocks.length - 1 && isCitationOnlyBlock(blocks[i + 1]));

      if (isSubstantive && !hasCitation && !structural && !neighborHasCitationOnly) {
        dropped += 1;
        continue;
      }

      keptBlocks.push(block);
    }

    return {
      content: keptBlocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim(),
      kept: keptBlocks.length,
      dropped,
    };
  }

  private getRouteBookCap(): number {
    if (typeof window !== 'undefined' && window.matchMedia) {
      const isPhone = window.matchMedia('(max-width: 768px)').matches;
      return isPhone ? 2 : 3;
    }
    return 3;
  }

  private scoreRouteSections(queryEmbedding: Float32Array, queryNorm: number, routeIndex: RouteIndexRecord): RouteSectionCandidate[] {
    return routeIndex.sections
      .filter((section) => section.vector.length === queryEmbedding.length && section.chunkIds.length > 0)
      .map((section) => ({
        score: cosineSimilarity(queryEmbedding, section.vector, queryNorm, 1),
        chunkIds: section.chunkIds
      }))
      .sort((a, b) => b.score - a.score);
  }

  private async buildRoutePrefilterPlan(
    enabledDocuments: Document[],
    queryEmbedding: Float32Array
  ): Promise<RoutePrefilterPlan> {
    if (enabledDocuments.length === 0) {
      return {};
    }

    const queryNorm = calculateVectorNorm(queryEmbedding);
    if (!Number.isFinite(queryNorm) || queryNorm <= 0) {
      return {};
    }

    const routeCandidates: RouteDocumentCandidate[] = [];
    const unroutedDocIds: string[] = [];

    for (const document of enabledDocuments) {
      const routeIndex = await this.indexedDBServices.routeIndexService.loadRouteIndexForDocument(document.id);
      if (!routeIndex || routeIndex.embeddingDimensions !== queryEmbedding.length) {
        unroutedDocIds.push(document.id);
        continue;
      }

      const bookScore = cosineSimilarity(queryEmbedding, routeIndex.bookVector, queryNorm, 1);
      const sectionCandidates = this.scoreRouteSections(queryEmbedding, queryNorm, routeIndex);

      routeCandidates.push({
        documentId: document.id,
        bookScore,
        sourceBin: routeIndex.sourceBin,
        sections: sectionCandidates
      });
    }

    if (routeCandidates.length === 0) {
      return {};
    }

    routeCandidates.sort((a, b) => b.bookScore - a.bookScore);
    const topScore = routeCandidates[0].bookScore;
    const secondScore = routeCandidates.length > 1 ? routeCandidates[1].bookScore : -1;
    const lowConfidence = topScore < 0.2 || (secondScore >= 0 && topScore - secondScore < 0.035);

    const baseCap = this.getRouteBookCap();
    const selectedRouted = routeCandidates.slice(0, lowConfidence ? baseCap + 2 : baseCap);
    const selectedDocIds = selectedRouted.map((candidate) => candidate.documentId);
    const allDocIds = [...selectedDocIds, ...unroutedDocIds];

    let allowedChunkIds: string[] | undefined;
    if (unroutedDocIds.length === 0) {
      const sectionCap = lowConfidence ? 8 : 5;
      const chunkIdSet = new Set<string>();
      for (const candidate of selectedRouted) {
        for (const section of candidate.sections.slice(0, sectionCap)) {
          for (const chunkId of section.chunkIds) {
            chunkIdSet.add(chunkId);
          }
        }
      }
      if (chunkIdSet.size > 0) {
        allowedChunkIds = Array.from(chunkIdSet);
      }
    }

    console.log(
      '[ROUTE PREFILTER] routedDocs=%d selectedDocs=%d unroutedDocs=%d lowConfidence=%s allowedChunks=%d',
      routeCandidates.length,
      allDocIds.length,
      unroutedDocIds.length,
      lowConfidence,
      allowedChunkIds?.length || 0
    );
    console.log(
      '[ROUTE PREFILTER DETAIL] selected=%o',
      selectedRouted.map((candidate) => ({
        documentId: candidate.documentId,
        sourceBin: candidate.sourceBin || 'unknown',
        bookScore: Number(candidate.bookScore.toFixed(4)),
        topSectionScore: candidate.sections[0] ? Number(candidate.sections[0].score.toFixed(4)) : null,
        sectionCount: candidate.sections.length
      }))
    );
    if (unroutedDocIds.length > 0) {
      console.log('[ROUTE PREFILTER DETAIL] unroutedDocs=%o (full-doc search fallback for these docs)', unroutedDocIds);
    }

    return {
      documentIds: allDocIds.length > 0 ? allDocIds : undefined,
      allowedChunkIds
    };
  }

  private getChunkPageNumber(chunk: EmbeddingChunk): number | null {
    if (chunk.page && chunk.page > 0) return chunk.page;
    if (chunk.metadata?.pageNumber && chunk.metadata.pageNumber > 0) return chunk.metadata.pageNumber;
    if (chunk.metadata?.pageNumbers && chunk.metadata.pageNumbers.length > 0) {
      const first = chunk.metadata.pageNumbers.find((p) => p > 0);
      if (first) return first;
    }
    return null;
  }

  private assessChunkQuality(chunk: EmbeddingChunk): ChunkQualityAssessment {
    const content = (chunk.content || '').replace(/\r\n/g, '\n').trim();
    if (!content) {
      return {
        score: 0,
        reasons: ['empty_content'],
        shouldExclude: true,
        exclusionType: 'other',
      };
    }

    const lines = content
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const words = content.split(/\s+/).filter(Boolean);
    const sentences = content
      .split(/(?<=[.!?])\s+|\n+/)
      .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
      .filter((sentence) => sentence.length >= 20);

    const reasons: string[] = [];
    let penalty = 0;

    const hasReferenceHeading = /\b(references?|bibliography|selected bibliography|further reading|reading list|reference list)\b/i.test(content);
    if (hasReferenceHeading) {
      penalty += 0.45;
      reasons.push('reference_heading');
    }

    const hasReferenceStyleMarkers =
      /\bet al\.\b/i.test(content) ||
      /\bdoi:/i.test(content) ||
      /\bpmid:\b/i.test(content) ||
      /\b(18|19|20)\d{2};\s*\d+:\s*\d+(?:[-–]\d+)?\b/.test(content);
    if (hasReferenceStyleMarkers) {
      penalty += 0.3;
      reasons.push('reference_style_markers');
    }

    const authorYearMatches = content.match(/(?:^|\n)\s*[A-Z][A-Za-z'’.-]+,\s*[A-Z][A-Za-z'’.-]+.*\b(18|19|20)\d{2}\b/g) || [];
    if (authorYearMatches.length >= 2) {
      penalty += 0.35;
      reasons.push('author_year_list');
    }

    const indexEntryMatches = content.match(/(?:^|[\n ])(?:[A-Z][A-Za-z0-9'’.-]+(?:,\s*[A-Za-z0-9'’.-]+)*\s+\d{1,4}(?:,\s*\d{1,4})*)/g) || [];
    const commaPageHits = (content.match(/,\s*\d{1,4}(?:\b|,)/g) || []).length;
    const pageLikeNumberHits = (content.match(/\b\d{3,4}\b/g) || []).length;
    const shortLineCount = lines.filter((line) => line.split(/\s+/).filter(Boolean).length <= 8).length;
    const listMarkerHits = (content.match(/[●○■]/g) || []).length;
    const headingLikeContent = lines.join(' ').replace(/[-:;]+/g, ' ').trim();

    if (indexEntryMatches.length >= 5 || commaPageHits >= 8) {
      penalty += 0.4;
      reasons.push('index_entry_density');
    }

    if (pageLikeNumberHits >= 20 && words.length >= 40) {
      penalty += 0.2;
      reasons.push('high_page_number_density');
    }

    if (lines.length >= 4 && shortLineCount / lines.length >= 0.7 && words.length >= 30) {
      penalty += 0.2;
      reasons.push('many_short_lines');
    }

    if (sentences.length <= 2 && words.length >= 45) {
      penalty += 0.15;
      reasons.push('too_few_sentences');
    }

    const hasLectureTitlePattern =
      /\b(prof|lecture|chapter|class|youtube|ppt|slide)\b/i.test(content) ||
      /\s-\s/.test(content);
    const isShortHeadingLike =
      words.length <= 12 &&
      lines.length <= 2 &&
      sentences.length <= 1 &&
      listMarkerHits === 0 &&
      !/\b\d+\b/.test(content) &&
      hasLectureTitlePattern &&
      headingLikeContent.length > 0;
    if (isShortHeadingLike) {
      penalty += 0.75;
      reasons.push('too_short_heading_like');
    }

    const figureOnlyPattern = /\b(?:figure|fig\.|table|plate|diagram)\b/i;
    const captionOnlyPattern = /\bsee (?:p\.|page)\b/i;
    if (
      figureOnlyPattern.test(content) &&
      (captionOnlyPattern.test(content) || words.length <= 50 || sentences.length <= 1)
    ) {
      penalty += 0.35;
      reasons.push('figure_or_table_caption_only');
    }

    const tocLikePattern = /(?:\.{3,}\s*\d{1,4}|\b(?:contents|index)\b)/i;
    if (tocLikePattern.test(content) && pageLikeNumberHits >= 8) {
      penalty += 0.25;
      reasons.push('toc_or_index_like');
    }

    if (indexEntryMatches.length >= 3 && pageLikeNumberHits >= 6) {
      penalty += 0.35;
      reasons.push('index_style_entry_density');
    }

    if (pageLikeNumberHits >= 12 && words.length >= 35) {
      penalty += 0.25;
      reasons.push('index_like_page_density');
    }

    const isClearlyIndexLike =
      indexEntryMatches.length >= 6 ||
      (commaPageHits >= 4 && pageLikeNumberHits >= 8) ||
      (pageLikeNumberHits >= 10 && sentences.length <= 1 && words.length >= 35);
    if (isClearlyIndexLike) {
      penalty += 0.6;
      reasons.push('clearly_index_like');
    }

    const score = Math.max(0, 1 - penalty);
    const shouldExclude = score < 0.45 && reasons.length > 0;
    const exclusionType = this.getChunkExclusionType(reasons);

    return {
      score,
      reasons,
      shouldExclude,
      exclusionType,
    };
  }

  private getChunkExclusionType(reasons: string[]): ChunkQualityAssessment['exclusionType'] {
    const reasonSet = new Set(reasons);
    const bibliographySignals = [
      'reference_heading',
      'reference_style_markers',
      'author_year_list',
    ];
    const weakFormattingSignals = [
      'many_short_lines',
    ];
    const indexSignals = [
      'index_entry_density',
      'high_page_number_density',
      'toc_or_index_like',
      'index_style_entry_density',
      'index_like_page_density',
      'clearly_index_like',
    ];
    const captionSignals = [
      'figure_or_table_caption_only',
    ];

    const hasAny = (signals: string[]) => signals.some((signal) => reasonSet.has(signal));
    const signalCount = [bibliographySignals, indexSignals, captionSignals].filter(hasAny).length;

    if (hasAny(bibliographySignals) && signalCount === 1) return 'bibliography';
    if (hasAny(indexSignals) && signalCount === 1) return 'index';
    if (hasAny(captionSignals) && signalCount === 1) return 'caption-only';
    if (hasAny(weakFormattingSignals) && signalCount === 0) return 'other';
    if (signalCount > 1) return 'mixed';
    return 'other';
  }

  private filterQualityChunks(
    chunks: VectorSearchResult[]
  ): {
    evaluated: Array<VectorSearchResult & { quality: ChunkQualityAssessment }>;
    kept: Array<VectorSearchResult & { quality: ChunkQualityAssessment }>;
    removed: Array<VectorSearchResult & { quality: ChunkQualityAssessment }>;
  } {
    const evaluated = chunks.map((chunk) => ({
      ...chunk,
      quality: this.assessChunkQuality(chunk.chunk),
    }));

    const kept: Array<VectorSearchResult & { quality: ChunkQualityAssessment }> = [];
    const removed: Array<VectorSearchResult & { quality: ChunkQualityAssessment }> = [];

    for (const chunk of evaluated) {
      const shouldKeepStructured = this.shouldRescueStructuredChunk(chunk);
      const shouldAlwaysDrop = this.shouldAlwaysDropAsJunk(chunk);

      if ((chunk.quality.shouldExclude && !shouldKeepStructured) || shouldAlwaysDrop) {
        removed.push(chunk);
        continue;
      }

      if (chunk.quality.shouldExclude && shouldKeepStructured) {
        console.log('[CHUNK QUALITY FILTER]', 'Keeping structured chunk despite low quality score.', {
          chunkId: chunk.chunk.id,
          page: this.getChunkPageNumber(chunk.chunk),
          documentTitle: chunk.document.title,
          exclusionType: chunk.quality.exclusionType,
          similarity: Number(chunk.similarity.toFixed(3)),
          score: Number(chunk.quality.score.toFixed(3)),
          reasons: chunk.quality.reasons,
        });
      }

      kept.push(chunk);
    }

    if (removed.length > 0) {
      console.log(
        '[CHUNK QUALITY FILTER]',
        `Removed ${removed.length} chunk(s) before generation.`
      );
      console.log(
        '[CHUNK QUALITY FILTER DETAIL]',
        removed.map((chunk) => ({
          chunkId: chunk.chunk.id,
          page: this.getChunkPageNumber(chunk.chunk),
          documentTitle: chunk.document.title,
          exclusionType: chunk.quality.exclusionType,
          similarity: Number(chunk.similarity.toFixed(3)),
          score: Number(chunk.quality.score.toFixed(3)),
          reasons: chunk.quality.reasons,
          content: chunk.chunk.content,
        }))
      );
    } else {
      console.log('[CHUNK QUALITY FILTER]', 'No chunks were excluded before generation.');
    }

    return {
      evaluated,
      kept,
      removed,
    };
  }

  private shouldAlwaysDropAsJunk(
    chunk: VectorSearchResult & { quality: ChunkQualityAssessment }
  ): boolean {
    if (chunk.quality.exclusionType === 'bibliography') {
      return true;
    }

    const content = `${chunk.document.title || ''}\n${chunk.chunk.source || ''}\n${chunk.chunk.content || ''}`.toLowerCase();
    const numericHits = (content.match(/\b\d{3,4}\b/g) || []).length;
    const commaPageHits = (content.match(/,\s*\d{1,4}(?:\b|,)/g) || []).length;
    const sentenceBreaks = (content.match(/[.!?]/g) || []).length;
    const hasStrongStructuredRows = this.hasRichStructuredRows(content);
    const hasStrongIndexSignals =
      chunk.quality.reasons.includes('index_entry_density') ||
      chunk.quality.reasons.includes('high_page_number_density') ||
      chunk.quality.reasons.includes('toc_or_index_like') ||
      chunk.quality.reasons.includes('index_style_entry_density') ||
      chunk.quality.reasons.includes('index_like_page_density') ||
      chunk.quality.reasons.includes('clearly_index_like');

    const clearlyIndexLike =
      hasStrongIndexSignals ||
      chunk.quality.reasons.includes('clearly_index_like') ||
      (numericHits >= 8 && commaPageHits >= 3 && sentenceBreaks <= 1);

    return clearlyIndexLike && !hasStrongStructuredRows;
  }

  private hasRichStructuredRows(content: string): boolean {
    const rowLikeMatches =
      content.match(/\b[a-z][a-z\s()/-]{2,40}\s+\d+(?:\.\d+)?\b/g) || [];
    const numericHits = (content.match(/\b\d+(?:\.\d+)?\b/g) || []).length;
    return (
      rowLikeMatches.length >= 4 ||
      (
        numericHits >= 4 &&
        /\b(symptoms?|signs?|laboratory|laboratories|total|score|scores|criteria|thresholds?)\b/.test(content)
      )
    );
  }

  private shouldRescueStructuredChunk(
    chunk: VectorSearchResult & { quality: ChunkQualityAssessment }
  ): boolean {
    const content = `${chunk.document.title || ''}\n${chunk.chunk.source || ''}\n${chunk.chunk.content || ''}`.toLowerCase();
    const hasTableLikeStructure =
      /\b(table|figure|fig\.|summary box|box|caption|criteria list|criteria)\b/.test(content);
    const hasScoringStructure =
      /\b(score|scores|scoring system|scoring systems|alvarado|mantrels)\b/.test(content) &&
      /\b\d+\b/.test(content);
    const hasThresholdStructure =
      /\b(threshold|indication|indications|level|levels)\b/.test(content) &&
      /\b\d+\b/.test(content);
    const hasHighValueStructure = hasTableLikeStructure || hasScoringStructure || hasThresholdStructure;

    if (!hasHighValueStructure) {
      return false;
    }

    const hasRichStructuredRows = this.hasRichStructuredRows(content);

    if (chunk.quality.exclusionType === 'bibliography') {
      return false;
    }

    if (chunk.quality.exclusionType === 'index') {
      return hasRichStructuredRows && hasScoringStructure;
    }

    if (chunk.quality.exclusionType === 'caption-only') {
      return hasScoringStructure || hasThresholdStructure || hasRichStructuredRows;
    }

    return true;
  }

  private rankGenerationCandidate(
    chunk: VectorSearchResult & { quality?: ChunkQualityAssessment },
    queryIntent?: QueryIntent,
    selected: Array<VectorSearchResult & { quality?: ChunkQualityAssessment }> = []
  ): number {
    const content = `${chunk.document.title || ''}\n${chunk.chunk.source || ''}\n${chunk.chunk.content || ''}`.toLowerCase();
    const baseSimilarity = chunk.similarity || 0;

    const hasTableLikeStructure =
      /\b(table|figure|fig\.|summary box|box|caption|criteria list|criteria)\b/.test(content);
    const hasScoringStructure =
      /\b(score|scores|scoring system|scoring systems|alvarado|mantrels)\b/.test(content) &&
      /\b\d+\b/.test(content);
    const hasThresholdStructure =
      /\b(threshold|indication|indications|level|levels)\b/.test(content) &&
      /\b\d+\b/.test(content);

    let bonus = 0;
    if (hasTableLikeStructure) bonus += 0.12;
    if (hasScoringStructure) bonus += 0.12;
    if (hasThresholdStructure) bonus += 0.06;
    if (this.shouldRescueStructuredChunk({
      ...chunk,
      quality: chunk.quality || {
        score: 1,
        reasons: [],
        shouldExclude: false,
        exclusionType: 'other',
      }
    })) {
      bonus += 0.06;
    }

    const qualityScore = chunk.quality?.score ?? 1;
    const intentBonus = this.scoreGenerationIntentAlignment(content, queryIntent);
    const detailBonus = this.scoreGenerationDetailBonus(content, queryIntent);
    const coverageBonus = this.scoreGenerationCoverageBonus(chunk, selected, queryIntent);
    const redundancyPenalty = this.scoreGenerationRedundancyPenalty(chunk, selected);
    const sideTopicPenalty = this.scoreGenerationSideTopicPenalty(content, queryIntent);
    return baseSimilarity + bonus + intentBonus + detailBonus + coverageBonus + redundancyPenalty + sideTopicPenalty + (qualityScore * 0.02);
  }

  private isHighValueStructuredGenerationChunk(
    chunk: VectorSearchResult & { quality?: ChunkQualityAssessment }
  ): boolean {
    const content = `${chunk.document.title || ''}\n${chunk.chunk.source || ''}\n${chunk.chunk.content || ''}`.toLowerCase();
    return (
      /\b(table|figure|fig\.|summary box|box|caption|criteria list|criteria)\b/.test(content) ||
      /\b(score|scores|scoring system|scoring systems|alvarado|mantrels)\b/.test(content) ||
      /\b(threshold|indication|indications|level|levels)\b/.test(content)
    );
  }

  private calculatePageRichness(
    chunks: Array<VectorSearchResult | (VectorSearchResult & { quality?: ChunkQualityAssessment })>
  ): number {
    const kinds = new Set<string>();

    for (const chunk of chunks) {
      const content = `${chunk.document.title || ''}\n${chunk.chunk.source || ''}\n${chunk.chunk.content || ''}`.toLowerCase();
      const sentenceCount = (content.match(/[.!?]/g) || []).length;

      if (/\btable\b/.test(content) || /\bcriteria list\b/.test(content) || /\bcriteria\b/.test(content)) kinds.add('table');
      if (/\bfigure\b/.test(content) || /\bfig\b/.test(content) || /\bcaption\b/.test(content)) kinds.add('figure');
      if (/\b(score|scores|scoring system|scoring systems|threshold|indication|indications|level|levels)\b/.test(content) && /\b\d+\b/.test(content)) kinds.add('score');
      if (sentenceCount >= 2 || /\b(history|clinical|diagnosis|investigation|treatment|management|features|complications|anatomy|introduction|overview)\b/.test(content)) kinds.add('paragraph');
    }

    let bonus = 0;
    if (kinds.has('paragraph') && kinds.has('table')) bonus += 0.08;
    if (kinds.has('paragraph') && kinds.has('figure')) bonus += 0.06;
    if (kinds.has('table') && kinds.has('figure')) bonus += 0.05;
    if (kinds.has('paragraph') && kinds.has('table') && kinds.has('figure')) bonus += 0.07;
    if (kinds.has('score') && (kinds.has('paragraph') || kinds.has('table'))) bonus += 0.05;
    return Math.min(0.2, bonus);
  }

  private isPageCoverageStrong(
    chunks: Array<VectorSearchResult | (VectorSearchResult & { quality?: ChunkQualityAssessment })>
  ): boolean {
    if (chunks.length >= 3) return true;
    const bestSimilarity = chunks.reduce((best, chunk) => Math.max(best, chunk.similarity || 0), 0);
    return bestSimilarity >= 0.92 && chunks.length >= 2 && this.calculatePageRichness(chunks) >= 0.08;
  }

  private isPageThin(
    existingChunks: VectorSearchResult[],
    samePageCandidateCount: number
  ): boolean {
    const totalCoverage = existingChunks.length + samePageCandidateCount;
    if (totalCoverage >= 3) return false;
    return this.calculatePageRichness(existingChunks) < 0.08;
  }

  private extractChapterCueFromText(text: string): string | null {
    const normalized = (text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return null;
    const chapterMatch = normalized.match(/\bchapter\s+(\d+)\b/i);
    return chapterMatch?.[1] ? `chapter:${chapterMatch[1]}` : null;
  }

  private scoreRetrievalIntentAlignment(text: string, queryIntent?: QueryIntent): number {
    const normalized = (text || '').toLowerCase();
    if (!normalized || !queryIntent) return 0;

    let score = 0;

    if (queryIntent === 'clinical_features_history_exam') {
      if (/\b(clinical presentation|presenting complaints|types of pain|history findings|examination of)\b/.test(normalized)) score += 0.18;
      if (/\b(renal pain|ureteric colic|radiation|hematuria|nausea|vomiting|fever|tenderness|inspection|palpation|symptoms?|signs?|pain)\b/.test(normalized)) score += 0.14;
      if (/\b(management|treatment|therapy|stone analysis)\b/.test(normalized)) score -= 0.14;
      if (/\b(calcium oxalate|phosphate stones?|uric acid stones?|cystine stones?|mixed stones?|primary vs\.? secondary|staghorn)\b/.test(normalized)) score -= 0.16;
    } else if (queryIntent === 'investigations') {
      if (/\b(ct|ct kub|x-?ray|k?ub|ivu|urogram|ultrasonography|cystoscopy|diagnos|imaging)\b/.test(normalized)) score += 0.18;
      if (/\b(management|treatment|therapy)\b/.test(normalized)) score -= 0.1;
    } else if (queryIntent === 'classification_types') {
      if (/\b(types?|classification|primary vs\.? secondary|calcium oxalate|phosphate|uric acid|cystine|mixed)\b/.test(normalized)) score += 0.18;
      if (/\b(management|treatment|therapy)\b/.test(normalized)) score -= 0.08;
    } else if (queryIntent === 'treatment_rx') {
      if (/\b(management|treatment|therapy|surgery|procedure|eswl|lithotripsy)\b/.test(normalized)) score += 0.18;
      if (/\b(types of pain|symptoms?|signs?|classification)\b/.test(normalized)) score -= 0.1;
    } else if (queryIntent === 'causes' || queryIntent === 'risk_factors') {
      if (/\b(causes?|risk factors?|predisposing|etiology|aetiology|geography|climate|water intake|obstruction|stasis|drugs)\b/.test(normalized)) score += 0.16;
      if (/\b(management|treatment|therapy)\b/.test(normalized)) score -= 0.08;
    }

    return Math.max(-0.22, Math.min(0.32, score));
  }

  private hasLocalContinuationSignals(text: string, queryIntent?: QueryIntent): boolean {
    const normalized = (text || '').toLowerCase();
    if (!normalized) return false;

    if (queryIntent === 'clinical_features_history_exam') {
      return /\b(radiation|radiate|colic|pain|onset|associated symptoms?|nature of pain|bladder pain|strangury|hematuria|nausea|vomiting|examination)\b/.test(normalized);
    }

    if (queryIntent === 'investigations') {
      return /\b(ct|x-?ray|ivu|urogram|ultrasonography|cystoscopy|radiopaque|radiolucent)\b/.test(normalized);
    }

    if (queryIntent === 'classification_types') {
      return /\b(calcium oxalate|phosphate|uric acid|cystine|mixed|primary|secondary)\b/.test(normalized);
    }

    return /\b(clinical|history|examination|management|investigation|classification|pain|radiation|symptoms?)\b/.test(normalized);
  }

  private getGenerationFacetLabels(content: string, queryIntent?: QueryIntent): string[] {
    const normalized = (content || '').toLowerCase();
    if (!normalized) return [];

    const facets = new Set<string>();

    switch (queryIntent) {
      case 'clinical_features_history_exam':
        if (/\b(history|symptoms?|presenting complaints?|pain|anorexia|nausea|vomiting|fever|pyrexia|discomfort)\b/.test(normalized)) facets.add('history');
        if (/\b(signs?|examination|inspection|palpation|tenderness|guarding|rebound|mcburney|rovsing|psoas|obturator|hyperaesthesia)\b/.test(normalized)) facets.add('examination');
        if (/\b(retrocaecal|pelvic|atypical|special features?|position of the appendix|tenesmus|suprapubic)\b/.test(normalized)) facets.add('special_features');
        break;
      case 'investigations':
        if (/\b(ct|mri|x-?ray|ultra(?:sound|sonography)|scan|urogram|cystoscopy|laboratory|blood test|imaging)\b/.test(normalized)) facets.add('modality');
        if (/\b(show|detect|finding|findings|radiopaque|radiolucent|obstruction|filling defects?)\b/.test(normalized)) facets.add('findings');
        if (/\b(creatinine|before|after|follow-?up|supplementary|gold standard|indication)\b/.test(normalized)) facets.add('usage_notes');
        break;
      case 'classification_types':
        if (/\b(types?|classification|subtypes?)\b/.test(normalized)) facets.add('types');
        if (/\b(primary|secondary|acute|chronic|specific|non-?specific)\b/.test(normalized)) facets.add('subgroups');
        if (/\b(criteria|grading|grade|feature|difference|compared|versus)\b/.test(normalized)) facets.add('criteria');
        break;
      case 'treatment_rx':
        if (/\b(conservative|medical|drug|antibiotic|analgesia|fluids?)\b/.test(normalized)) facets.add('medical');
        if (/\b(surgery|surgical|operation|appendicectomy|appendectomy|procedure|laparoscopy|laparotomy)\b/.test(normalized)) facets.add('surgical');
        if (/\b(indication|indications|timing|complication|follow-?up|postoperative|aftercare)\b/.test(normalized)) facets.add('management_notes');
        break;
      case 'causes':
      case 'risk_factors':
        if (/\b(causes?|etiology|aetiology|pathogenesis|mechanism)\b/.test(normalized)) facets.add('cause_core');
        if (/\b(risk|predisposing|associated|linked|family history|age|sex|occupation|geography|climate)\b/.test(normalized)) facets.add('risk_factors');
        if (/\b(protective|aggravating|trigger|precipitating)\b/.test(normalized)) facets.add('modifiers');
        break;
      case 'complications':
        if (/\b(complications?|perforation|bleeding|sepsis|obstruction|rupture|abscess)\b/.test(normalized)) facets.add('complications');
        if (/\b(early|late|local|systemic)\b/.test(normalized)) facets.add('categories');
        break;
      case 'prognosis':
        if (/\b(prognosis|outcome|survival|mortality|recovery|recurrence|course)\b/.test(normalized)) facets.add('outcomes');
        if (/\b(factors?|predictors?|worse|better|depends on)\b/.test(normalized)) facets.add('predictors');
        break;
      case 'position_location':
        if (/\b(position|location|lies|situated|surface marking|anatomical)\b/.test(normalized)) facets.add('location');
        if (/\b(relationship|relation|adjacent|anterior|posterior|medial|lateral|superior|inferior)\b/.test(normalized)) facets.add('relations');
        break;
      case 'difference_between':
        if (/\b(difference|differentiate|distinguish|whereas|unlike|compared|versus|vs)\b/.test(normalized)) facets.add('contrast');
        if (/\b(feature|features|clinical|investigation|treatment|cause)\b/.test(normalized)) facets.add('comparison_points');
        break;
      case 'how_to_procedure':
        if (/\b(step|steps|procedure|technique|incision|dissection|ligation|closure|perform)\b/.test(normalized)) facets.add('steps');
        if (/\b(indication|position|instrument|preparation|complication|postoperative)\b/.test(normalized)) facets.add('procedure_context');
        break;
      case 'definition':
        if (/\b(definition|defined as|refers to|means|is a|is an)\b/.test(normalized)) facets.add('definition');
        if (/\b(types?|classification|causes?|features?|complications?|treatment)\b/.test(normalized)) facets.add('extra_context');
        break;
      default:
        if (/\b(summary|overview|introduction|clinical|history|signs?|symptoms?|management|investigation|classification|causes?)\b/.test(normalized)) facets.add('general');
        break;
    }

    return Array.from(facets);
  }

  private scoreGenerationIntentAlignment(content: string, queryIntent?: QueryIntent): number {
    let score = this.scoreRetrievalIntentAlignment(content, queryIntent);
    const normalized = (content || '').toLowerCase();
    if (!normalized || !queryIntent) return score;

    if (queryIntent === 'definition') {
      if (/\b(definition|defined as|refers to|means|is a|is an)\b/.test(normalized)) score += 0.18;
      if (/\b(management|treatment|investigation|complication)\b/.test(normalized)) score -= 0.08;
    } else if (queryIntent === 'difference_between') {
      if (/\b(difference|differentiate|distinguish|whereas|unlike|compared|versus|vs)\b/.test(normalized)) score += 0.18;
    } else if (queryIntent === 'position_location') {
      if (/\b(position|location|lies|situated|surface marking|anatomical|relation)\b/.test(normalized)) score += 0.18;
      if (/\b(management|treatment)\b/.test(normalized)) score -= 0.08;
    } else if (queryIntent === 'complications') {
      if (/\b(complications?|perforation|sepsis|bleeding|abscess|rupture|obstruction)\b/.test(normalized)) score += 0.18;
      if (/\b(definition|management)\b/.test(normalized)) score -= 0.08;
    } else if (queryIntent === 'prognosis') {
      if (/\b(prognosis|outcome|survival|mortality|recovery|recurrence|course)\b/.test(normalized)) score += 0.18;
    } else if (queryIntent === 'how_to_procedure') {
      if (/\b(step|steps|procedure|technique|perform|incision|dissection|ligation|closure)\b/.test(normalized)) score += 0.18;
    }

    return Math.max(-0.24, Math.min(0.4, score));
  }

  private scoreGenerationDetailBonus(content: string, queryIntent?: QueryIntent): number {
    const normalized = (content || '').toLowerCase();
    if (!normalized) return 0;

    const sentenceCount = (normalized.match(/[.!?]/g) || []).length;
    let bonus = 0;

    if (sentenceCount >= 3) bonus += 0.04;
    if (sentenceCount >= 5) bonus += 0.03;

    if (queryIntent === 'clinical_features_history_exam') {
      if (/\b(history|similar discomfort|family history|menstrual|pregnancy|vaginal discharge|childbearing age|follow the onset|episodes? of vomiting)\b/.test(normalized)) bonus += 0.1;
      if (/\b(examination|inspection|palpation|cough|percussion|pointing sign|rovsing|psoas|obturator)\b/.test(normalized)) bonus += 0.06;
    } else if (queryIntent === 'investigations') {
      if (/\b(show|shows|detect|determine|indicate|gold standard|follow-?up|before|after)\b/.test(normalized)) bonus += 0.08;
    } else if (queryIntent === 'treatment_rx') {
      if (/\b(indications?|contraindications?|complications?|follow-?up|postoperative|timing)\b/.test(normalized)) bonus += 0.08;
    }

    return Math.min(0.16, bonus);
  }

  private scoreGenerationSideTopicPenalty(content: string, queryIntent?: QueryIntent): number {
    const normalized = (content || '').toLowerCase();
    if (!normalized || !queryIntent) return 0;

    let penalty = 0;

    if (/\b(figure|fig\.|courtesy of|photomicrograph|original magnification)\b/.test(normalized)) {
      penalty -= 0.08;
    }

    if (queryIntent !== 'difference_between' && /\b(differential diagnosis|differential diagnoses)\b/.test(normalized)) {
      penalty -= 0.22;
    }

    if (queryIntent !== 'risk_factors' && /\b(risk factors?|predisposing factors?)\b/.test(normalized)) {
      penalty -= 0.1;
    }

    if (queryIntent === 'clinical_features_history_exam') {
      if (/\b(differential diagnosis|table \d+|summary box \d+\.\d+\s*risk factors?)\b/.test(normalized)) penalty -= 0.14;
      if (/\b(management|treatment|investigation|diagnosis|classification|types of)\b/.test(normalized)) penalty -= 0.14;
    } else if (queryIntent === 'investigations') {
      if (/\b(management|treatment|therapy|classification|types of|differential diagnosis)\b/.test(normalized)) penalty -= 0.14;
    } else if (queryIntent === 'treatment_rx') {
      if (/\b(differential diagnosis|classification|types of|risk factors?|causes?)\b/.test(normalized)) penalty -= 0.12;
    } else if (queryIntent === 'classification_types') {
      if (/\b(management|treatment|differential diagnosis|history|examination)\b/.test(normalized)) penalty -= 0.12;
    } else if (queryIntent === 'causes' || queryIntent === 'risk_factors') {
      if (/\b(management|treatment|differential diagnosis|examination)\b/.test(normalized)) penalty -= 0.12;
    } else if (queryIntent === 'definition') {
      if (/\b(differential diagnosis|management|treatment|investigation|complications?)\b/.test(normalized)) penalty -= 0.12;
    }

    return Math.max(-0.32, penalty);
  }

  private getGenerationContentTokens(content: string): Set<string> {
    const stopwords = new Set([
      'the', 'and', 'for', 'that', 'with', 'from', 'this', 'have', 'which', 'into', 'over', 'under',
      'when', 'will', 'then', 'than', 'they', 'them', 'their', 'there', 'were', 'been', 'being',
      'also', 'only', 'very', 'more', 'most', 'some', 'such', 'does', 'done', 'used', 'use',
      'page', 'chapter', 'patient', 'patients'
    ]);

    return new Set(
      (content || '')
        .toLowerCase()
        .replace(/[^\w\s-]/g, ' ')
        .split(/\s+/)
        .filter((token) => token.length >= 4 && !stopwords.has(token))
    );
  }

  private scoreGenerationRedundancyPenalty(
    candidate: VectorSearchResult & { quality?: ChunkQualityAssessment },
    selected: Array<VectorSearchResult & { quality?: ChunkQualityAssessment }>
  ): number {
    if (selected.length === 0) return 0;

    const candidateTokens = this.getGenerationContentTokens(candidate.chunk.content || '');
    if (candidateTokens.size === 0) return 0;

    let maxOverlap = 0;
    for (const item of selected) {
      const itemTokens = this.getGenerationContentTokens(item.chunk.content || '');
      if (itemTokens.size === 0) continue;

      let intersection = 0;
      for (const token of candidateTokens) {
        if (itemTokens.has(token)) intersection += 1;
      }

      const overlap = intersection / Math.max(candidateTokens.size, 1);
      if (overlap > maxOverlap) maxOverlap = overlap;
    }

    if (maxOverlap >= 0.75) return -0.28;
    if (maxOverlap >= 0.6) return -0.18;
    if (maxOverlap >= 0.45) return -0.1;
    return 0;
  }

  private scoreGenerationCoverageBonus(
    candidate: VectorSearchResult & { quality?: ChunkQualityAssessment },
    selected: Array<VectorSearchResult & { quality?: ChunkQualityAssessment }>,
    queryIntent?: QueryIntent
  ): number {
    const candidateFacets = this.getGenerationFacetLabels(candidate.chunk.content || '', queryIntent);
    if (candidateFacets.length === 0) return 0;

    const selectedFacets = new Set(
      selected.flatMap((item) => this.getGenerationFacetLabels(item.chunk.content || '', queryIntent))
    );

    let bonus = 0;
    for (const facet of candidateFacets) {
      if (!selectedFacets.has(facet)) {
        bonus += 0.08;
      }
    }

    return Math.min(0.2, bonus);
  }

  private selectGenerationChunksByPageCluster(
    chunks: Array<VectorSearchResult & { quality: ChunkQualityAssessment }>,
    maxResults: number,
    queryIntent?: QueryIntent
  ): Array<VectorSearchResult & { quality: ChunkQualityAssessment }> {
    if (chunks.length === 0 || maxResults <= 0) {
      return [];
    }

    type Cluster = {
      key: string;
      documentId: string;
      page: number | null;
      chunks: Array<VectorSearchResult & { quality: ChunkQualityAssessment }>;
      score: number;
      hasStructuredChunk: boolean;
      richness: number;
    };

    const clusters = new Map<string, Cluster>();
    for (const chunk of chunks) {
      const page = this.getChunkPageNumber(chunk.chunk);
      const key = `${chunk.document.id}:${page ?? 'unknown'}`;
      const existing = clusters.get(key);
      if (existing) {
        existing.chunks.push(chunk);
        existing.hasStructuredChunk = existing.hasStructuredChunk || this.isHighValueStructuredGenerationChunk(chunk);
        continue;
      }

      clusters.set(key, {
        key,
        documentId: chunk.document.id,
        page,
        chunks: [chunk],
        score: 0,
        hasStructuredChunk: this.isHighValueStructuredGenerationChunk(chunk),
        richness: 0,
      });
    }

    for (const cluster of clusters.values()) {
      const sortedChunks = [...cluster.chunks].sort(
        (a, b) => this.rankGenerationCandidate(b, queryIntent) - this.rankGenerationCandidate(a, queryIntent)
      );
      const topScores = sortedChunks
        .slice(0, 2)
        .map((chunk) => this.rankGenerationCandidate(chunk, queryIntent));
      const bestScore = topScores[0] || 0;
      const representativeScore =
        topScores.length >= 2
          ? (bestScore * 0.7) + (topScores[1] * 0.3)
          : bestScore;
      const companionBonus = Math.min(sortedChunks.length - 1, 2) * 0.08;
      const structuredBonus = cluster.hasStructuredChunk ? 0.06 : 0;
      cluster.richness = this.calculatePageRichness(sortedChunks);
      cluster.score = representativeScore + companionBonus + structuredBonus + cluster.richness;
      cluster.chunks = sortedChunks;
    }

    const preliminaryRankedClusters = Array.from(clusters.values())
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.documentId !== b.documentId) return a.documentId.localeCompare(b.documentId);
        return (a.page ?? 0) - (b.page ?? 0);
      });

    const selected: Array<VectorSearchResult & { quality: ChunkQualityAssessment }> = [];
    const usedChunkIds = new Set<string>();
    const strongestCluster = preliminaryRankedClusters[0] || null;
    const stopDrift = strongestCluster ? this.isPageCoverageStrong(strongestCluster.chunks) : false;
    const localFocusActive = Boolean(
      strongestCluster &&
      strongestCluster.page !== null &&
      (
        stopDrift ||
        strongestCluster.chunks.length >= 2 ||
        strongestCluster.score >= 0.7
      )
    );
    const isPreferredLocalChunk = (chunk: VectorSearchResult & { quality: ChunkQualityAssessment }): boolean =>
      Boolean(
        localFocusActive &&
        strongestCluster &&
        strongestCluster.page !== null &&
        chunk.document.id === strongestCluster.documentId &&
        this.getChunkPageNumber(chunk.chunk) !== null &&
        Math.abs((this.getChunkPageNumber(chunk.chunk) as number) - strongestCluster.page) <= 1
      );
    const isPreferredLocalCluster = (cluster: Cluster): boolean =>
      Boolean(
        localFocusActive &&
        strongestCluster &&
        strongestCluster.page !== null &&
        cluster.documentId === strongestCluster.documentId &&
        cluster.page !== null &&
        Math.abs(cluster.page - strongestCluster.page) <= 1
      );

    const rankedClusters = [...preliminaryRankedClusters].sort((a, b) => {
      const aPreferred = isPreferredLocalCluster(a);
      const bPreferred = isPreferredLocalCluster(b);
      if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
      const aSameDoc = strongestCluster ? a.documentId === strongestCluster.documentId : false;
      const bSameDoc = strongestCluster ? b.documentId === strongestCluster.documentId : false;
      if (aSameDoc !== bSameDoc) return aSameDoc ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      if (a.documentId !== b.documentId) return a.documentId.localeCompare(b.documentId);
      return (a.page ?? 0) - (b.page ?? 0);
    });

    const clusterPasses = localFocusActive
      ? [
          rankedClusters.filter((cluster) => isPreferredLocalCluster(cluster)),
          rankedClusters.filter((cluster) => !isPreferredLocalCluster(cluster)),
        ]
      : [rankedClusters];
    const generationPageSelectionDebug: GenerationPageSelectionDebug = {
      strongestCluster: strongestCluster
        ? {
            documentId: strongestCluster.documentId,
            page: strongestCluster.page,
            score: Number(strongestCluster.score.toFixed(3)),
            chunkCount: strongestCluster.chunks.length,
          }
        : null,
      localFocusActive,
      preferredLocalWindow: strongestCluster && strongestCluster.page !== null
        ? {
            documentId: strongestCluster.documentId,
            pages: [strongestCluster.page - 1, strongestCluster.page, strongestCluster.page + 1].filter((page) => page > 0),
          }
        : null,
      rankedClusters: rankedClusters.map((cluster) => ({
        documentId: cluster.documentId,
        page: cluster.page,
        score: Number(cluster.score.toFixed(3)),
        chunkCount: cluster.chunks.length,
        preferredLocal: isPreferredLocalCluster(cluster),
      })),
      selectedChunkCount: 0,
      selectedPages: [],
    };

    for (const [passIndex, clusterGroup] of clusterPasses.entries()) {
      for (const cluster of clusterGroup) {
        if (selected.length >= maxResults) {
          break;
        }

        const remainingSlots = maxResults - selected.length;
        const takeCount =
          localFocusActive && strongestCluster && cluster.key === strongestCluster.key
            ? Math.min(4, remainingSlots, cluster.chunks.length)
            : localFocusActive && isPreferredLocalCluster(cluster)
              ? Math.min(3, remainingSlots, cluster.chunks.length)
              : stopDrift && strongestCluster && cluster.key === strongestCluster.key
                ? Math.min(3, remainingSlots, cluster.chunks.length)
                : cluster.hasStructuredChunk
                  ? Math.min(passIndex === 0 ? 2 : 1, remainingSlots, cluster.chunks.length)
                  : Math.min(1, remainingSlots, cluster.chunks.length);

        const clusterPool = [...cluster.chunks];
        const chosenFromCluster: Array<VectorSearchResult & { quality: ChunkQualityAssessment }> = [];
        while (chosenFromCluster.length < takeCount && clusterPool.length > 0) {
          clusterPool.sort((a, b) => (
            this.rankGenerationBackfillCandidate(b, [...selected, ...chosenFromCluster], strongestCluster, queryIntent) -
            this.rankGenerationBackfillCandidate(a, [...selected, ...chosenFromCluster], strongestCluster, queryIntent)
          ));
          const chunk = clusterPool.shift();
          if (!chunk) break;
          if (usedChunkIds.has(chunk.chunk.id)) continue;
          selected.push(chunk);
          chosenFromCluster.push(chunk);
          usedChunkIds.add(chunk.chunk.id);
        }
      }
    }

    if (selected.length < maxResults) {
      const rankedBackfillCandidates = chunks
        .filter((chunk) => !usedChunkIds.has(chunk.chunk.id))
        .sort((a, b) => this.rankGenerationBackfillCandidate(b, selected, strongestCluster, queryIntent) - this.rankGenerationBackfillCandidate(a, selected, strongestCluster, queryIntent));

      const localBackfillCandidates = localFocusActive
        ? rankedBackfillCandidates.filter((chunk) => isPreferredLocalChunk(chunk))
        : [];
      const fallbackBackfillCandidates = localFocusActive
        ? rankedBackfillCandidates.filter((chunk) => !isPreferredLocalChunk(chunk))
        : rankedBackfillCandidates;

      for (const chunk of localBackfillCandidates) {
        if (selected.length >= maxResults) break;
        selected.push(chunk);
        usedChunkIds.add(chunk.chunk.id);
      }

      const selectedLocalCount = selected.filter((chunk) => isPreferredLocalChunk(chunk)).length;
      const hasStrongLocalWindow = localFocusActive && selectedLocalCount >= Math.min(maxResults, 4);

      if (!hasStrongLocalWindow) {
        for (const chunk of fallbackBackfillCandidates) {
          if (selected.length >= maxResults) break;
          selected.push(chunk);
          usedChunkIds.add(chunk.chunk.id);
        }
      }
    }

    const selectedPageSummary = Array.from(
      selected.reduce((acc, chunk) => {
        const page = this.getChunkPageNumber(chunk.chunk);
        const key = `${chunk.document.id}:${page ?? 'unknown'}`;
        const current = acc.get(key) || {
          documentId: chunk.document.id,
          page,
          count: 0,
          chunkIds: [] as string[],
        };
        current.count += 1;
        current.chunkIds.push(chunk.chunk.id);
        acc.set(key, current);
        return acc;
      }, new Map<string, { documentId: string; page: number | null; count: number; chunkIds: string[] }>())
        .values()
    );

    generationPageSelectionDebug.selectedChunkCount = selected.length;
    generationPageSelectionDebug.selectedPages = selectedPageSummary;
    this.lastGenerationPageSelectionDebug = generationPageSelectionDebug;

    return selected.sort((a, b) => this.rankGenerationCandidate(b, queryIntent) - this.rankGenerationCandidate(a, queryIntent));
  }

  private rankGenerationBackfillCandidate(
    candidate: VectorSearchResult & { quality: ChunkQualityAssessment },
    selected: Array<VectorSearchResult & { quality: ChunkQualityAssessment }>,
    strongestCluster?: {
      documentId: string;
      page: number | null;
    } | null,
    queryIntent?: QueryIntent
  ): number {
    return this.rankGenerationCandidate(candidate, queryIntent, selected) + this.scoreGenerationContinuityBonus(candidate, selected, strongestCluster);
  }

  private scoreGenerationContinuityBonus(
    candidate: VectorSearchResult & { quality: ChunkQualityAssessment },
    selected: Array<VectorSearchResult & { quality: ChunkQualityAssessment }>,
    strongestCluster?: {
      documentId: string;
      page: number | null;
    } | null
  ): number {
    const candidateIndex = this.getEffectiveChunkIndex(candidate.chunk);
    const candidatePage = this.getChunkPageNumber(candidate.chunk);
    const sameDocSelected = selected.filter((item) => item.document.id === candidate.document.id);

    if (sameDocSelected.length === 0) {
      return 0;
    }

    let bonus = 0;

    const samePageSelected = candidatePage !== null && sameDocSelected.some(
      (item) => this.getChunkPageNumber(item.chunk) === candidatePage
    );
    if (samePageSelected) {
      bonus += 0.04;
    }

    if (candidateIndex !== null) {
      const selectedIndices = sameDocSelected
        .map((item) => this.getEffectiveChunkIndex(item.chunk))
        .filter((index): index is number => index !== null)
        .sort((a, b) => a - b);

      if (selectedIndices.some((index) => Math.abs(index - candidateIndex) === 1)) {
        bonus += 0.1;
      }

      for (let i = 0; i < selectedIndices.length - 1; i++) {
        const left = selectedIndices[i];
        const right = selectedIndices[i + 1];
        const isBridgeChunk =
          candidateIndex > left &&
          candidateIndex < right &&
          candidateIndex - left <= 2 &&
          right - candidateIndex <= 2;

        if (isBridgeChunk) {
          bonus += 0.16;
          break;
        }
      }
    }

    const content = (candidate.chunk.content || '').toLowerCase();
    const hasSymptomContinuationSignals =
      /\b(radiation|radiate|colic|pain|symptom|symptoms|nausea|vomiting|hematuria|examination)\b/.test(content);
    if (hasSymptomContinuationSignals) {
      bonus += 0.03;
    }

    if (
      strongestCluster &&
      strongestCluster.page !== null &&
      candidate.document.id === strongestCluster.documentId &&
      candidatePage !== null
    ) {
      const pageDistance = Math.abs(candidatePage - strongestCluster.page);
      if (pageDistance === 0) bonus += 0.16;
      if (pageDistance === 1) bonus += 0.12;
      if (pageDistance >= 2) bonus -= Math.min(0.08, pageDistance * 0.03);
    }

    return Math.min(0.24, bonus);
  }

  private getCurrentLocalGenerationFocus(): {
    documentId: string;
    page: number | null;
  } | null {
    const anchor = this.lastRetrievalAnchorWindowDebug?.anchor;
    if (anchor) {
      return {
        documentId: anchor.documentId,
        page: anchor.page,
      };
    }

    const strongestCluster = this.lastGenerationPageSelectionDebug?.strongestCluster;
    if (strongestCluster) {
      return {
        documentId: strongestCluster.documentId,
        page: strongestCluster.page,
      };
    }

    return null;
  }

  private isPreferredLocalGenerationChunk(
    chunk: VectorSearchResult
  ): boolean {
    const localFocus = this.getCurrentLocalGenerationFocus();
    if (!localFocus || localFocus.page === null) {
      return false;
    }

    const page = this.getChunkPageNumber(chunk.chunk);
    if (page === null) {
      return false;
    }

    return (
      chunk.document.id === localFocus.documentId &&
      Math.abs(page - localFocus.page) <= 1
    );
  }

  private looksLikeContinuationFragment(content: string): boolean {
    const normalized = (content || '').trim();
    if (!normalized) return false;

    return (
      /^[a-z]/.test(normalized) ||
      /^(?:\)|\]|,|;|:|\.|and\b|or\b|with\b|of\b)/i.test(normalized) ||
      /\bcontinues?\b/i.test(normalized)
    );
  }

  private qualifiesForRelaxedGenerationFloor(
    chunk: VectorSearchResult,
    queryIntent?: QueryIntent
  ): boolean {
    if (!this.isPreferredLocalGenerationChunk(chunk)) {
      return false;
    }

    const content = chunk.chunk.content || '';
    return (
      this.hasLocalContinuationSignals(content, queryIntent) ||
      this.looksLikeContinuationFragment(content)
    );
  }

  private getGenerationSimilarityFloor(
    chunk: VectorSearchResult,
    queryIntent?: QueryIntent,
    defaultFloor: number = 0.55
  ): number {
    if (this.qualifiesForRelaxedGenerationFloor(chunk, queryIntent)) {
      return 0.5;
    }

    return defaultFloor;
  }

  private orderGenerationChunksForContext(
    chunks: Array<VectorSearchResult & { quality?: ChunkQualityAssessment }>
  ): Array<VectorSearchResult & { quality?: ChunkQualityAssessment }> {
    const localFocus = this.getCurrentLocalGenerationFocus();

    return [...chunks].sort((a, b) => {
      const aPreferred = this.isPreferredLocalGenerationChunk(a);
      const bPreferred = this.isPreferredLocalGenerationChunk(b);
      if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;

      if (localFocus) {
        const aSameDoc = a.document.id === localFocus.documentId;
        const bSameDoc = b.document.id === localFocus.documentId;
        if (aSameDoc !== bSameDoc) return aSameDoc ? -1 : 1;
      }

      if (a.document.id !== b.document.id) {
        return a.document.id.localeCompare(b.document.id);
      }

      const aPage = this.getChunkPageNumber(a.chunk) ?? Number.MAX_SAFE_INTEGER;
      const bPage = this.getChunkPageNumber(b.chunk) ?? Number.MAX_SAFE_INTEGER;
      if (aPage !== bPage) return aPage - bPage;

      const aIndex = this.getEffectiveChunkIndex(a.chunk) ?? Number.MAX_SAFE_INTEGER;
      const bIndex = this.getEffectiveChunkIndex(b.chunk) ?? Number.MAX_SAFE_INTEGER;
      if (aIndex !== bIndex) return aIndex - bIndex;

      return b.similarity - a.similarity;
    });
  }

  private classifyRetrievedChunkForDebug(
    result: VectorSearchResult,
    baseChunkIds: Set<string>,
    topBaseResult: VectorSearchResult | null,
    basePagesByDocument: Map<string, Array<{ chunkId: string; page: number; similarity: number }>>
  ): RetrievedChunkDebugInfo {
    if (baseChunkIds.has(result.chunk.id)) {
      return {
        origin: 'base_retrieval',
        isNeighborChunk: false,
        neighborType: 'none'
      };
    }

    if (topBaseResult && result.document.id === topBaseResult.document.id) {
      const topChunkIndex = this.getEffectiveChunkIndex(topBaseResult.chunk);
      const candidateChunkIndex = this.getEffectiveChunkIndex(result.chunk);
      if (
        topChunkIndex !== null &&
        candidateChunkIndex !== null &&
        Math.abs(candidateChunkIndex - topChunkIndex) === 1
      ) {
        return {
          origin: 'neighbor_added',
          isNeighborChunk: true,
          neighborType: 'top_chunk_adjacent',
          neighborOfChunkId: topBaseResult.chunk.id,
          neighborRelation: candidateChunkIndex < topChunkIndex ? 'above' : 'below'
        };
      }
    }

    const candidatePage = this.getChunkPageNumber(result.chunk);
    if (candidatePage !== null) {
      const basePageEntries = basePagesByDocument.get(result.document.id) || [];
      const adjacentBasePages = basePageEntries
        .filter((entry) => Math.abs(entry.page - candidatePage) === 1)
        .sort((a, b) => b.similarity - a.similarity);

      if (adjacentBasePages.length > 0) {
        const bestNeighbor = adjacentBasePages[0];
        return {
          origin: 'neighbor_added',
          isNeighborChunk: true,
          neighborType: 'page_neighbor',
          neighborOfChunkId: bestNeighbor.chunkId,
          neighborRelation: candidatePage < bestNeighbor.page ? 'above' : 'below'
        };
      }
    }

    return {
      origin: 'neighbor_added',
      isNeighborChunk: true,
      neighborType: 'neighbor_unknown'
    };
  }

  private formatRetrievalAnchorWindowDebug(debug: RetrievalAnchorWindowDebug): string[] {
    const anchor = debug.anchor
      ? `anchor_page=${debug.anchor.page ?? 'unknown'} anchor_score=${debug.anchor.anchorScore.toFixed(3)} base_score=${debug.anchor.baseScore.toFixed(3)} intent_score=${debug.anchor.intentScore.toFixed(3)} anchor_chunks=${debug.anchor.chunkCount} margin_vs_next=${debug.anchor.marginVsNext.toFixed(3)}`
      : 'anchor_page=none';
    const localPages = debug.localPages.length > 0 ? debug.localPages.join(',') : 'none';
    const rankedPages = debug.rankedPageGroups.length > 0
      ? debug.rankedPageGroups
          .map((group) => `p${group.page ?? '?'}(score=${group.anchorScore.toFixed(3)},base=${group.baseScore.toFixed(3)},intent=${group.intentScore.toFixed(3)},chunks=${group.chunkCount})`)
          .join(' | ')
      : 'none';

    return [
      `[RETRIEVAL ANCHOR WINDOW] mode=${debug.mode} intent=${debug.queryIntent ?? 'unknown'} ${anchor} local_pages=${localPages} local_base_chunks=${debug.localBaseChunkCount} local_window_chunks=${debug.localWindowChunkCount}`,
      `[RETRIEVAL ANCHOR WINDOW RANKED PAGES] ${rankedPages}`,
      `[RETRIEVAL ANCHOR WINDOW REASON] ${debug.reason}`,
    ];
  }

  private formatGenerationPageSelectionDebug(debug: GenerationPageSelectionDebug): string[] {
    const strongestCluster = debug.strongestCluster
      ? `strongest_page=${debug.strongestCluster.page ?? 'unknown'} strongest_score=${debug.strongestCluster.score.toFixed(3)} strongest_chunks=${debug.strongestCluster.chunkCount}`
      : 'strongest_page=none';
    const preferredPages = debug.preferredLocalWindow?.pages?.length
      ? debug.preferredLocalWindow.pages.join(',')
      : 'none';
    const rankedClusters = debug.rankedClusters.length > 0
      ? debug.rankedClusters
          .map((cluster) => `p${cluster.page ?? '?'}(score=${cluster.score.toFixed(3)},chunks=${cluster.chunkCount},preferred=${cluster.preferredLocal ? 'yes' : 'no'})`)
          .join(' | ')
      : 'none';
    const selectedPages = debug.selectedPages.length > 0
      ? debug.selectedPages
          .map((page) => `p${page.page ?? '?'}(count=${page.count})`)
          .join(' | ')
      : 'none';

    return [
      `[MODEL PAGE SELECTION] ${strongestCluster} local_focus=${debug.localFocusActive ? 'yes' : 'no'} preferred_window=${preferredPages} selected_chunks=${debug.selectedChunkCount}`,
      `[MODEL PAGE SELECTION RANKED CLUSTERS] ${rankedClusters}`,
      `[MODEL PAGE SELECTION SELECTED PAGES] ${selectedPages}`,
    ];
  }

  private logRetrievedChunkDetails(
    retrievedChunks: VectorSearchResult[],
    generationChunks: VectorSearchResult[],
    baseSearchResults: VectorSearchResult[],
    generationDecisionsByChunkId: Map<string, RetrievedChunkGenerationDecision>
  ): void {
    if (retrievedChunks.length === 0) {
      console.log('[RETRIEVAL CHUNK DEBUG] No chunks were found.');
      return;
    }

    const baseChunkIds = new Set(baseSearchResults.map((result) => result.chunk.id));
    const topBaseResult = baseSearchResults.length > 0
      ? baseSearchResults.reduce((best, current) => (current.similarity > best.similarity ? current : best))
      : null;
    const basePagesByDocument = new Map<string, Array<{ chunkId: string; page: number; similarity: number }>>();

    for (const baseResult of baseSearchResults) {
      const page = this.getChunkPageNumber(baseResult.chunk);
      if (page === null) continue;
      const current = basePagesByDocument.get(baseResult.document.id) || [];
      current.push({
        chunkId: baseResult.chunk.id,
        page,
        similarity: baseResult.similarity
      });
      basePagesByDocument.set(baseResult.document.id, current);
    }

    const rankedResults = [...retrievedChunks].sort((a, b) => b.similarity - a.similarity);
    const chunkNumberById = new Map<string, number>(
      rankedResults.map((result, index) => [result.chunk.id, index + 1])
    );

    console.log('\n=== RETRIEVAL CHUNK DEBUG START ===');
    console.log('[MODEL INPUT SUMMARY]', {
      totalChunksRetrieved: retrievedChunks.length,
      totalChunksFedToModel: generationChunks.length, // Only the capped ones
      baseRetrievedChunks: baseSearchResults.length,
      neighborChunksAdded: Math.max(0, retrievedChunks.length - baseSearchResults.length),
      generationFloorApplied: retrievedChunks.length > generationChunks.length,
    });
    if (this.lastRetrievalAnchorWindowDebug) {
      this.formatRetrievalAnchorWindowDebug(this.lastRetrievalAnchorWindowDebug)
        .forEach((line) => console.log(line));
    }
    if (this.lastGenerationPageSelectionDebug) {
      this.formatGenerationPageSelectionDebug(this.lastGenerationPageSelectionDebug)
        .forEach((line) => console.log(line));
    }

    console.log('\n=== RETRIEVAL CHUNK CONTENT START ===');
    rankedResults.forEach((result, index) => {
      const rank = index + 1;
      const wasFedToModel = generationChunks.some(g => g.chunk.id === result.chunk.id);
      const generationDecision = generationDecisionsByChunkId.get(result.chunk.id);
      const modelInputOrder = retrievedChunks.findIndex((item) => item.chunk.id === result.chunk.id) + 1;
      const debugInfo = this.classifyRetrievedChunkForDebug(
        result,
        baseChunkIds,
        topBaseResult,
        basePagesByDocument
      );
      const chunkPage = this.getChunkPageNumber(result.chunk);
      const rawChunkContent = result.chunk.content || '';
      const chunkContentParagraph = rawChunkContent.replace(/\s+/g, ' ').trim();
      const neighborChunkNumber = debugInfo.neighborOfChunkId
        ? chunkNumberById.get(debugInfo.neighborOfChunkId)
        : undefined;
      const reasonSuffix = !wasFedToModel && generationDecision?.reason
        ? ` [REASON: ${generationDecision.reason}]`
        : '';

      console.log('--------------------------------------------------');
      if (debugInfo.isNeighborChunk) {
        const neighborOffset = debugInfo.neighborRelation === 'above' ? '-1' : '+1';
        const neighborChunkLabel = neighborChunkNumber ? `Chunk ${neighborChunkNumber}` : 'Chunk ?';
        console.log(`${neighborOffset} Neighbor chunk ${neighborChunkLabel} | Similarity score: ${result.similarity.toFixed(3)} | Fed to generator: ${wasFedToModel ? 'YES' : 'NO'}${reasonSuffix}`);
      } else {
        console.log(`Chunk ${rank} | Similarity score: ${result.similarity.toFixed(3)} | Fed to generator: ${wasFedToModel ? 'YES' : 'NO'}${reasonSuffix}`);
      }
      console.log(`Page: ${chunkPage ?? 'N/A'} | Document title: ${result.document.title}`);
      console.log('Content:');
      console.log(chunkContentParagraph);
    });
    console.log('--------------------------------------------------');
    console.log('=== RETRIEVAL CHUNK CONTENT END ===');

    console.log('=== RETRIEVAL CHUNK DEBUG END ===\n');
  }

  private includeNeighborPageChunks(
    baseResults: VectorSearchResult[],
    sessionEmbeddings: EmbeddingChunk[],
    queryEmbedding: Float32Array,
    minSimilarity: number = 0.6
  ): VectorSearchResult[] {
    if (baseResults.length === 0 || sessionEmbeddings.length === 0) {
      console.log(
        '[NEIGHBOR PAGES] Skipped (insufficient input): baseResults=%d embeddings=%d',
        baseResults.length,
        sessionEmbeddings.length
      );
      return baseResults;
    }

    const existingChunkIds = new Set(baseResults.map((r) => r.chunk.id));
    const docInfoById = new Map(baseResults.map((r) => [r.document.id, r.document]));
    const pagesByDoc = new Map<string, number[]>();
    const targetNeighborPages = new Set<string>();

    for (const result of baseResults) {
      const page = this.getChunkPageNumber(result.chunk);
      if (!page) continue;
      const current = pagesByDoc.get(result.document.id) || [];
      current.push(page);
      pagesByDoc.set(result.document.id, current);
    }

    for (const [documentId, pages] of pagesByDoc.entries()) {
      if (pages.length === 0) continue;

      const uniqueSortedPages = Array.from(new Set(pages)).sort((a, b) => a - b);
      let blockStart = uniqueSortedPages[0];
      let previous = uniqueSortedPages[0];

      for (let i = 1; i < uniqueSortedPages.length; i++) {
        const current = uniqueSortedPages[i];
        if (current === previous + 1) {
          previous = current;
          continue;
        }

        // Close previous contiguous block [blockStart..previous]
        if (blockStart > 1) {
          targetNeighborPages.add(`${documentId}:${blockStart - 1}`);
        }
        targetNeighborPages.add(`${documentId}:${previous + 1}`);

        // Start a new block.
        blockStart = current;
        previous = current;
      }

      // Close final block.
      if (blockStart > 1) {
        targetNeighborPages.add(`${documentId}:${blockStart - 1}`);
      }
      targetNeighborPages.add(`${documentId}:${previous + 1}`);
    }

    const targetNeighborPageList = Array.from(targetNeighborPages).sort();
    console.log(
      '[NEIGHBOR PAGES] Candidate edge pages=%d threshold=%.2f pages=%o',
      targetNeighborPageList.length,
      minSimilarity,
      targetNeighborPageList
    );

    if (targetNeighborPages.size === 0) {
      console.log('[NEIGHBOR PAGES] No candidate edge pages from retrieved blocks.');
      return baseResults;
    }

    const bestCandidateByPage = new Map<string, { chunk: EmbeddingChunk; similarity: number }>();
    let matchedNeighborPageChunks = 0;
    let passedThresholdChunks = 0;
    for (const chunk of sessionEmbeddings) {
      if (existingChunkIds.has(chunk.id)) continue;

      const page = this.getChunkPageNumber(chunk);
      if (!page) continue;

      const pageKey = `${chunk.documentId}:${page}`;
      if (!targetNeighborPages.has(pageKey)) continue;
      matchedNeighborPageChunks += 1;

      const similarity = cosineSimilarity(queryEmbedding, chunk.embedding);
      if (similarity < minSimilarity) continue;
      passedThresholdChunks += 1;

      const current = bestCandidateByPage.get(pageKey);
      if (!current || similarity > current.similarity) {
        bestCandidateByPage.set(pageKey, { chunk, similarity });
      }
    }

    const additions = Array.from(bestCandidateByPage.values())
      .sort((a, b) => b.similarity - a.similarity)
      .map(({ chunk, similarity }) => {
        const existingDocInfo = docInfoById.get(chunk.documentId);
        const title = existingDocInfo?.title || chunk.metadata?.documentTitle || chunk.source || 'Document';
        const fileName = existingDocInfo?.fileName || chunk.source || title;
        return {
          chunk,
          similarity,
          document: {
            id: chunk.documentId,
            title,
            fileName
          }
        } as VectorSearchResult;
      });

    if (additions.length > 0) {
      console.log(
        '[NEIGHBOR PAGES] Added %d edge-neighbor chunk(s) [threshold=%.2f]: %o',
        additions.length,
        minSimilarity,
        additions.map((r) => ({
          chunkId: r.chunk.id,
          documentId: r.document.id,
          page: this.getChunkPageNumber(r.chunk),
          similarity: r.similarity
        }))
      );
    } else {
      console.log(
        '[NEIGHBOR PAGES] Attempted but added 0 chunk(s): candidatePages=%d matchedChunks=%d passedThreshold=%d threshold=%.2f',
        targetNeighborPages.size,
        matchedNeighborPageChunks,
        passedThresholdChunks,
        minSimilarity
      );
    }

    return [...baseResults, ...additions].sort((a, b) => b.similarity - a.similarity);
  }

  private getEffectiveChunkIndex(chunk: EmbeddingChunk): number | null {
    if (Number.isFinite(chunk.chunkIndex)) return chunk.chunkIndex;
    if (Number.isFinite(chunk.metadata?.chunkIndex)) return chunk.metadata.chunkIndex;
    return null;
  }

  private includeTopChunkAdjacentChunks(
    baseResults: VectorSearchResult[],
    sessionEmbeddings: EmbeddingChunk[],
    queryEmbedding: Float32Array,
    queryText: string = '',
    queryIntent?: QueryIntent,
    minSimilarity: number = 0.12,
    maxTotal: number = 16,
    topResultsToExpand: number = 3,
    chunkSpan: number = 2
  ): VectorSearchResult[] {
    if (baseResults.length === 0 || sessionEmbeddings.length === 0) {
      this.lastRetrievalAnchorWindowDebug = {
        mode: 'insufficient_input',
        queryIntent,
        anchor: null,
        localPages: [],
        localBaseChunkCount: 0,
        localWindowChunkCount: 0,
        rankedPageGroups: [],
        reason: 'Skipped anchor-window retrieval because base results or embeddings were unavailable.',
      };
      console.log(
        '[TOP CHUNK CONTEXT] Skipped (insufficient input): baseResults=%d embeddings=%d',
        baseResults.length,
        sessionEmbeddings.length
      );
      return baseResults;
    }

    const availableSlots = Math.max(0, maxTotal - baseResults.length);
    if (availableSlots <= 0) {
      this.lastRetrievalAnchorWindowDebug = {
        mode: 'insufficient_input',
        queryIntent,
        anchor: null,
        localPages: [],
        localBaseChunkCount: baseResults.length,
        localWindowChunkCount: baseResults.length,
        rankedPageGroups: [],
        reason: 'Skipped anchor-window expansion because there was no retrieval headroom.',
      };
      console.log(
        '[TOP CHUNK CONTEXT] Skipped (no space): current=%d maxTotal=%d',
        baseResults.length,
        maxTotal
      );
      return baseResults;
    }

    const existingChunkIds = new Set(baseResults.map((r) => r.chunk.id));
    const docInfoById = new Map(baseResults.map((r) => [r.document.id, r.document] as const));
    type RetrievalCandidate = {
      chunk: EmbeddingChunk;
      similarity: number;
      document: {
        id: string;
        title: string;
        fileName: string;
      };
    };
    const pageGroups = new Map<string, {
      docId: string;
      page: number;
      chunks: VectorSearchResult[];
      score: number;
      richness: number;
      intentScore: number;
      anchorScore: number;
      chapterCue: string | null;
    }>();

    for (const result of baseResults) {
      const page = this.getChunkPageNumber(result.chunk);
      if (page === null) continue;
      const key = `${result.document.id}:${page}`;
      const existing = pageGroups.get(key);
      if (existing) {
        existing.chunks.push(result);
        existing.score = Math.max(existing.score, result.similarity);
      } else {
        pageGroups.set(key, {
          docId: result.document.id,
          page,
          chunks: [result],
          score: result.similarity,
          richness: 0,
          intentScore: 0,
          anchorScore: 0,
          chapterCue: this.extractChapterCueFromText(result.chunk.content || ''),
        });
      }
    }

    for (const group of pageGroups.values()) {
      group.richness = this.calculatePageRichness(group.chunks);
      group.score = Math.min(1, group.score + group.richness);
      group.intentScore = this.scoreRetrievalIntentAlignment(
        group.chunks.map((chunk) => chunk.chunk.content || '').join('\n'),
        queryIntent
      );
      group.anchorScore = group.score + (Math.min(group.chunks.length - 1, 2) * 0.06) + group.intentScore;
      if (!group.chapterCue) {
        group.chapterCue = group.chunks
          .map((chunk) => this.extractChapterCueFromText(chunk.chunk.content || ''))
          .find((cue) => Boolean(cue)) || null;
      }
    }

    const rankedPageGroups = Array.from(pageGroups.entries())
      .sort((a, b) => {
        if (b[1].anchorScore !== a[1].anchorScore) return b[1].anchorScore - a[1].anchorScore;
        return b[1].score - a[1].score;
      })
      .slice(0, Math.min(topResultsToExpand, pageGroups.size));

    console.log(
      '[TOP CHUNK CONTEXT] Focused on top page clusters=%o slots=%d threshold=%.2f span=%d',
      rankedPageGroups.map(([key, group]) => ({
        key,
        docId: group.docId,
        page: group.page,
        chunkCount: group.chunks.length,
        score: Number(group.score.toFixed(3)),
        intentScore: Number(group.intentScore.toFixed(3)),
        anchorScore: Number(group.anchorScore.toFixed(3)),
      })),
      availableSlots,
      minSimilarity,
      chunkSpan
    );

    const wantsPositionalStructure = /\b(position|positions|location|locations|anatomical|anatomy|where)\b/i.test(queryText);

    const structuredSignals = (text: string): boolean => {
      const normalized = (text || '').toLowerCase();
      return (
        /\btable\b/.test(normalized) ||
        /\bfigure\b/.test(normalized) ||
        /\bfig\b/.test(normalized) ||
        /\bsummary box\b/.test(normalized) ||
        /\bbox\b/.test(normalized) ||
        /\bcaption\b/.test(normalized) ||
        /\bcriteria list\b/.test(normalized) ||
        /\bcriteria\b/.test(normalized) ||
        (wantsPositionalStructure &&
          (
            /\banatomy\b/.test(normalized) ||
            /\banatomical\b/.test(normalized) ||
            /\boverview\b/.test(normalized) ||
            /\bintroduction\b/.test(normalized) ||
            /\bintro\b/.test(normalized) ||
            /\bposition\b/.test(normalized) ||
            /\bpositions\b/.test(normalized) ||
            /\blocation\b/.test(normalized) ||
            /\blocations\b/.test(normalized)
          ))
      );
    };

    const buildCandidate = (chunk: EmbeddingChunk): RetrievalCandidate => ({
      chunk,
      similarity: cosineSimilarity(queryEmbedding, chunk.embedding),
      document: docInfoById.get(chunk.documentId) || {
        id: chunk.documentId,
        title: chunk.metadata?.documentTitle || chunk.source || 'Document',
        fileName: chunk.source || chunk.metadata?.documentTitle || 'Document',
      },
    });

    const candidatesByChunkId = new Map<string, RetrievalCandidate>();
    const embeddingsByDocAndIndex = new Map<string, Map<number, EmbeddingChunk>>();

    for (const chunk of sessionEmbeddings) {
      const chunkIndex = this.getEffectiveChunkIndex(chunk);
      if (chunkIndex === null) continue;
      const perDoc = embeddingsByDocAndIndex.get(chunk.documentId) || new Map<number, EmbeddingChunk>();
      perDoc.set(chunkIndex, chunk);
      embeddingsByDocAndIndex.set(chunk.documentId, perDoc);
    }

    const strongestGroup = rankedPageGroups[0]?.[1] || null;
    const secondGroup = rankedPageGroups[1]?.[1] || null;
    const anchorMargin = strongestGroup
      ? strongestGroup.anchorScore - (secondGroup?.anchorScore ?? (strongestGroup.anchorScore - 0.05))
      : 0;
    const stopDrift = strongestGroup ? this.isPageCoverageStrong(strongestGroup.chunks) : false;
    let bridgeCandidateCount = 0;
    let localWindowCandidateCount = 0;
    const localPages = strongestGroup && strongestGroup.page !== null
      ? [strongestGroup.page - 1, strongestGroup.page, strongestGroup.page + 1].filter((page) => page > 0)
      : [];
    const isLocalFocusPage = (docId: string, page: number | null): boolean =>
      Boolean(
        strongestGroup &&
        strongestGroup.page !== null &&
        page !== null &&
        docId === strongestGroup.docId &&
        Math.abs(page - strongestGroup.page) <= 1
      );
    const anchorWindowEligible = Boolean(
      strongestGroup &&
      strongestGroup.page !== null &&
      (
        strongestGroup.anchorScore >= 0.78 ||
        strongestGroup.intentScore >= 0.12 ||
        strongestGroup.chunks.length >= 2 ||
        anchorMargin >= 0.06
      )
    );

    const buildLocalWindowResults = (): VectorSearchResult[] => {
      if (!strongestGroup || strongestGroup.page === null) return [];

      const localResultsByChunkId = new Map<string, VectorSearchResult>();
      const strongestIndices = strongestGroup.chunks
        .map((chunk) => this.getEffectiveChunkIndex(chunk.chunk))
        .filter((index): index is number => index !== null)
        .sort((a, b) => a - b);
      const localWindowStart = strongestIndices.length > 0
        ? Math.max(0, strongestIndices[0] - Math.max(2, chunkSpan))
        : 0;
      const localWindowEnd = strongestIndices.length > 0
        ? strongestIndices[strongestIndices.length - 1] + Math.max(8, chunkSpan * 4)
        : Number.MAX_SAFE_INTEGER;

      for (const result of baseResults) {
        const page = this.getChunkPageNumber(result.chunk);
        if (
          result.document.id === strongestGroup.docId &&
          page !== null &&
          localPages.includes(page)
        ) {
          localResultsByChunkId.set(result.chunk.id, result);
        }
      }

      for (const chunk of sessionEmbeddings) {
        if (chunk.documentId !== strongestGroup.docId) continue;
        if (localResultsByChunkId.has(chunk.id)) continue;

        const page = this.getChunkPageNumber(chunk);
        const chunkIndex = this.getEffectiveChunkIndex(chunk);
        if (page === null || !localPages.includes(page)) continue;

        const candidate = buildCandidate(chunk);
        if (page === strongestGroup.page) {
          localResultsByChunkId.set(chunk.id, {
            chunk,
            similarity: Math.max(candidate.similarity, 0.01),
            document: candidate.document,
          });
          continue;
        }

        const nearLocalWindow =
          chunkIndex !== null &&
          chunkIndex >= localWindowStart &&
          chunkIndex <= localWindowEnd;
        const continuationSignal = this.hasLocalContinuationSignals(chunk.content || '', queryIntent);

        if (nearLocalWindow && (candidate.similarity >= 0.02 || continuationSignal)) {
          localResultsByChunkId.set(chunk.id, candidate);
        }
      }

      return Array.from(localResultsByChunkId.values()).sort((a, b) => {
        const aPage = this.getChunkPageNumber(a.chunk);
        const bPage = this.getChunkPageNumber(b.chunk);
        const aPageDistance = aPage !== null ? Math.abs(aPage - strongestGroup.page) : 99;
        const bPageDistance = bPage !== null ? Math.abs(bPage - strongestGroup.page) : 99;
        if (aPageDistance !== bPageDistance) return aPageDistance - bPageDistance;
        const aIndex = this.getEffectiveChunkIndex(a.chunk);
        const bIndex = this.getEffectiveChunkIndex(b.chunk);
        if (aIndex !== null && bIndex !== null && strongestIndices.length > 0) {
          const strongestMin = Math.min(...strongestIndices);
          const strongestMax = Math.max(...strongestIndices);
          const aDistance = aIndex < strongestMin ? strongestMin - aIndex : aIndex > strongestMax ? aIndex - strongestMax : 0;
          const bDistance = bIndex < strongestMin ? strongestMin - bIndex : bIndex > strongestMax ? bIndex - strongestMax : 0;
          if (aDistance !== bDistance) return aDistance - bDistance;
        }
        return b.similarity - a.similarity;
      });
    };

    const localWindowResults = anchorWindowEligible ? buildLocalWindowResults() : [];
    const localBaseChunkCount = baseResults.filter((result) => {
      const page = this.getChunkPageNumber(result.chunk);
      return strongestGroup && strongestGroup.page !== null && result.document.id === strongestGroup.docId && page !== null && localPages.includes(page);
    }).length;
    localWindowCandidateCount = Math.max(0, localWindowResults.length - localBaseChunkCount);
    const anchorPageChunkCount = localWindowResults.filter((result) => this.getChunkPageNumber(result.chunk) === strongestGroup?.page).length;
    const localWindowStrong = Boolean(
      strongestGroup &&
      anchorWindowEligible &&
      (
        (anchorPageChunkCount >= 2 && localWindowResults.length >= 4) ||
        strongestGroup.intentScore >= 0.16 ||
        (strongestGroup.chunks.length >= 2 && localWindowResults.length >= 3)
      )
    );

    if (anchorWindowEligible && localWindowStrong && localWindowResults.length > 0) {
      this.lastRetrievalAnchorWindowDebug = {
        mode: 'anchor_window_only',
        queryIntent,
        anchor: strongestGroup
          ? {
              documentId: strongestGroup.docId,
              page: strongestGroup.page,
              anchorScore: Number(strongestGroup.anchorScore.toFixed(3)),
              baseScore: Number(strongestGroup.score.toFixed(3)),
              intentScore: Number(strongestGroup.intentScore.toFixed(3)),
              chunkCount: strongestGroup.chunks.length,
              marginVsNext: Number(anchorMargin.toFixed(3)),
            }
          : null,
        localPages,
        localBaseChunkCount,
        localWindowChunkCount: localWindowResults.length,
        rankedPageGroups: rankedPageGroups.map(([, group]) => ({
          documentId: group.docId,
          page: group.page,
          anchorScore: Number(group.anchorScore.toFixed(3)),
          baseScore: Number(group.score.toFixed(3)),
          intentScore: Number(group.intentScore.toFixed(3)),
          chunkCount: group.chunks.length,
        })),
        reason: 'Strong anchor page identified; using anchor page plus adjacent continuation window before any remote pages.',
      };

      console.log('[ANCHOR WINDOW RETRIEVAL] Using local anchor window only: %o', this.lastRetrievalAnchorWindowDebug);
      return localWindowResults.slice(0, Math.min(maxTotal, Math.max(baseResults.length, localWindowResults.length)));
    }

    const baseResultsByDoc = new Map<string, VectorSearchResult[]>();
    for (const result of baseResults) {
      const current = baseResultsByDoc.get(result.document.id) || [];
      current.push(result);
      baseResultsByDoc.set(result.document.id, current);
    }

    for (const [documentId, docResults] of baseResultsByDoc.entries()) {
      const sortedDocResults = docResults
        .map((result) => ({ result, chunkIndex: this.getEffectiveChunkIndex(result.chunk) }))
        .filter((item): item is { result: VectorSearchResult; chunkIndex: number } => item.chunkIndex !== null)
        .sort((a, b) => a.chunkIndex - b.chunkIndex);

      const indexedEmbeddings = embeddingsByDocAndIndex.get(documentId);
      if (!indexedEmbeddings || sortedDocResults.length < 2) continue;

      for (let i = 0; i < sortedDocResults.length - 1; i++) {
        const current = sortedDocResults[i];
        const next = sortedDocResults[i + 1];
        const missingCount = next.chunkIndex - current.chunkIndex - 1;

        if (missingCount <= 0 || missingCount > chunkSpan) {
          continue;
        }

        for (let missingIndex = current.chunkIndex + 1; missingIndex < next.chunkIndex; missingIndex++) {
          const missingChunk = indexedEmbeddings.get(missingIndex);
          if (!missingChunk || existingChunkIds.has(missingChunk.id) || candidatesByChunkId.has(missingChunk.id)) {
            continue;
          }

          const candidate = buildCandidate(missingChunk);
          const pageDistance =
            Math.abs((this.getChunkPageNumber(current.result.chunk) || 0) - (this.getChunkPageNumber(missingChunk) || 0)) <= 1 &&
            Math.abs((this.getChunkPageNumber(next.result.chunk) || 0) - (this.getChunkPageNumber(missingChunk) || 0)) <= 1;

          if (candidate.similarity >= Math.max(0.05, minSimilarity * 0.6) || pageDistance) {
            candidatesByChunkId.set(candidate.chunk.id, candidate);
            bridgeCandidateCount += 1;
          }
        }
      }
    }

    for (const [, group] of rankedPageGroups) {
      const samePageCandidates = sessionEmbeddings
        .filter((chunk) => chunk.documentId === group.docId && this.getChunkPageNumber(chunk) === group.page)
        .filter((chunk) => !existingChunkIds.has(chunk.id))
        .map((chunk) => buildCandidate(chunk))
        .filter((candidate) => candidate.similarity >= minSimilarity || structuredSignals(candidate.chunk.content))
        .sort((a, b) => b.similarity - a.similarity);

      for (const candidate of samePageCandidates) {
        if (!candidatesByChunkId.has(candidate.chunk.id)) {
          candidatesByChunkId.set(candidate.chunk.id, candidate);
        }
      }

      const allowImmediateContinuation =
        strongestGroup !== null &&
        group.docId === strongestGroup.docId &&
        group.page === strongestGroup.page;

      if ((stopDrift && !allowImmediateContinuation) || (!allowImmediateContinuation && !this.isPageThin(group.chunks, samePageCandidates.length))) {
        continue;
      }

      const fallbackPages = allowImmediateContinuation
        ? [group.page - 1, group.page + 1].filter((page) => page > 0)
        : [group.page - 1, group.page + 1, group.page - 2, group.page + 2].filter((page) => page > 0);
      for (const page of fallbackPages) {
        const fallbackCandidates = sessionEmbeddings
          .filter((chunk) => {
            if (chunk.documentId !== group.docId || this.getChunkPageNumber(chunk) !== page) return false;
            if (!group.chapterCue) return true;
            const candidateCue = this.extractChapterCueFromText(chunk.content || '');
            return !candidateCue || candidateCue === group.chapterCue || Math.abs(page - group.page) === 1;
          })
          .filter((chunk) => !existingChunkIds.has(chunk.id) && !candidatesByChunkId.has(chunk.id))
          .map((chunk) => buildCandidate(chunk))
          .filter((candidate) => {
            if (!allowImmediateContinuation) {
              return candidate.similarity >= Math.max(0.08, minSimilarity * 0.85);
            }

            const candidateIndex = this.getEffectiveChunkIndex(candidate.chunk);
            const strongestIndices = group.chunks
              .map((item) => this.getEffectiveChunkIndex(item.chunk))
              .filter((index): index is number => index !== null);
            const nearStrongestChunk =
              candidateIndex !== null &&
              strongestIndices.some((index) => Math.abs(index - candidateIndex) <= Math.max(3, chunkSpan * 2));

            return candidate.similarity >= Math.max(0.02, minSimilarity * 0.35) || nearStrongestChunk;
          })
          .sort((a, b) => b.similarity - a.similarity);

        for (const candidate of fallbackCandidates) {
          if (!candidatesByChunkId.has(candidate.chunk.id)) {
            candidatesByChunkId.set(candidate.chunk.id, candidate);
          }
        }
      }
    }

    if (candidatesByChunkId.size === 0) {
      this.lastRetrievalAnchorWindowDebug = {
        mode: anchorWindowEligible ? 'anchor_window_plus_fallback' : 'multi_page_fallback',
        queryIntent,
        anchor: strongestGroup
          ? {
              documentId: strongestGroup.docId,
              page: strongestGroup.page,
              anchorScore: Number(strongestGroup.anchorScore.toFixed(3)),
              baseScore: Number(strongestGroup.score.toFixed(3)),
              intentScore: Number(strongestGroup.intentScore.toFixed(3)),
              chunkCount: strongestGroup.chunks.length,
              marginVsNext: Number(anchorMargin.toFixed(3)),
            }
          : null,
        localPages,
        localBaseChunkCount,
        localWindowChunkCount: localWindowResults.length,
        rankedPageGroups: rankedPageGroups.map(([, group]) => ({
          documentId: group.docId,
          page: group.page,
          anchorScore: Number(group.anchorScore.toFixed(3)),
          baseScore: Number(group.score.toFixed(3)),
          intentScore: Number(group.intentScore.toFixed(3)),
          chunkCount: group.chunks.length,
        })),
        reason: 'No extra local-window candidates were added; returning base retrieval results.',
      };
      console.log('[TOP CHUNK CONTEXT] Attempted but added 0 chunk(s).');
      return baseResults;
    }

    if (bridgeCandidateCount > 0) {
      console.log('[TOP CHUNK CONTEXT] Added %d chunk-gap bridge candidate(s).', bridgeCandidateCount);
    }

    if (localWindowCandidateCount > 0) {
      console.log('[TOP CHUNK CONTEXT] Added %d strongest-page local-window candidate(s).', localWindowCandidateCount);
    }

    const additions = Array.from(candidatesByChunkId.values())
      .sort((a, b) => {
        const aLocalFocus = isLocalFocusPage(a.chunk.documentId, this.getChunkPageNumber(a.chunk));
        const bLocalFocus = isLocalFocusPage(b.chunk.documentId, this.getChunkPageNumber(b.chunk));
        if (aLocalFocus !== bLocalFocus) return aLocalFocus ? -1 : 1;
        const aIndex = this.getEffectiveChunkIndex(a.chunk);
        const bIndex = this.getEffectiveChunkIndex(b.chunk);
        if (strongestGroup && strongestGroup.page !== null && aIndex !== null && bIndex !== null) {
          const strongestIndices = strongestGroup.chunks
            .map((result) => this.getEffectiveChunkIndex(result.chunk))
            .filter((index): index is number => index !== null);
          if (strongestIndices.length > 0) {
            const strongestMin = Math.min(...strongestIndices);
            const strongestMax = Math.max(...strongestIndices);
            const aDistance = aIndex < strongestMin ? strongestMin - aIndex : aIndex > strongestMax ? aIndex - strongestMax : 0;
            const bDistance = bIndex < strongestMin ? strongestMin - bIndex : bIndex > strongestMax ? bIndex - strongestMax : 0;
            if (aDistance !== bDistance) return aDistance - bDistance;
          }
        }
        const aGap = baseResults.some((result) => {
          if (result.document.id !== a.chunk.documentId) return false;
          const anchorIndex = this.getEffectiveChunkIndex(result.chunk);
          const candidateIndex = this.getEffectiveChunkIndex(a.chunk);
          return anchorIndex !== null && candidateIndex !== null && Math.abs(anchorIndex - candidateIndex) <= chunkSpan;
        });
        const bGap = baseResults.some((result) => {
          if (result.document.id !== b.chunk.documentId) return false;
          const anchorIndex = this.getEffectiveChunkIndex(result.chunk);
          const candidateIndex = this.getEffectiveChunkIndex(b.chunk);
          return anchorIndex !== null && candidateIndex !== null && Math.abs(anchorIndex - candidateIndex) <= chunkSpan;
        });
        if (aGap !== bGap) return aGap ? -1 : 1;
        return b.similarity - a.similarity;
      })
      .slice(0, availableSlots);

    console.log(
      '[TOP CHUNK CONTEXT] Added %d nearby chunk(s): %o',
      additions.length,
      additions.map((a) => ({
        chunkId: a.chunk.id,
        page: this.getChunkPageNumber(a.chunk),
        similarity: Number(a.similarity.toFixed(3))
      }))
    );

    this.lastRetrievalAnchorWindowDebug = {
      mode: anchorWindowEligible ? 'anchor_window_plus_fallback' : 'multi_page_fallback',
      queryIntent,
      anchor: strongestGroup
        ? {
            documentId: strongestGroup.docId,
            page: strongestGroup.page,
            anchorScore: Number(strongestGroup.anchorScore.toFixed(3)),
            baseScore: Number(strongestGroup.score.toFixed(3)),
            intentScore: Number(strongestGroup.intentScore.toFixed(3)),
            chunkCount: strongestGroup.chunks.length,
            marginVsNext: Number(anchorMargin.toFixed(3)),
          }
        : null,
      localPages,
      localBaseChunkCount,
      localWindowChunkCount: localWindowResults.length,
      rankedPageGroups: rankedPageGroups.map(([, group]) => ({
        documentId: group.docId,
        page: group.page,
        anchorScore: Number(group.anchorScore.toFixed(3)),
        baseScore: Number(group.score.toFixed(3)),
        intentScore: Number(group.intentScore.toFixed(3)),
        chunkCount: group.chunks.length,
      })),
      reason: anchorWindowEligible
        ? 'Anchor page was identified but local window was too thin, so fallback pages were allowed.'
        : 'No strong anchor page was identified, so multi-page retrieval fallback remained enabled.',
    };

    return [...baseResults, ...additions.map(({ chunk, similarity, document }) => ({
      chunk,
      similarity,
      document
    }))];
  }

  /**
   * Rewrites the user query based on chat history to make it standalone.
   * Solves the "What are its causes?" problem.
   */
  private async generateStandaloneQuery(
    content: string,
    latestRewriteQueryResponse: string | null | undefined
  ): Promise<StandaloneRewriteResult> {
    const REWRITE_TIMEOUT_MS = 10000;
    const normalizedOriginal = this.normalizeStandaloneQueryShape(
      this.normalizeCommonMedicalTypos(content.trim().replace(/\s+/g, ' '))
    );
    this.rewriteTelemetry.totalRequests += 1;

    const normalizedLatestRewriteQueryResponse = typeof latestRewriteQueryResponse === 'string'
      ? latestRewriteQueryResponse.trim()
      : '';
    const immediateRewriteQuery = this.parseStructuredRewriteOutput(normalizedLatestRewriteQueryResponse);
    const hasImmediateContext = Boolean(immediateRewriteQuery);
    const rewriterSystemPrompt =
      'You rewrite medical user input into one high-quality standalone retrieval query. Preserve the user scope exactly. If the user asks for clinical features or features, expand only to patient history and physical examination findings; do not add investigations, imaging, diagnosis, treatment, management, classification, causes, or complications unless the user explicitly asked. Return strict JSON only.';
    const rewriterSystemPromptStrict =
      'Return STRICT JSON ONLY in this exact schema: {"query":"<standalone medical retrieval query>"}. Preserve scope exactly. For clinical features/features queries, expand only to history and physical examination findings unless the user explicitly asked for other facets. No markdown, no extra keys, no commentary.';

    const prompt = `
Rewrite the latest user query into one standalone retrieval query.
Return STRICT JSON ONLY:
{"query":"..."}

Goals:
1) Understand user intent and express it as a clearer, more complete query.
2) Expand short/fragmented wording into natural phrasing that improves retrieval.
3) Correct spelling/grammar.
4) Use ONLY the immediate previous assistant context below; ignore all other history.
5) If context is unrelated/absent, rewrite current query standalone without context.
6) Keep meaning faithful to user intent; do not invent a new topic.
7) If user asks for Rx or treatment in query, include BOTH medical and surgical treatment wording.
8) If user asks for clinical features or features, expand ONLY to patient history and physical examination findings.
9) Do NOT add investigations, imaging, diagnosis, treatment, management, classification, causes, complications, or any other extra facet unless the user explicitly asked for it.

Immediate Previous Rewrite Response (JSON):
${normalizedLatestRewriteQueryResponse || 'None'}

Latest User Query:
${normalizedOriginal}
`.trim();

    const strictPrompt = `
Return STRICT JSON ONLY:
{"query":"<standalone medical retrieval query>"}
Do not add markdown, code fences, labels, or extra keys.
Use ONLY immediate context below when needed.
Preserve user scope exactly.
If user asks for clinical features or features, expand only to patient history and physical examination findings.
Do not add investigations, imaging, diagnosis, treatment, management, classification, causes, or complications unless explicitly requested.

Immediate Previous Rewrite Response (JSON):
${normalizedLatestRewriteQueryResponse || 'None'}

Latest User Query:
${normalizedOriginal}
`.trim();

    console.log('[QUERY REWRITER CONTEXT]', {
      latestUserQuery: normalizedOriginal,
      latestRewriteQueryResponse: normalizedLatestRewriteQueryResponse || null,
      immediateRewriteQuery: immediateRewriteQuery || null,
      usedImmediateContext: hasImmediateContext,
    });
    console.log('[QUERY REWRITER PROMPT][SYSTEM][PRIMARY]', rewriterSystemPrompt);
    console.log('[QUERY REWRITER PROMPT][USER][PRIMARY]', prompt);

    try {
      const requestRewrite = async (
        rewritePrompt: string,
        systemPrompt: string,
        temperature: number
      ) => {
        return await groqService.generateResponseWithGroq(
          rewritePrompt,
          systemPrompt,
          'openai/gpt-oss-120b',
          {
            temperature,
            maxTokens: 128,
            timeoutMs: REWRITE_TIMEOUT_MS,
          }
        );
      };

      let rewrittenQuery = await groqService.generateResponseWithGroq(
        prompt,
        rewriterSystemPrompt,
        'openai/gpt-oss-120b',
        {
          temperature: 0.1,
          maxTokens: 180,
          timeoutMs: REWRITE_TIMEOUT_MS,
        }
      );
      console.log('[QUERY REWRITER RAW][PRIMARY]', rewrittenQuery);

      let cleanedQuery = this.parseStructuredRewriteOutput(rewrittenQuery);

      // Hard retry once with stricter prompt if primary output is empty.
      if (!cleanedQuery) {
        console.warn('[QUERY REWRITER]', 'Primary rewrite was empty. Retrying with strict prompt.');
        console.log('[QUERY REWRITER PROMPT][SYSTEM][STRICT]', rewriterSystemPromptStrict);
        console.log('[QUERY REWRITER PROMPT][USER][STRICT]', strictPrompt);
        rewrittenQuery = await requestRewrite(
          strictPrompt,
          rewriterSystemPromptStrict,
          0
        );
        console.log('[QUERY REWRITER RAW][STRICT]', rewrittenQuery);
        cleanedQuery = this.parseStructuredRewriteOutput(rewrittenQuery);
      }

      const rewriterRateLimitNotice = this.extractRateLimitNotice(cleanedQuery);
      if (rewriterRateLimitNotice) {
        console.warn('[QUERY REWRITER]', `Rate-limited rewrite response detected. Falling back to original query.`);
        this.rewriteTelemetry.fallbackDueToRateLimit += 1;
        this.rewriteTelemetry.fallbackToOriginal += 1;
        this.logRewriteTelemetrySummary();
        return {
          query: this.normalizeStandaloneQueryShape(normalizedOriginal),
          wasRewritten: false,
          usedImmediateContext: hasImmediateContext,
          mode: 'fallback_original',
        };
      }

      // Keep fallback simple: only reject empty output.
      const wordCount = cleanedQuery.split(/\s+/).filter(Boolean).length;
      if (!cleanedQuery || wordCount === 0) {
        console.warn('[QUERY REWRITER]', `Rejected weak rewrite "${cleanedQuery}". Falling back to "${normalizedOriginal}"`);
        this.rewriteTelemetry.fallbackDueToWeak += 1;
        this.rewriteTelemetry.fallbackToOriginal += 1;
        this.logRewriteTelemetrySummary();
        return {
          query: this.normalizeStandaloneQueryShape(normalizedOriginal),
          wasRewritten: false,
          usedImmediateContext: hasImmediateContext,
          mode: 'fallback_original',
        };
      }

      if (this.isLikelyTruncatedRewrite(cleanedQuery, normalizedOriginal)) {
        console.warn('[QUERY REWRITER]', `Rejected truncated rewrite "${cleanedQuery}". Falling back to "${normalizedOriginal}"`);
        this.rewriteTelemetry.fallbackDueToTruncated += 1;
        this.rewriteTelemetry.fallbackToOriginal += 1;
        this.logRewriteTelemetrySummary();
        return {
          query: this.normalizeStandaloneQueryShape(normalizedOriginal),
          wasRewritten: false,
          usedImmediateContext: hasImmediateContext,
          mode: 'fallback_original',
        };
      }

      const scopeAlignedQuery = this.enforceRewriteScope(
        normalizedOriginal,
        cleanedQuery,
        immediateRewriteQuery
      );
      const finalRewritten = this.normalizeStandaloneQueryShape(scopeAlignedQuery);
      const wasRewritten = finalRewritten.toLowerCase() !== normalizedOriginal.toLowerCase();
      if (wasRewritten) {
        this.rewriteTelemetry.rewritten += 1;
        if (hasImmediateContext) {
          this.rewriteTelemetry.rewrittenWithImmediateContext += 1;
        }
      }

      console.log('[QUERY REWRITER]', `Original: "${normalizedOriginal}" -> Rewritten: "${finalRewritten}"`);
      this.logRewriteTelemetrySummary();
      return {
        query: finalRewritten,
        wasRewritten,
        usedImmediateContext: hasImmediateContext,
        mode: 'rewritten',
      };

    } catch (error) {
      console.error('[QUERY REWRITER ERROR]', error);
      this.rewriteTelemetry.fallbackDueToError += 1;
      this.rewriteTelemetry.fallbackToOriginal += 1;
      this.logRewriteTelemetrySummary();
      return {
        query: this.normalizeStandaloneQueryShape(normalizedOriginal),
        wasRewritten: false,
        usedImmediateContext: hasImmediateContext,
        mode: 'fallback_original',
      };
    }
  }

  /**
   * Send a message and get AI response with RAG context
   */
  async sendMessage(
    sessionId: string,
    content: string,
    onStreamEvent?: (event: ChatStreamEvent) => void,
    userMessage?: MessageCreate
  ): Promise<void> {
    try {
      const pipelineStartMs = Date.now();
      let rewriteMs = 0;
      let retrievalMs = 0;
      let generationMs = 0;
      let postprocessMs = 0;

      console.log('\n=== CHAT PIPELINE PROCESS START ===');
      console.log('[USER INPUT]', `Session: ${sessionId}, Query: "${content}"`);

      // User message is now passed in as a parameter (already saved in chatStore)
      console.log('[MESSAGE STATUS]', 'User message already stored in database by chatStore');

      // Update progress: Query Rewriting (25%)
      if (onStreamEvent) {
        onStreamEvent({ type: 'status', message: 'Query Rewriting' });
      }
      // Note: We'll update the store progress in the chatStore's sendMessage function

      // Get enabled documents for the session
      const sessionForDocuments = await withStageTimeout(
        this.indexedDBServices.sessionService.getSession(sessionId),
        STAGE_TIMEOUT_MS.sessionLookup,
        'Session lookup'
      );
      if (!sessionForDocuments) {
        throw new Error('Session not found');
      }

      const retrievalMode: 'ann_rerank_v1' = 'ann_rerank_v1';
      console.log('[RETRIEVAL MODE]', retrievalMode);

      // 1. GENERATE STANDALONE QUERY
      // This converts "What are its causes?" -> "What are the causes of cataract?"
      console.log('[REWRITING]', 'Generating standalone query...');
      const rewriteStartMs = Date.now();
      const standaloneRewrite = await this.generateStandaloneQuery(
        content,
        sessionForDocuments.latestRewriteQueryResponse
      );
      const standaloneQuery = standaloneRewrite.query;
      rewriteMs = Date.now() - rewriteStartMs;
      await this.indexedDBServices.sessionService.updateSession(
        sessionId,
        { latestRewriteQueryResponse: this.buildRewriteQueryResponse(standaloneQuery) },
        sessionForDocuments.userId
      );
      const queryIntent = classifyQueryIntent(standaloneQuery);
      const answerContract = getAnswerContract(queryIntent);
      const contractInstruction = buildContractPromptInstructions(answerContract);
      console.log('[INTENT DETECTED]', queryIntent);
      console.log('[QUERY REWRITER RESULT]', {
        mode: standaloneRewrite.mode,
        wasRewritten: standaloneRewrite.wasRewritten,
        usedImmediateContext: standaloneRewrite.usedImmediateContext,
      });

      // 🔴 PROMINENT LOG: Show the converted query for tracking
      console.log('🔴 Converted query -:', `"${standaloneQuery}"`);

      // Update progress: Embedding Generation (50%)
      if (onStreamEvent) {
        onStreamEvent({ type: 'status', message: 'Embedding Generation' });
      }

      // 3. ENHANCE THE REWRITTEN QUERY, NOT THE ORIGINAL
      // Modify this line to pass 'standaloneQuery' instead of 'content'
      const enhancedQuery = await this.enhanceQueryWithContext(sessionId, standaloneQuery, queryIntent);
      const retrievalQuery = enhancedQuery;
      console.log('[FINAL SEARCH QUERY]', enhancedQuery);

      const documents = await this.indexedDBServices.documentService.getDocumentsBySession(sessionId, sessionForDocuments.userId);
      console.log('[DOCUMENT STATUS]', `Found ${documents.length} total documents in session ${sessionId}`);
      console.log('[DOCUMENT STATUS]', 'Document details:', documents.map(doc => ({
        id: doc.id,
        filename: doc.filename,
        enabled: doc.enabled,
        status: doc.status
      })));

      const enabledDocuments = documents.filter(doc => doc.enabled);
      console.log('[DOCUMENT STATUS]', `${enabledDocuments.length}/${documents.length} documents enabled`);

      const retrievalDocuments = await this.resolveRetrievalDocuments(sessionForDocuments.userId, enabledDocuments);
      const retrievalDocIds = retrievalDocuments.map((doc) => doc.id);
      console.log('[DOCUMENT STATUS]', `Resolved ${retrievalDocIds.length} retrieval document(s)`);

      const hasEnabledEmbeddings = await this.getHasEnabledEmbeddingsFast(sessionId, retrievalDocIds);
      console.log('[EMBEDDING STATUS]', `Embeddings available for enabled documents: ${hasEnabledEmbeddings ? 'YES' : 'NO'}`);

      if (enabledDocuments.length === 0 || !hasEnabledEmbeddings) {
        // No enabled documents or no embeddings available, just chat without context
        console.log('[PROCESSING MODE]', 'Direct response (no RAG context available)');
        await this.generateDirectResponse(sessionId, content, onStreamEvent);
        console.log('=== CHAT PIPELINE PROCESS END ===\n');
        return;
      }

      // 4. GENERATE EMBEDDING USING THE REWRITTEN QUERY
      const retrievalStartMs = Date.now();
      console.log('[EMBEDDING GENERATION]', 'Creating vector embedding for enhanced query...');
      const queryEmbedding = await embeddingService.generateEmbedding(retrievalQuery);
      console.log('[EMBEDDING GENERATED]', `Vector created with ${queryEmbedding.length} dimensions`);
      const routePrefilter = await this.buildRoutePrefilterPlan(retrievalDocuments, queryEmbedding);
      console.log(
        '[ANSWER ROUTING] companion-prefilter applied=%s docs=%d chunkAllowList=%d',
        Boolean(routePrefilter.documentIds?.length),
        routePrefilter.documentIds?.length || 0,
        routePrefilter.allowedChunkIds?.length || 0
      );

      // Update progress: Vector Search (75%)
      if (onStreamEvent) {
        onStreamEvent({ type: 'status', message: 'Vector Search' });
      }

      // 5. PERFORM SEARCH USING THE REWRITTEN QUERY
      console.log('[VECTOR SEARCH]', 'Performing hybrid search...');
      const retrievalChunkCap = 12;

      let searchResults = await vectorSearchService.searchHybridEnhanced(
        queryEmbedding,
        sessionId,
        retrievalQuery, // Use retrieval-expanded query for better recall
        {
          maxResults: retrievalChunkCap,
          useDynamicWeighting: true,
          textWeight: 0.3,
          vectorWeight: 0.7,
          retrievalMode,
          userId: sessionForDocuments.userId, // Ensure userId is passed
          documentIds: routePrefilter.documentIds,
          allowedChunkIds: routePrefilter.allowedChunkIds,
        }
      );

      // Safety net: if rewrite caused zero-hit retrieval, retry once with the original user query.
      if (searchResults.length === 0 && standaloneRewrite.wasRewritten) {
        this.rewriteTelemetry.zeroHitAfterRewrite += 1;
        this.rewriteTelemetry.searchFallbackAttempts += 1;
        this.logRewriteTelemetrySummary();
        console.warn('[SEARCH FALLBACK]', 'No results for rewritten query. Retrying with original query.');
        const fallbackEnhancedQuery = await this.enhanceQueryWithContext(sessionId, content, queryIntent);
        const fallbackRetrievalQuery = fallbackEnhancedQuery;
        const fallbackEmbedding = await embeddingService.generateEmbedding(fallbackRetrievalQuery);
        const fallbackRoutePrefilter = await this.buildRoutePrefilterPlan(retrievalDocuments, fallbackEmbedding);
        console.log(
          '[ANSWER ROUTING][FALLBACK] companion-prefilter applied=%s docs=%d chunkAllowList=%d',
          Boolean(fallbackRoutePrefilter.documentIds?.length),
          fallbackRoutePrefilter.documentIds?.length || 0,
          fallbackRoutePrefilter.allowedChunkIds?.length || 0
        );
        const fallbackResults = await vectorSearchService.searchHybridEnhanced(
          fallbackEmbedding,
          sessionId,
          fallbackRetrievalQuery,
          {
            maxResults: retrievalChunkCap,
            useDynamicWeighting: true,
            textWeight: 0.3,
            vectorWeight: 0.7,
            retrievalMode,
            userId: sessionForDocuments.userId,
            documentIds: fallbackRoutePrefilter.documentIds,
            allowedChunkIds: fallbackRoutePrefilter.allowedChunkIds,
          }
        );
        if (fallbackResults.length > 0) {
          this.rewriteTelemetry.searchFallbackRecovered += 1;
          this.logRewriteTelemetrySummary();
          console.log('[SEARCH FALLBACK]', `Recovered ${fallbackResults.length} result(s) using original query.`);
          searchResults = fallbackResults;
        }
      }
      const baseSearchResults = [...searchResults];
      const embeddings = await this.getEmbeddingsForRetrievedDocs(sessionId, baseSearchResults);

      // Same-page neighborhood expansion: keep nearby chunks from the strongest pages.
      searchResults = this.includeTopChunkAdjacentChunks(searchResults, embeddings, queryEmbedding, retrievalQuery, queryIntent, 0.12, 16, 3, 2);
      const retrievalPostprocess = postProcessRetrievalResults(searchResults, { maxResults: retrievalChunkCap, maxPerPageCluster: 3 });
      searchResults = retrievalPostprocess.results;
      retrievalMs = Date.now() - retrievalStartMs;

      console.log('[RETRIEVAL QUALITY METRICS]', {
        dedup_removed_count: retrievalPostprocess.telemetry.dedupRemovedCount,
        near_duplicate_removed_count: retrievalPostprocess.telemetry.nearDuplicateRemovedCount,
        diversity_removed_count: retrievalPostprocess.telemetry.diversityRemovedCount,
        source_mix_distribution: retrievalPostprocess.telemetry.sourceMixDistribution,
      });

      console.log('[SEARCH RESULTS]', `${searchResults.length} relevant chunks found`);
      console.log('✅ CHUNKS USED =', searchResults.length);

      // Update progress: Answer Generation (90%)
      if (onStreamEvent) {
        onStreamEvent({ type: 'status', message: 'Answer Generation' });
      }

      // Cap chunks fed to the LLM to stay within TPM limits.
      const GENERATION_CHUNK_CAP = 6;
      const MIN_SIMILARITY_FLOOR = 0.55;

      const sortedGenerationCandidates = [...searchResults]
        .sort((a, b) => this.rankGenerationCandidate(b, queryIntent) - this.rankGenerationCandidate(a, queryIntent))
        .filter((chunk) => chunk.similarity >= this.getGenerationSimilarityFloor(chunk, queryIntent, MIN_SIMILARITY_FLOOR));
      const relaxedFloorCount = sortedGenerationCandidates.filter(
        (chunk) => this.getGenerationSimilarityFloor(chunk, queryIntent, MIN_SIMILARITY_FLOOR) < MIN_SIMILARITY_FLOOR
      ).length;

      console.log(
        '[GENERATION CHUNKS]',
        `Using top ${Math.min(sortedGenerationCandidates.length, GENERATION_CHUNK_CAP)} of ${searchResults.length} retrieved chunks for generation (base floor: ${MIN_SIMILARITY_FLOOR}; relaxed local-continuation chunks: ${relaxedFloorCount})`
      );

      const qualityFilteredChunks = this.filterQualityChunks(sortedGenerationCandidates);
      let generationChunksForModel = this.selectGenerationChunksByPageCluster(
        qualityFilteredChunks.kept,
        GENERATION_CHUNK_CAP,
        queryIntent
      );
      const evaluatedChunkById = new Map(
        qualityFilteredChunks.evaluated.map((chunk) => [chunk.chunk.id, chunk] as const)
      );

      const removedChunkIds = new Set(
        qualityFilteredChunks.removed.map((chunk) => chunk.chunk.id)
      );

      if (generationChunksForModel.length < GENERATION_CHUNK_CAP) {
        const backfillCandidates = sortedGenerationCandidates.filter(
          (chunk) =>
            !removedChunkIds.has(chunk.chunk.id) &&
            !generationChunksForModel.some((keptChunk) => keptChunk.chunk.id === chunk.chunk.id)
        );

        for (const candidate of backfillCandidates) {
          const evaluatedCandidate = evaluatedChunkById.get(candidate.chunk.id);
          if (!evaluatedCandidate) continue;
          generationChunksForModel.push(evaluatedCandidate);
          generationChunksForModel.sort((a, b) => this.rankGenerationCandidate(b, queryIntent) - this.rankGenerationCandidate(a, queryIntent));
          if (generationChunksForModel.length >= GENERATION_CHUNK_CAP) {
            break;
          }
        }
      }

      if (generationChunksForModel.length === 0) {
        const fallbackFromQuality = qualityFilteredChunks.evaluated.length > 0
          ? [...qualityFilteredChunks.evaluated].sort((a, b) => {
              if (b.quality.score !== a.quality.score) {
                return b.quality.score - a.quality.score;
              }
              return b.similarity - a.similarity;
            })[0]
          : null;
        const bestRetrievedChunk = [...searchResults].sort((a, b) => b.similarity - a.similarity)[0] || null;
        const fallbackChunk = fallbackFromQuality
          || (bestRetrievedChunk
            ? ({
                ...bestRetrievedChunk,
                quality: {
                  score: 0,
                  reasons: ['below_similarity_floor'],
                  shouldExclude: false,
                  exclusionType: 'other',
                } as ChunkQualityAssessment,
              } as typeof generationChunksForModel[number])
            : null);

        if (fallbackChunk) {
          generationChunksForModel = [fallbackChunk];
          console.warn(
            '[GENERATION FALLBACK]',
            fallbackFromQuality
              ? 'All candidate chunks were flagged. Keeping the best remaining chunk to avoid an empty prompt.'
              : 'No chunk met the similarity floor. Keeping the best retrieved chunk to avoid an empty prompt.',
            {
              chunkId: fallbackChunk.chunk.id,
              page: this.getChunkPageNumber(fallbackChunk.chunk),
              documentTitle: fallbackChunk.document.title,
              similarity: Number(fallbackChunk.similarity.toFixed(3)),
              ...(fallbackFromQuality
                ? {
                    exclusionType: fallbackChunk.quality.exclusionType,
                    score: Number(fallbackChunk.quality.score.toFixed(3)),
                    reasons: fallbackChunk.quality.reasons,
                    content: fallbackChunk.chunk.content,
                  }
                : {}),
            }
          );
        }
      }

      if (qualityFilteredChunks.removed.length > 0) {
        console.log(
          '[CHUNK QUALITY FILTER SUMMARY]',
          `Kept ${generationChunksForModel.length} chunk(s) after filtering ${qualityFilteredChunks.removed.length} junk chunk(s).`
        );
      }

      const generationChunkIds = new Set(generationChunksForModel.map((chunk) => chunk.chunk.id));
      const generationCandidateIds = new Set(sortedGenerationCandidates.map((chunk) => chunk.chunk.id));
      const removedChunkById = new Map(
        qualityFilteredChunks.removed.map((chunk) => [chunk.chunk.id, chunk] as const)
      );
      const generationDecisionsByChunkId = new Map<string, RetrievedChunkGenerationDecision>();

      for (const chunk of searchResults) {
        const chunkId = chunk.chunk.id;

        if (generationChunkIds.has(chunkId)) {
          generationDecisionsByChunkId.set(chunkId, { fedToGenerator: true });
          continue;
        }

        const removedChunk = removedChunkById.get(chunkId);
        if (removedChunk) {
          const reasonDetails = removedChunk.quality.reasons.length > 0
            ? `; triggers=${removedChunk.quality.reasons.join(', ')}`
            : '';
          generationDecisionsByChunkId.set(chunkId, {
            fedToGenerator: false,
            reason: `removed by quality filter (${removedChunk.quality.exclusionType}, score=${removedChunk.quality.score.toFixed(2)}${reasonDetails})`,
          });
          continue;
        }

        if (!generationCandidateIds.has(chunkId)) {
          const appliedFloor = this.getGenerationSimilarityFloor(chunk, queryIntent, MIN_SIMILARITY_FLOOR);
          generationDecisionsByChunkId.set(chunkId, {
            fedToGenerator: false,
            reason: `below similarity floor (${appliedFloor.toFixed(2)})`,
          });
          continue;
        }

        generationDecisionsByChunkId.set(chunkId, {
          fedToGenerator: false,
          reason: `excluded by generation cap (${GENERATION_CHUNK_CAP}) after page-cluster prioritization`,
        });
      }

      // Build context from generation chunks only
      console.log('[CONTEXT BUILDING]', 'Constructing context from search results...');
      const orderedGenerationChunksForContext = this.orderGenerationChunksForContext(generationChunksForModel);
      const context = this.buildContext(orderedGenerationChunksForContext, retrievalQuery);
      console.log('[CONTEXT CREATED]', `Context string length: ${context.length} characters`);

      const generationStartMs = Date.now();
      const generationMetrics = await this.generateSimplifiedContextualResponse(
        sessionId,
        standaloneQuery,
        context,
        orderedGenerationChunksForContext,  // capped + quality-filtered
        answerContract,
        contractInstruction,
        queryIntent,
        retrievalQuery,
        onStreamEvent
      );
      generationMs = Date.now() - generationStartMs;
      postprocessMs = generationMetrics?.postprocessMs ?? 0;

      // Log exact chunk content passed to the model, plus explicit skip reasons.
      this.logRetrievedChunkDetails(searchResults, generationChunksForModel, baseSearchResults, generationDecisionsByChunkId);
      console.log('[QUALITY METRICS]', {
        intent_detected: queryIntent,
        contract_pass_before_fix: generationMetrics?.contractPassBeforeFix ?? true,
        contract_pass_after_fix: generationMetrics?.contractPassAfterFix ?? true,
        had_numbering_fix: generationMetrics?.hadNumberingFix ?? false,
        had_missing_section_fill: generationMetrics?.hadMissingSectionFill ?? false,
      });
      console.log('[LATENCY BREAKDOWN]', {
        rewrite_ms: rewriteMs,
        retrieval_ms: retrievalMs,
        generation_ms: generationMs,
        postprocess_ms: postprocessMs,
        total_ms: Date.now() - pipelineStartMs,
      });

      console.log('=== CHAT PIPELINE PROCESS END ===\n');

    } catch (error) {
      console.error('[PIPELINE ERROR]', 'Error in chat pipeline:', error);
      const errorMessageText = error instanceof Error ? error.message : 'Failed to process message';

      // Save error message
      const errorMessage: MessageCreate = {
        sessionId,
        content: 'Sorry, I encountered an error while processing your message. Please try again.',
        role: MessageSender.ASSISTANT,
      };

      try {
        await this.indexedDBServices.messageService.createMessage(errorMessage);
        console.log('[ERROR HANDLED]', 'Error message saved to database');
      } catch (dbError) {
        console.error('[PIPELINE ERROR]', 'Failed to persist pipeline error message:', dbError);
      }

      if (onStreamEvent) {
        onStreamEvent({
          type: 'error',
          message: errorMessageText || 'Failed to process message'
        });
      }

      console.log('=== CHAT PIPELINE PROCESS END (WITH ERROR) ===\n');
      throw (error instanceof Error ? error : new Error(errorMessageText));
    }
  }

  /**
   * Generate response without document context
   */
  private async generateDirectResponse(
    sessionId: string,
    content: string,
    onStreamEvent?: (event: ChatStreamEvent) => void
  ): Promise<void> {
    console.log('\n=== DIRECT RESPONSE MODE (NO RAG) ===');
    console.log('[DIRECT MODE]', 'Generating response without document context');

    // Generate direct response without context
    // Generate direct response without context
    const session = await this.indexedDBServices.sessionService.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const settings = await this.indexedDBServices.settingsService.getSettings(session.userId);
    const messages = await this.indexedDBServices.messageService.getMessagesBySession(sessionId, session.userId);
    console.log('[CHAT HISTORY]', `Found ${messages.length} previous messages`);

    let fullResponse = '';
    let citations: any[] = [];
    const groqModel = ANSWER_GENERATION_MODEL;
    const temperature = settings?.temperature || 0.7;
    const maxTokens = Math.max(settings?.maxTokens || 2048, 3072);

    // Build conversation history for inference service
    const groqPrompt = messages.map(msg =>
      `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`
    ).join('\n') + `\nUser: ${content}`;

    await groqService.generateStreamingResponse(
      groqPrompt,
      "You are a helpful medical AI assistant. Be thorough, structured, and complete. Include all relevant points from the conversation, not just the first few.",
      groqModel,
      {
        temperature,
        maxTokens,
        maxFailoverRetries: 2,
        retryBackoffMs: 300,
        onChunk: (chunk: string) => {
          fullResponse += chunk;
        }
      }
    );

    console.log('[DIRECT RESPONSE]', `Generated ${fullResponse.length} characters`);

    // Save assistant message
    const assistantMessage: MessageCreate = {
      sessionId,
      content: fullResponse,
      role: MessageSender.ASSISTANT,
      citations: citations.length > 0 ? citations : undefined,
    };

    await this.indexedDBServices.messageService.createMessage(assistantMessage);
    console.log('[RESPONSE SAVED]', 'Direct response stored in database');

    if (onStreamEvent) {
      onStreamEvent({
        type: 'done',
        content: fullResponse,
        citations: citations.length > 0 ? citations : undefined
      });
    }

    console.log('=== DIRECT RESPONSE MODE END ===\n');
  }

  /**
   * Generate response with document context
   */
  private async generateContextualResponse(
    sessionId: string,
    content: string,
    context: string,
    searchResults: any[],
    onStreamEvent?: (event: ChatStreamEvent) => void
  ): Promise<void> {
    console.log('\n=== CONTEXTUAL RESPONSE MODE (WITH RAG) ===');
    console.log('[RAG MODE]', 'Generating response with document context');
    console.log('[CONTEXT SUMMARY]', `Providing ${searchResults.length} context sources to LLM`);

    // Get session for system prompt
    // Get session for system prompt and userId
    const session = await this.indexedDBServices.sessionService.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const systemPrompt = this.getDefaultSystemPrompt(searchResults);
    console.log('[SYSTEM PROMPT]', 'Using default system prompt');

    const settings = await this.indexedDBServices.settingsService.getSettings(session.userId);
    console.log('[RAG SETTINGS]', 'Settings loaded for contextual response');
    console.log('[RAG SETTINGS]', `API Key present: ${settings?.geminiApiKey ? 'YES' : 'NO'}`);
    console.log('[RAG SETTINGS]', `Temperature: ${settings?.temperature}`);
    console.log('[RAG SETTINGS]', `Max tokens: ${settings?.maxTokens}`);

    let fullResponse = '';

    const groqModel = ANSWER_GENERATION_MODEL;

    await groqService.generateStreamingResponse(
      `Context:\n${context}\n\nQuestion: ${content}`,
      systemPrompt,
      groqModel,
      {
        temperature: settings?.temperature || 0.7,
        maxTokens: Math.max(settings?.maxTokens || 2048, 3072),
        maxFailoverRetries: 2,
        retryBackoffMs: 300,
        onChunk: (chunk: string) => {
          fullResponse += chunk;
        }
      }
    );

    console.log('=== CONTEXTUAL RESPONSE MODE END ===\n');
  }

  /**
   * NEW: Generate response with simplified page-based citation system
   */
  private async generateSimplifiedContextualResponse(
    sessionId: string,
    content: string,
    context: string,
    searchResults: any[],
    answerContract: AnswerContract,
    contractInstruction: string,
    queryIntent: QueryIntent,
    retrievalQuery?: string,
    onStreamEvent?: (event: ChatStreamEvent) => void
  ): Promise<SimplifiedGenerationMetrics | null> {
    console.log('\n=== SIMPLIFIED CONTEXTUAL RESPONSE MODE (WITH RAG) ===');
    console.log('[SIMPLIFIED RAG MODE]', 'Generating response with app-level citations');
    console.log('[SIMPLIFIED CONTEXT]', `Providing ${searchResults.length} context sources to LLM`);

    // Get session for system prompt
    // Get session for system prompt and userId
    const session = await this.indexedDBServices.sessionService.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const settings = await this.indexedDBServices.settingsService.getSettings(session.userId);
    console.log('[SIMPLIFIED RAG SETTINGS]', 'Settings loaded for simplified contextual response');

    let fullResponse = '';
    let promptContext = context;
    let promptSearchResults = searchResults;
    let systemPrompt = this.getSimplifiedSystemPrompt(searchResults, contractInstruction);
    console.log('[SIMPLIFIED SYSTEM PROMPT]', 'Using default simplified system prompt');

    let postprocessMs = 0;
    let contractPassBeforeFix = true;
    let contractPassAfterFix = true;
    let hadNumberingFix = false;
    let hadMissingSectionFill = false;
    const cappedTemperature = Math.min(settings?.temperature ?? 0.7, 0.2);
    const maxTokens = Math.max(settings?.maxTokens || 2048, 3072);
    const groqModel = ANSWER_GENERATION_MODEL;

    const isExactTpmOverflowError = (error: unknown): boolean => {
      const message = error instanceof Error ? error.message : String(error);
      const normalizedMessage = message.toLowerCase();
      return (
        normalizedMessage.includes('payload too large') &&
        normalizedMessage.includes('request too large for model') &&
        normalizedMessage.includes('tokens per minute (tpm)') &&
        normalizedMessage.includes('please reduce your message size and try again')
      );
    };

    const buildGroqPrompt = (contextToUse: string): string => `
      <CONTEXT_SOURCES>
      ${contextToUse}
      </CONTEXT_SOURCES>

      Answer Intent: ${queryIntent}

      New Question: ${content}
    `;

    const streamResponse = async (contextToUse: string, systemPromptToUse: string): Promise<void> => {
      fullResponse = '';
      await groqService.generateStreamingResponse(
        buildGroqPrompt(contextToUse),
        systemPromptToUse,
        groqModel,
        {
          temperature: cappedTemperature,
          maxTokens,
          maxFailoverRetries: 2,
          retryBackoffMs: 300,
          onChunk: (chunk: string) => {
            fullResponse += chunk;
          }
        }
      );
    };

    try {
      try {
        await streamResponse(promptContext, systemPrompt);
      } catch (error) {
        if (isExactTpmOverflowError(error) && promptSearchResults.length > 1) {
          const reducedSearchResults = promptSearchResults.slice(0, -1);
          promptSearchResults = reducedSearchResults;
          systemPrompt = this.getSimplifiedSystemPrompt(reducedSearchResults, contractInstruction);
          promptContext = this.buildContext(reducedSearchResults, retrievalQuery);
          console.warn(
            '[SIMPLIFIED RAG MODE]',
            'Exact TPM overflow hit; retrying once with the least important chunk removed.'
          );
          await streamResponse(promptContext, systemPrompt);
        } else {
          throw error;
        }
      }

      console.log('[SIMPLIFIED RESPONSE COMPLETE]', `Generated ${fullResponse.length} characters`);

      if (onStreamEvent) {
        onStreamEvent({ type: 'status', message: 'Answer Formatting' });
      }

      const structuredResponse = this.parseStructuredAnswerResponse(fullResponse);
      const directStructuredResult = structuredResponse
        ? this.renderStructuredAnswerMarkdownWithCitations(structuredResponse, answerContract, promptSearchResults)
        : null;
      const responseBody = directStructuredResult
        ? directStructuredResult.content
        : fullResponse.trim();
      const firstContractStartMs = Date.now();
      const firstContractPass = applyAnswerContract(responseBody, answerContract);
      postprocessMs += Date.now() - firstContractStartMs;
      contractPassBeforeFix = firstContractPass.passBeforeFix;
      contractPassAfterFix = firstContractPass.passAfterFix;
      hadNumberingFix = firstContractPass.hadNumberingFix;
      hadMissingSectionFill = firstContractPass.hadMissingSectionFill;

      let responseForCitation = firstContractPass.content;
      if (structuredResponse) {
        console.log('[STRUCTURED RESPONSE PARSE]', `Parsed ${structuredResponse.sections.length} section(s) from model output.`);
      } else if ((fullResponse || '').trim().startsWith('{')) {
        console.warn('[STRUCTURED RESPONSE PARSE]', 'Model output looked like JSON but could not be parsed. Falling back to contract normalization.');
      }
      const firstPassRateLimitNotice = this.extractRateLimitNotice(responseForCitation);
      if (firstPassRateLimitNotice) {
        console.warn('[RATE LIMIT SURFACE]', 'Returning rate-limit notice directly (skipping citation pipeline).');

        const assistantMessage: MessageCreate = {
          sessionId,
          content: firstPassRateLimitNotice,
          role: MessageSender.ASSISTANT,
        };
        await this.indexedDBServices.messageService.createMessage(assistantMessage);

        if (onStreamEvent) {
          onStreamEvent({
            type: 'done',
            content: firstPassRateLimitNotice,
            citations: undefined
          });
        }

        console.log('=== SIMPLIFIED CONTEXTUAL RESPONSE MODE END ===\n');
        return {
          postprocessMs,
          contractPassBeforeFix,
          contractPassAfterFix,
          hadNumberingFix,
          hadMissingSectionFill,
        };
      }

      let citationMetadata: Array<{ document: string; page?: number; excerpt?: string }> = [];
      let responseForCitationConsistency = responseForCitation;

      if (directStructuredResult && directStructuredResult.citations.length > 0) {
        const directCitationMetadata = citationService.convertSimplifiedToMessageCitations(directStructuredResult.citations);
        const consistentCitationOutput = this.enforceCitationConsistency(
          responseForCitationConsistency,
          directCitationMetadata
        );
        citationMetadata = consistentCitationOutput.citations;
        responseForCitationConsistency = consistentCitationOutput.content;
      } else {
        const citationResult = citationService.processSimplifiedCitations(responseForCitation, promptSearchResults);
        citationMetadata = citationResult.citations.length > 0
          ? citationService.convertSimplifiedToMessageCitations(citationResult.citations)
          : this.buildFallbackCitationsFromSearchResults(promptSearchResults, Math.min(8, promptSearchResults.length));
        const consistentCitationOutput = this.enforceCitationConsistency(
          citationResult.renumberedResponse || responseForCitation,
          citationMetadata
        );
        const citationBackfilledContent = this.backfillMissingInlineCitations(
          consistentCitationOutput.content,
          consistentCitationOutput.citations,
          consistentCitationOutput.citations.map(c => {
            const originalIndex = c.sourceIndex ? c.sourceIndex - 1 : -1;
            return originalIndex >= 0 && originalIndex < promptSearchResults.length
              ? promptSearchResults[originalIndex].similarity
              : 1;
          })
        );
        const isNoEvidenceResponse = this.isInsufficientEvidenceResponse(citationBackfilledContent);
        if (!isNoEvidenceResponse) {
          const groundingPass = this.removeUncitedSubstantiveLines(citationBackfilledContent);
          responseForCitationConsistency = groundingPass.content;
          if (groundingPass.dropped > 0) {
            console.warn(
              '[GROUNDING FILTER]',
              `Removed ${groundingPass.dropped} uncited substantive line(s).`
            );
          }
        } else {
          responseForCitationConsistency = citationBackfilledContent;
        }
      }

      const responseWithQueryHeader = this.prependAnsweredQueryHeader(
        responseForCitationConsistency,
        content
      );

      const assistantMessage: MessageCreate = {
        sessionId,
        content: responseWithQueryHeader,
        role: MessageSender.ASSISTANT,
        citations: citationMetadata,
      };

      await this.indexedDBServices.messageService.createMessage(assistantMessage);

      if (onStreamEvent) {
        onStreamEvent({
          type: 'done',
          content: responseWithQueryHeader,
          citations: citationMetadata
        });
      }

      return {
        postprocessMs,
        contractPassBeforeFix,
        contractPassAfterFix,
        hadNumberingFix,
        hadMissingSectionFill,
      };
    } catch (error) {
      console.error('[SIMPLIFIED RAG MODE ERROR]', 'Inference provider error:', error);
      if (onStreamEvent) {
        onStreamEvent({
          type: 'error',
          message: error instanceof Error ? error.message : 'Failed to generate response via inference provider'
        });
      }
      console.log('=== SIMPLIFIED CONTEXTUAL RESPONSE MODE END ===\n');
      return null;
    }
  }

  /**
   * Get simplified system prompt for page-based citation system
   */
  private getSimplifiedSystemPrompt(searchResults?: any[], contractInstruction?: string): string {
    return `You are a medical RAG assistant.

You MUST follow these rules:
1) Use ONLY the provided context sources. No external knowledge.
2) If context is insufficient, say: "I cannot answer this question based on the provided documents."
3) Return STRICT MARKDOWN ONLY.
4) Do not include citation markers, bracket numbers, code fences, or commentary.
5) Conversation continuity rule: if the new question is a short follow-up that is clearly related to the previous user question, continue with the same medical topic/condition unless the user explicitly changes topic.
6) Read each chunk carefully and include all relevant information from every chunk that supports the answer. Do not stop after the first matching chunk.
7) If a retrieved chunk contains extra relevant detail beyond the exact question, include that detail too under a suitable heading or subheading, as long as it is explicitly present in the source.
8) If a chunk contains a table, figure, summary box, scoring system, list, or criteria set, unpack all relevant rows, items, components, and thresholds from it instead of only naming the headline.
9) Before writing, mentally scan ALL provided chunks and extract the distinct facts from each one. Do not ignore a chunk just because another chunk from the same page already overlaps with it.
10) If two chunks overlap, keep the shared point once but still add any extra details that appear only in the later chunk.
11) Do not say information is "not found" if relevant facts are present anywhere in the provided chunks.
12) If a single chunk contains multiple headings, subsections, or topic blocks, use ONLY the subsection that is relevant to the user query and ignore unrelated subsection content from the same chunk.

Output format requirements:
- Use only the section titles from the contract below.
- Use subsections when the source naturally breaks into groups, subtypes, or distinctions.
- Use the same page and adjacent pages (page N, N-1, N+1) as a continuity signal: if the topic is clearly continuing, keep those facts under the same heading or subsection.
- If the source heading or section cue changes, start a new subsection instead of merging the ideas.
- Prefer smaller, source-faithful subsections over one large mixed subsection.
- Do not merge preoperative, intraoperative, postoperative, early, medium, and late content into one bucket unless the source explicitly groups them together.
- Only output claims that are explicitly present in the retrieved text. Do not add interpretation, thresholds, or conclusions unless the exact wording or a near-verbatim line appears in the source.
- If a claim is not explicitly supported by the retrieved text, omit it.
- If a source sentence or paragraph contains multiple connected qualifiers, keep them together in one claim or subsection when they are all explicitly present.
- Use plain bullet points for claims.
- WRITE FULL, DESCRIPTIVE BULLETS. Never write single-word bullets like "Pain" or "Infection". Instead write "Pain occurs early in the disease process" or "Infection risk increases with immunosuppression." Single-word bullets are strictly forbidden.
- Use subheadings when the retrieved chunks contain multiple related groups of facts.
- Prefer grouping bullets from the same page or same source cluster under one short subheading.
- Do not flatten everything into one long bullet list if the answer naturally has sections.
- Keep subheadings short and specific.
- If a required section is missing from sources, include the section and write "Not found in provided sources." under it.
- Be thorough and complete. Do not stop after the first few points if the source has more detail.
- If the source contains several related items, keep listing them in a clear structure instead of compressing them into a short summary.
- For classification-style questions, include every distinct system, subtype, and criterion found in the retrieved text.
- When multiple chunks from the same page or adjacent pages continue the same topic, combine them into one fuller section instead of taking only the first chunk's points.
- Prefer extracting more supported bullets over giving a short polished summary.
- If a chunk mixes two different headings or sections, do not borrow facts from the wrong heading just because they are nearby in the same chunk.

Coverage requirements:
- Do NOT summarize when the source contains detailed points.
- Reorganize and present the provided information; do not compress it into a short summary.
- YOU MUST DRAW CONTENT FROM ALL PROVIDED SOURCES if they contain relevant information. Do not ignore later sources just because the first few sources answer the question.
- Include all relevant classifications, subtypes, criteria, and key notes that appear in the retrieved context.
- Do not omit important source points for brevity.
- Prefer completeness over brevity while staying strictly grounded to cited text.
- Treat every provided chunk as required reading. The answer is incomplete if a fed chunk contains a relevant unique detail that is missing from the final response.

Medical shorthand:
- rx/tx => treatment or management
- dx => diagnosis
- inv => investigations
- "clinical features" => history + examination (not investigations)
${contractInstruction ? `\n${contractInstruction}\n` : ''}

Goal: accurate, full-detail, source-grounded answer; citations and references are added by the app after generation.`;
  }

  /**
   * Build context string from search results following Flutter app's approach
   * Enhanced with clearer source labeling and content previews
   * IMPROVED: Better page number detection and clearer source identification
   */
  private buildContext(searchResults: any[], retrievalQuery?: string): string {
    if (searchResults.length === 0) {
      return '';
    }

    console.log('\n=== CONTEXT BUILDING DEBUG ===');
    console.log('[BUILDING CONTEXT]', `Processing ${searchResults.length} search results for context`);

    const contextParts: string[] = [];
    contextParts.push('Retrieved Context Sources:\n');
    contextParts.push('Grouping hint: content from the same page and adjacent pages (page N, N-1, N+1) often belongs to the same heading or subsection when the topic continues.');
    contextParts.push('Grouping rule: if the source heading or section cue changes, start a new subsection instead of merging the ideas.');
    contextParts.push('Continuation rule: if a source on the next page clearly continues the same list, same examples, or same subsection, treat it as a direct continuation instead of a new unrelated block.');
    contextParts.push('');

    for (let i = 0; i < searchResults.length; i++) {
      const result = searchResults[i];
      const chunk = result.chunk;
      const document = result.document;
      const previousResult = i > 0 ? searchResults[i - 1] : null;

      // Enhanced page number detection - same logic as citation service
      let pageInfo = '';
      if (chunk.metadata?.pageNumbers && chunk.metadata.pageNumbers.length > 0) {
        pageInfo = ` (Page ${chunk.metadata.pageNumbers[0]})`;
      } else if (chunk.page && chunk.page > 0) {
        pageInfo = ` (Page ${chunk.page})`;
      } else if (chunk.metadata?.pageNumber && chunk.metadata.pageNumber > 0) {
        pageInfo = ` (Page ${chunk.metadata.pageNumber})`;
      } else {
        // Try to extract from content
        const pagePatterns = [
          /page\s+(\d+)/i,
          /p\.?\s*(\d+)/i,
          /第(\d+)页/,
          /page\s+(\d+)\s+of/i,
        ];

        for (const pattern of pagePatterns) {
          const match = chunk.content.match(pattern);
          if (match && match[1]) {
            const extractedPage = parseInt(match[1], 10);
            if (extractedPage > 0) {
              pageInfo = ` (Page ${extractedPage})`;
              break;
            }
          }
        }
      }

      // Create content preview centered around query terms if possible
      const contentPreview = this.createContentPreview(chunk.content, retrievalQuery);
      const sectionCue = this.createSectionCue(chunk.content);
      const similarityScore = result.similarity ? ` (Similarity: ${(result.similarity * 100).toFixed(1)}%)` : '';
      const continuationCue = this.describeContextContinuation(previousResult, result);

      console.log(`[CONTEXT SOURCE ${i + 1}]`, {
        documentTitle: document.title,
        pageInfo: pageInfo.trim(),
        similarity: result.similarity,
        chunkId: chunk.id,
        contentPreview: contentPreview,
        continuationCue,
        isCombined: chunk.metadata?.isCombined,
        originalChunkCount: chunk.metadata?.originalChunkCount
      });

      contextParts.push(`<SOURCE ${i + 1}>`);
      contextParts.push(`Source ID: [${i + 1}]`);
      contextParts.push(`Document: ${document.title}${pageInfo}${similarityScore}`);
      contextParts.push(`Section cue: ${sectionCue || 'No explicit heading detected'}`);
      contextParts.push(`Continuation cue: ${continuationCue}`);
      contextParts.push(`Preview: ${contentPreview}`);
      contextParts.push('');
      contextParts.push('Full Content:');
      contextParts.push(chunk.content.trim());
      contextParts.push('');
      contextParts.push(`</SOURCE>`);
      contextParts.push('');
    }

    const finalContext = contextParts.join('\n').trim();
    console.log('[CONTEXT BUILT]', `Final context length: ${finalContext.length} characters`);
    console.log('=== CONTEXT BUILDING DEBUG END ===\n');

    return finalContext;
  }

  private describeContextContinuation(
    previousResult: VectorSearchResult | null,
    currentResult: VectorSearchResult
  ): string {
    if (!previousResult) {
      return 'Start of a new local source flow.';
    }

    if (previousResult.document.id !== currentResult.document.id) {
      return 'New document/source flow.';
    }

    const previousPage = this.getChunkPageNumber(previousResult.chunk);
    const currentPage = this.getChunkPageNumber(currentResult.chunk);
    const previousCue = this.createSectionCue(previousResult.chunk.content || '');
    const currentCue = this.createSectionCue(currentResult.chunk.content || '');
    const previousIndex = this.getEffectiveChunkIndex(previousResult.chunk);
    const currentIndex = this.getEffectiveChunkIndex(currentResult.chunk);

    const adjacentPage =
      previousPage !== null &&
      currentPage !== null &&
      Math.abs(currentPage - previousPage) === 1;
    const samePage =
      previousPage !== null &&
      currentPage !== null &&
      previousPage === currentPage;
    const adjacentIndex =
      previousIndex !== null &&
      currentIndex !== null &&
      Math.abs(currentIndex - previousIndex) <= 2;
    const continuationFragment = this.looksLikeContinuationFragment(currentResult.chunk.content || '');
    const sharedCue =
      previousCue &&
      currentCue &&
      previousCue.toLowerCase() === currentCue.toLowerCase();

    if ((samePage || adjacentPage) && (adjacentIndex || continuationFragment || sharedCue)) {
      if (adjacentPage) {
        return `Direct continuation of the previous source across adjacent pages (${previousPage} -> ${currentPage}).`;
      }
      return `Direct continuation of the previous source on the same page (${currentPage}).`;
    }

    if (samePage || adjacentPage) {
      return `Related local source from the same page window (${previousPage ?? '?'} -> ${currentPage ?? '?'}).`;
    }

    return 'New subsection/source flow.';
  }

  /**
   * Create a brief content preview to help identify relevant sources.
   * If a query is provided, attempts to center the preview around keywords from the query
   * so the reference panel shows the matched content, not just the top of a page.
   */
  private createContentPreview(content: string, query?: string, maxLength: number = 150): string {
    // Remove extra whitespace but preserve newlines for list formatting
    const cleanedContent = content.trim().replace(/[ \t]+/g, ' ');

    if (cleanedContent.length <= maxLength) {
      return cleanedContent;
    }

    // If query is provided, try to find a good starting point based on keywords
    if (query) {
      // Extract main medical keywords (ignore stop words, keep words > 4 chars)
      const stopWords = new Set(['what', 'where', 'when', 'how', 'why', 'is', 'are', 'the', 'causes', 'of', 'in', 'and', 'or', 'for']);
      const keywords = query
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 4 && !stopWords.has(w));

      if (keywords.length > 0) {
        const lowerContent = cleanedContent.toLowerCase();
        let bestMatchIndex = -1;

        // Try to find the first occurrence of the most specific keyword
        for (const keyword of keywords) {
          const index = lowerContent.indexOf(keyword);
          if (index !== -1) {
            bestMatchIndex = index;
            break;
          }
        }

        if (bestMatchIndex > 0) {
          // Found a keyword. Wind back to the start of the sentence, or max 40 chars.
          let startIdx = bestMatchIndex;
          let charsBacked = 0;
          while (startIdx > 0 && charsBacked < 40) {
            if (['.', '!', '?'].includes(cleanedContent[startIdx])) {
              startIdx++; // Step just past the punctuation
              break;
            }
            startIdx--;
            charsBacked++;
          }
          
          while(startIdx < cleanedContent.length && cleanedContent[startIdx] === ' ') startIdx++;

          const prefix = startIdx > 0 ? '... ' : '';
          const snippet = cleanedContent.substring(startIdx, startIdx + maxLength - prefix.length);
          
          const suffix = (startIdx + snippet.length) < cleanedContent.length ? '...' : '';
          return `${prefix}${snippet}${suffix}`;
        }
      }
    }

    // Fallback: just take the top of the chunk
    // Try to end at a sentence boundary
    const truncated = cleanedContent.substring(0, maxLength);
    const lastSentenceEnd = Math.max(
      truncated.lastIndexOf('.'),
      truncated.lastIndexOf('!'),
      truncated.lastIndexOf('?')
    );

    if (lastSentenceEnd > maxLength * 0.7) {
      return truncated.substring(0, lastSentenceEnd + 1);
    }

    return truncated + '...';
  }

  /**
   * Try to extract a short heading-like cue from the start of a chunk.
   * This helps the model keep distinct source sections separate when the
   * retrieved chunk spans multiple nearby pages.
   */
  private createSectionCue(content: string, maxLength: number = 80): string {
    const lines = (content || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 12);

    for (const line of lines) {
      const clean = line
        .replace(/^#{1,6}\s+/, '')
        .replace(/^\d+\s+/, '')
        .replace(/\s*\([^)]*\)\s*$/g, '')
        .replace(/[.:;]+$/g, '')
        .trim();

      if (!clean) continue;
      if (/^(page\s+\d+|figure\s+\d+|table\s+\d+|part\s+\d+|chapter\s+\d+)$/i.test(clean)) continue;

      const wordCount = clean.split(/\s+/).filter(Boolean).length;
      const hasLetters = /[A-Za-z]/.test(clean);
      if (!hasLetters || wordCount < 2 || wordCount > 10 || clean.length < 6 || clean.length > maxLength) {
        continue;
      }

      return clean;
    }

    return '';
  }

  /**
   * Parse a structured JSON answer returned by the model.
   */
  private parseStructuredAnswerResponse(raw: string): StructuredAnswerResponse | null {
    const trimmed = (raw || '').trim();
    if (!trimmed) return null;

    const candidates: string[] = [trimmed];
    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
      candidates.push(fencedMatch[1].trim());
    }

    const objectMatch = trimmed.match(/\{[\s\S]*\}/);
    if (objectMatch?.[0]) {
      candidates.push(objectMatch[0]);
    }

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as any;
        const normalized = this.normalizeStructuredAnswerResponse(parsed);
        if (normalized) return normalized;
      } catch {
        continue;
      }
    }

    return null;
  }

  private normalizeStructuredAnswerResponse(value: any): StructuredAnswerResponse | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

    const rawSections = Array.isArray(value.sections) ? value.sections : null;
    if (!rawSections || rawSections.length === 0) return null;

    const sections = rawSections
      .map((section: unknown): { title: string; claims?: string[]; subsections?: { title: string; claims: string[] }[] } | null => {
        if (!section || typeof section !== 'object') return null;

        const typedSection = section as {
          title?: unknown;
          claims?: unknown;
          bullets?: unknown;
          points?: unknown;
          subsections?: unknown;
          subheadings?: unknown;
        };
        const title = this.normalizeStructuredSectionTitle(typedSection.title);
        if (!title) return null;

        const claims = this.normalizeStructuredClaims(
          typedSection.claims ?? typedSection.bullets ?? typedSection.points
        );
        const subsections = this.normalizeStructuredSubsections(
          typedSection.subsections ?? typedSection.subheadings
        );
        return {
          title,
          ...(claims.length > 0 ? { claims } : {}),
          ...(subsections.length > 0 ? { subsections } : {}),
        };
      })
      .filter(
        (
          section: { title: string; claims?: string[]; subsections?: { title: string; claims: string[] }[] } | null
        ): section is { title: string; claims?: string[]; subsections?: { title: string; claims: string[] }[] } =>
          Boolean(section)
      );

    if (sections.length === 0) return null;

    const title = typeof value.title === 'string' ? value.title.trim() : undefined;
    return title ? { title, sections } : { sections };
  }

  private normalizeStructuredSectionTitle(title: unknown): string {
    if (typeof title !== 'string') return '';
    return title.replace(/\s+/g, ' ').trim();
  }

  private normalizeStructuredClaims(claims: unknown): string[] {
    const values = Array.isArray(claims) ? claims : typeof claims === 'string' ? [claims] : [];
    const normalized: string[] = [];

    for (const value of values) {
      if (typeof value !== 'string') continue;
      const lines = value
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .map((line) => line.replace(/^[-*•]\s+/, '').replace(/^\d+\.\s+/, '').trim())
        .filter(Boolean);

      for (const line of lines) {
        if (line) normalized.push(line.replace(/\s+/g, ' ').trim());
      }
    }

    return normalized;
  }

  private normalizeStructuredSubsections(subsections: unknown): Array<{ title: string; claims: string[] }> {
    const values = Array.isArray(subsections) ? subsections : [];
    const normalized: Array<{ title: string; claims: string[] }> = [];

    for (const subsection of values) {
      if (!subsection || typeof subsection !== 'object') continue;

      const typedSubsection = subsection as { title?: unknown; claims?: unknown; bullets?: unknown; points?: unknown };
      const title = this.normalizeStructuredSectionTitle(typedSubsection.title);
      if (!title) continue;

      const claims = this.normalizeStructuredClaims(
        typedSubsection.claims ?? typedSubsection.bullets ?? typedSubsection.points
      );
      normalized.push({
        title,
        claims,
      });
    }

    return normalized;
  }

  private buildDirectCitationPageGroups(searchResults: VectorSearchResult[]): DirectCitationPageGroup[] {
    const pageMap = new Map<string, DirectCitationPageGroup>();

    for (const result of searchResults) {
      const page = this.getChunkPageNumber(result.chunk);
      if (page === null) continue;

      const key = `${result.document.id}_${page}`;
      const existing = pageMap.get(key);
      if (!existing) {
        pageMap.set(key, {
          key,
          documentId: result.document.id,
          documentTitle: result.document.title || result.document.fileName || 'Unknown Document',
          page,
          chunks: [],
          combinedContent: '',
          maxSimilarity: result.similarity,
        });
      }

      pageMap.get(key)!.chunks.push({
        id: result.chunk.id,
        content: result.chunk.content,
        similarity: result.similarity,
      });
      pageMap.get(key)!.maxSimilarity = Math.max(pageMap.get(key)!.maxSimilarity, result.similarity);
    }

    return Array.from(pageMap.values())
      .map((group) => ({
        ...group,
        chunks: [...group.chunks].sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id)),
        combinedContent: [...group.chunks]
          .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))
          .map((chunk) => chunk.content)
          .join('\n---\n'),
      }))
      .sort((a, b) => {
        if (b.maxSimilarity !== a.maxSimilarity) return b.maxSimilarity - a.maxSimilarity;
        if (a.documentTitle !== b.documentTitle) return a.documentTitle.localeCompare(b.documentTitle);
        return a.page - b.page;
      });
  }

  private scoreClaimAgainstSourceContent(claim: string, sourceText: string): number {
    const normalizedClaim = this.normalizeExplicitComparisonText(claim);
    if (!normalizedClaim) return 0;

    if (normalizedClaim.length < 3) return 0;

    const normalizedSource = this.normalizeExplicitComparisonText(sourceText);
    if (!normalizedSource) return 0;

    if (normalizedSource.includes(normalizedClaim)) {
      return 1;
    }

    const sentenceScore = this.scoreClaimAgainstSourceSentences(normalizedClaim, sourceText);
    const paragraphScore = this.scoreClaimAgainstSourceParagraph(normalizedClaim, sourceText);
    const claimWords = new Set(
      normalizedClaim
        .split(' ')
        .filter((word) => word.length > 2 && !this.isStructuredStopWord(word))
    );
    const overlapScore = this.scoreTokenOverlap(claimWords, normalizedSource);

    return Math.max(sentenceScore, paragraphScore, overlapScore);
  }

  private selectBestCitationTargetForClaim(
    claim: string,
    pageGroups: DirectCitationPageGroup[]
  ): DirectCitationPageGroup | null {
    const normalizedClaim = this.normalizeExplicitComparisonText(claim);
    if (!normalizedClaim || normalizedClaim.length < 3) return null;

    const claimWords = new Set(
      normalizedClaim
        .split(' ')
        .filter((word) => word.length > 2 && !this.isStructuredStopWord(word))
    );
    if (claimWords.size === 0) return null;

    let bestGroup: DirectCitationPageGroup | null = null;
    let bestScore = 0;
    let runnerUpGroup: DirectCitationPageGroup | null = null;
    let runnerUpScore = 0;

    for (const group of pageGroups) {
      const score = this.scoreClaimAgainstSourceContent(
        normalizedClaim,
        `${group.documentTitle}\n${group.combinedContent}`
      );

      if (score > bestScore) {
        runnerUpGroup = bestGroup;
        runnerUpScore = bestScore;
        bestGroup = group;
        bestScore = score;
      } else if (score > runnerUpScore) {
        runnerUpGroup = group;
        runnerUpScore = score;
      }
    }

    if (!bestGroup || bestScore < 0.45) {
      return null;
    }

    if (
      runnerUpGroup &&
      runnerUpGroup !== bestGroup &&
      (bestScore - runnerUpScore) <= 0.03 &&
      runnerUpGroup.maxSimilarity > bestGroup.maxSimilarity
    ) {
      return runnerUpGroup;
    }

    return bestGroup;
  }

  private renderStructuredAnswerMarkdownWithCitations(
    structured: StructuredAnswerResponse,
    contract: AnswerContract,
    searchResults: VectorSearchResult[]
  ): RenderedStructuredAnswerWithCitations {
    const structuredSections = new Map<string, string[]>();
    const structuredSubsections = new Map<string, Array<{ title: string; claims: string[] }>>();
    for (const section of structured.sections) {
      const key = this.normalizeStructuredSectionTitle(section.title).toLowerCase();
      if (!key) continue;
      const currentClaims = structuredSections.get(key) || [];
      currentClaims.push(...(section.claims || []));
      structuredSections.set(key, currentClaims);

      if (section.subsections && section.subsections.length > 0) {
        const currentSubsections = structuredSubsections.get(key) || [];
        currentSubsections.push(...section.subsections);
        structuredSubsections.set(key, currentSubsections);
      }
    }

    const pageGroups = this.buildDirectCitationPageGroups(searchResults);
    const citationIndexByKey = new Map<string, number>();
    const citations: SimplifiedCitation[] = [];
    const lines: string[] = [];

    const ensureCitationIndex = (group: DirectCitationPageGroup): number => {
      const existing = citationIndexByKey.get(group.key);
      if (existing) return existing;

      const sourceIndex = citations.length + 1;
      citationIndexByKey.set(group.key, sourceIndex);
      citations.push({
        document: group.documentTitle,
        page: group.page,
        combinedContent: group.combinedContent,
        sourceIndex,
        chunkIds: group.chunks.map((chunk) => chunk.id),
        similarity: group.maxSimilarity,
      });
      return sourceIndex;
    };

    const renderClaimWithCitation = (claim: string): string | null => {
      const target = this.selectBestCitationTargetForClaim(claim, pageGroups);
      if (!target) return null;

      const citationIndex = ensureCitationIndex(target);
      return `${claim} [${citationIndex}]`;
    };

    for (const requiredSection of contract.sections) {
      const key = this.normalizeStructuredSectionTitle(requiredSection.title).toLowerCase();
      const claims = (structuredSections.get(key) || []).filter((claim) => this.isExplicitlySupportedClaim(claim, searchResults));
      const subsections = (structuredSubsections.get(key) || [])
        .map((subsection) => ({
          title: subsection.title,
          claims: subsection.claims.filter((claim) => this.isExplicitlySupportedClaim(claim, searchResults)),
        }))
        .filter((subsection) => subsection.claims.length > 0);

      lines.push(`## ${requiredSection.title}`);
      if (claims.length === 0 && subsections.length === 0) {
        lines.push('- Not found in provided sources.');
      } else if (subsections.length === 0) {
        let emittedClaim = false;
        for (const claim of claims) {
          const renderedClaim = renderClaimWithCitation(claim);
          if (!renderedClaim) continue;
          lines.push(`- ${renderedClaim}`);
          emittedClaim = true;
        }
        if (!emittedClaim) {
          lines.push('- Not found in provided sources.');
        }
      } else {
        if (claims.length > 0) {
          let emittedClaim = false;
          for (const claim of claims) {
            const renderedClaim = renderClaimWithCitation(claim);
            if (!renderedClaim) continue;
            lines.push(`- ${renderedClaim}`);
            emittedClaim = true;
          }
          if (!emittedClaim) {
            lines.push('- Not found in provided sources.');
          }
          lines.push('');
        }

        for (const subsection of subsections) {
          lines.push(`### ${subsection.title}`);
          let emittedSubsectionClaim = false;
          for (const claim of subsection.claims) {
            const renderedClaim = renderClaimWithCitation(claim);
            if (!renderedClaim) continue;
            lines.push(`- ${renderedClaim}`);
            emittedSubsectionClaim = true;
          }
          if (!emittedSubsectionClaim) {
            lines.push('- Not found in provided sources.');
          }
          lines.push('');
        }
      }
      lines.push('');
    }

    return {
      content: lines.join('\n').trim(),
      citations,
    };
  }

  private isExplicitlySupportedClaim(claim: string, searchResults: VectorSearchResult[]): boolean {
    const normalizedClaim = this.normalizeExplicitComparisonText(claim);
    if (!normalizedClaim) return false;

    if (normalizedClaim.length < 3) return false;

    const claimWords = new Set(
      normalizedClaim
        .split(' ')
        .filter((word) => word.length > 2 && !this.isStructuredStopWord(word))
    );
    if (claimWords.size === 0) return false;

    for (const result of searchResults) {
      const sourceText = `${result.document?.title || ''}\n${result.chunk?.content || ''}`;
      const normalizedSource = this.normalizeExplicitComparisonText(sourceText);
      if (!normalizedSource) continue;

      if (normalizedSource.includes(normalizedClaim)) {
        return true;
      }

      const sentenceScore = this.scoreClaimAgainstSourceSentences(normalizedClaim, sourceText);
      if (sentenceScore >= 0.7) {
        return true;
      }

      const paragraphScore = this.scoreClaimAgainstSourceParagraph(normalizedClaim, sourceText);
      if (paragraphScore >= 0.58) {
        return true;
      }

      const overlapScore = this.scoreTokenOverlap(claimWords, normalizedSource);
      if (overlapScore >= 0.72) {
        return true;
      }
    }

    return false;
  }

  private scoreClaimAgainstSourceSentences(claim: string, sourceText: string): number {
    const sentences = sourceText
      .replace(/\r\n/g, '\n')
      .split(/(?<=[.!?])\s+|\n+/)
      .map((sentence) => this.normalizeExplicitComparisonText(sentence))
      .filter(Boolean);

    let best = 0;
    for (const sentence of sentences) {
      const score = this.scoreTokenOverlap(
        new Set(claim.split(' ').filter((word) => word.length > 2 && !this.isStructuredStopWord(word))),
        sentence
      );
      if (score > best) best = score;
    }
    return best;
  }

  private scoreClaimAgainstSourceParagraph(claim: string, sourceText: string): number {
    const paragraphs = sourceText
      .replace(/\r\n/g, '\n')
      .split(/\n{2,}/)
      .map((paragraph) => this.normalizeExplicitComparisonText(paragraph))
      .filter(Boolean);

    let best = 0;
    const claimWords = new Set(
      claim.split(' ').filter((word) => word.length > 2 && !this.isStructuredStopWord(word))
    );

    for (const paragraph of paragraphs) {
      const score = this.scoreTokenOverlap(claimWords, paragraph);
      if (score > best) best = score;
    }
    return best;
  }

  private scoreTokenOverlap(claimWords: Set<string>, sourceText: string): number;
  private scoreTokenOverlap(claimWords: Set<string>, sourceText: string): number {
    const normalizedSource = this.normalizeExplicitComparisonText(sourceText);
    if (!normalizedSource) return 0;

    const sourceWords = new Set(
      normalizedSource.split(' ').filter((word) => word.length > 2 && !this.isStructuredStopWord(word))
    );
    if (claimWords.size === 0 || sourceWords.size === 0) return 0;

    let intersection = 0;
    claimWords.forEach((word) => {
      if (sourceWords.has(word)) intersection += 1;
    });

    const score = intersection / Math.sqrt(claimWords.size * sourceWords.size);
    return Math.min(1, score);
  }

  private normalizeExplicitComparisonText(text: string): string {
    return (text || '')
      .toLowerCase()
      .replace(/[\u00A0\u2007\u202F]/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private isStructuredStopWord(word: string): boolean {
    return new Set([
      'the', 'and', 'or', 'for', 'from', 'with', 'without', 'into', 'onto', 'over', 'under',
      'that', 'this', 'these', 'those', 'were', 'was', 'are', 'is', 'be', 'been', 'being',
      'only', 'also', 'when', 'then', 'than', 'such', 'may', 'can', 'will', 'would', 'should',
      'could', 'there', 'their', 'them', 'they', 'its', 'it', 'as', 'at', 'by', 'of', 'to', 'in'
    ]).has(word);
  }

  /**
   * Fallback citation builder when the model does not emit [n] markers.
   * Uses top retrieved chunks, deduplicated by document+page.
   */
  private buildFallbackCitationsFromSearchResults(searchResults: any[], limit: number = 6): any[] {
    const fallbackCitations: any[] = [];
    const seenKeys = new Set<string>();

    const isLowContent = (text: string): boolean => {
      const compact = (text || '').replace(/\s+/g, ' ').trim();
      if (compact.length < 220) return true;
      const alphaChars = compact.replace(/[^A-Za-z]/g, '').length;
      const words = compact.split(/\s+/).filter(Boolean);
      const uniqueWords = new Set(words.map((w) => w.toLowerCase())).size;
      return alphaChars < 100 || words.length < 35 || uniqueWords < 18;
    };

    const preferred = searchResults.filter((result) => !isLowContent(result.chunk?.content || ''));
    const candidates = preferred.length > 0 ? preferred : searchResults;

    for (const result of candidates) {
      const documentName = result.document?.title || result.document?.fileName || 'Unknown Document';
      const page =
        result.chunk?.metadata?.pageNumbers?.[0] ??
        result.chunk?.page ??
        result.chunk?.metadata?.pageNumber;

      const dedupeKey = `${documentName}::${page ?? 'unknown'}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);

      fallbackCitations.push({
        document: documentName,
        page: typeof page === 'number' ? page : undefined,
        excerpt: (result.chunk?.content || '').slice(0, 2000),
      });

      if (fallbackCitations.length >= limit) break;
    }

    return fallbackCitations;
  }

  /**
   * Keep inline [n] markers and references panel perfectly aligned.
   * Removes out-of-range markers, then compacts numbering to 1..N.
   */
  private enforceCitationConsistency(
    content: string,
    citations: any[]
  ): { content: string; citations: any[] } {
    const normalizedBrackets = content
      .replace(/[【［]/g, '[')
      .replace(/[】］]/g, ']');

    if (!citations || citations.length === 0) {
      // No references available: remove dangling numeric citation markers.
      return {
        content: normalizedBrackets
          .replace(/\[[^\]]+\]/g, '')
          .replace(/\b\d+†L\d+(?:-L?\d+)?\b/g, '')
          .replace(/ +([.,;:!])/g, '$1')
          .trim(),
        citations: [],
      };
    }

    const extractIndices = (innerContent: string): number[] => {
      const indices: number[] = [];
      const seen = new Set<number>();
      for (const segment of innerContent.split(',')) {
        const match = segment.match(/^\s*(\d+)/);
        if (!match) continue;
        const idx = parseInt(match[1], 10);
        if (Number.isNaN(idx) || seen.has(idx)) continue;
        seen.add(idx);
        indices.push(idx);
      }
      return indices;
    };

    const maxIndex = citations.length;
    let normalized = normalizedBrackets.replace(/\[([^\]]+)\]/g, (_match, inner: string) => {
      const inRange = extractIndices(inner)
        .filter((n) => n >= 1 && n <= maxIndex)
        .sort((a, b) => a - b);
      if (inRange.length === 0) return '';
      return `[${inRange.join(', ')}]`;
    });

    // Remove leftover non-standard citation artifacts.
    normalized = normalized
      .replace(/\b\d+†L\d+(?:-L?\d+)?\b/g, '')
      .replace(/\[\s*(?:\+|†)[^\]]*\]/g, '');

    const used = new Set<number>();
    normalized.replace(/\[([^\]]+)\]/g, (_match, inner: string) => {
      extractIndices(inner).forEach((n) => used.add(n));
      return '';
    });

    if (used.size === 0) {
      return {
        content: normalized.replace(/ +([.,;:!])/g, '$1').trim(),
        citations,
      };
    }

    const sortedUsed = Array.from(used).sort((a, b) => a - b);
    const indexMap = new Map<number, number>();
    sortedUsed.forEach((oldIndex, i) => indexMap.set(oldIndex, i + 1));

    normalized = normalized.replace(/\[([^\]]+)\]/g, (_match, inner: string) => {
      const remapped = extractIndices(inner)
        .map((n) => indexMap.get(n))
        .filter((n): n is number => typeof n === 'number')
        .sort((a, b) => a - b);
      if (remapped.length === 0) return '';
      return `[${remapped.join(', ')}]`;
    });

    const compactedCitations = sortedUsed.map((oldIndex) => citations[oldIndex - 1]).filter(Boolean);

    return {
      content: normalized.replace(/ +([.,;:!])/g, '$1').trim(),
      citations: compactedCitations,
    };
  }

  /**
   * Backfill citations onto substantive lines when the model produced grounded
   * content but skipped inline markers on some bullets or sentences.
   */
  private backfillMissingInlineCitations(
    content: string,
    citations: Array<{ excerpt?: string; document?: string; page?: number }>,
    retrievalSimilarities?: number[]  // parallel array: similarity[i] for citations[i]
  ): string {
    if (!content || !citations || citations.length === 0) {
      return content;
    }

    const hasCitationMarker = (line: string): boolean => /\[\s*\d+(?:\s*,\s*\d+)*[^\]]*\]/.test(line);
    const isStructuralLine = (line: string): boolean =>
      /^#{1,6}\s/.test(line.trim()) ||
      /^\*\*[^*]+\*\*:?\s*$/.test(line.trim()) ||
      /^[-*•]\s*$/.test(line.trim()) ||
      /^\d+\.\s*$/.test(line.trim()) ||
      /^---+$/.test(line.trim()) ||
      line.trim().endsWith(':');

    const normalize = (text: string): string =>
      text
        .toLowerCase()
        .replace(/[\u00A0\u2007\u202F]/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const scoreLineAgainstSource = (line: string, sourceText: string): number => {
      const a = normalize(line);
      const b = normalize(sourceText);
      if (!a || !b) return 0;

      const wordsA = new Set(a.split(' ').filter((w) => w.length > 2));
      const wordsB = new Set(b.split(' ').filter((w) => w.length > 2));
      if (wordsA.size === 0 || wordsB.size === 0) return 0;

      let intersection = 0;
      wordsA.forEach((w) => {
        if (wordsB.has(w)) intersection += 1;
      });

      let bonus = 0;
      for (const token of Array.from(wordsA).filter((w) => w.length >= 6).slice(0, 6)) {
        if (b.includes(token)) bonus += 0.02;
      }

      return Math.min(1, intersection / Math.sqrt(wordsA.size * wordsB.size) + bonus);
    };

    // Minimum content-overlap threshold to assign any citation.
    // Raised from 0.12 → 0.15 to reduce low-confidence misattributions.
    const MIN_OVERLAP = 0.15;
    // Tiebreaker tolerance: if two chunks score within this band, defer to retrieval similarity.
    const TIEBREAK_BAND = 0.05;
    // Topic mismatch guard: chunks with low retrieval similarity need a higher content bar.
    const LOW_SIMILARITY_THRESHOLD = 0.5;
    const LOW_SIMILARITY_OVERLAP_FLOOR = 0.2;

    const lines = content.split('\n');
    const annotated = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || hasCitationMarker(trimmed) || isStructuralLine(trimmed)) {
        return line;
      }

      // Keep short helper text uncited unless it clearly looks like a factual statement.
      if (trimmed.length < 40) {
        return line;
      }

      let bestIndex = -1;
      let bestScore = 0;
      let runnerUpIndex = -1;
      let runnerUpScore = 0;

      citations.forEach((citation, index) => {
        const retrievalSim = retrievalSimilarities?.[index] ?? 1;

        // Fix 3 — topic mismatch guard: if retrieval ranked this chunk low,
        // require stronger content overlap before attributing to it.
        const effectiveFloor = retrievalSim < LOW_SIMILARITY_THRESHOLD
          ? LOW_SIMILARITY_OVERLAP_FLOOR
          : MIN_OVERLAP;

        const sourceText = `${citation.document || ''} ${citation.page ?? ''} ${citation.excerpt || ''}`;
        const score = scoreLineAgainstSource(trimmed, sourceText);

        if (score < effectiveFloor) return; // below floor — skip this chunk entirely

        if (score > bestScore) {
          runnerUpIndex = bestIndex;
          runnerUpScore = bestScore;
          bestIndex = index;
          bestScore = score;
        } else if (score > runnerUpScore) {
          runnerUpIndex = index;
          runnerUpScore = score;
        }
      });

      if (bestIndex < 0 || bestScore < MIN_OVERLAP) {
        return line;
      }

      // Fix 2 — similarity tiebreaker: when runner-up is within TIEBREAK_BAND,
      // prefer whichever chunk has the higher retrieval similarity score.
      let primaryIndex = bestIndex;
      if (
        runnerUpIndex >= 0 &&
        runnerUpIndex !== bestIndex &&
        runnerUpScore >= MIN_OVERLAP &&
        (bestScore - runnerUpScore) <= TIEBREAK_BAND &&
        retrievalSimilarities
      ) {
        const bestSim = retrievalSimilarities[bestIndex] ?? 0;
        const runnerSim = retrievalSimilarities[runnerUpIndex] ?? 0;
        if (runnerSim > bestSim) {
          // Runner-up was deemed more relevant by retrieval — trust that signal.
          primaryIndex = runnerUpIndex;
          console.log(
            '[BACKFILL TIEBREAKER]',
            `Line overlap tie (${bestScore.toFixed(3)} vs ${runnerUpScore.toFixed(3)}): preferring chunk [${runnerUpIndex + 1}] (sim=${runnerSim.toFixed(3)}) over [${bestIndex + 1}] (sim=${bestSim.toFixed(3)})`
          );
        }
      }

      const markerIndices = [primaryIndex + 1];
      // Only include runner-up if it's NOT the one we deferred to via tiebreaker.
      const secondaryIndex = primaryIndex === bestIndex ? runnerUpIndex : bestIndex;
      if (
        secondaryIndex >= 0 &&
        secondaryIndex !== primaryIndex &&
        runnerUpScore >= MIN_OVERLAP &&
        (bestScore - runnerUpScore) <= TIEBREAK_BAND
      ) {
        markerIndices.push(secondaryIndex + 1);
      }

      // Deduplicate before formatting (e.g. handle [1][1] cases)
      const uniqueMarkers = [...new Set(markerIndices)].sort((a: number, b: number) => a - b);
      const markerText = uniqueMarkers.map((num) => `[${num}]`).join(' ');

      return /[.,;:!?]\s*$/.test(line)
        ? line.replace(/([.,;:!?])\s*$/, ` ${markerText}$1`)
        : `${line} ${markerText}`;
    });

    return annotated.join('\n');
  }

  /**
   * Show users the exact query text answered by the model.
   */
  private prependAnsweredQueryHeader(content: string, answeredQuery: string): string {
    const safeQuery = (answeredQuery || '').trim();
    if (!safeQuery) return content;

    const existing = content.trimStart();
    const headerRegex = /^\*\*Answer for:\*\*\s*".*?"\s*\n/i;
    if (headerRegex.test(existing)) {
      return content;
    }

    return `**Answer for:** "${safeQuery}"\n\n${content}`;
  }


  /**
   * Get enhanced system prompt based on Flutter app's approach
   */
  private getDefaultSystemPrompt(searchResults?: any[]): string {
    const availableSources = searchResults?.length || 0;

    return `You are a helpful AI assistant that answers questions based on the provided document context.

CRITICAL CONSTRAINT - READ CAREFULLY:
- You MUST ONLY use information from the provided context documents
- You are FORBIDDEN from using any general knowledge, external information, or knowledge from your training data
- If the context does not contain the answer, you MUST respond with "I cannot answer this question based on the provided documents."
- Do NOT attempt to answer questions about topics not covered in the context (e.g., "who is the president", current events, general knowledge)
- Every single statement you make must be supported by the provided context
- NEVER answer questions about politics, current events, celebrities, sports, or any topic not in the documents
- If someone asks "who is the president" or similar general knowledge questions, you must respond that you cannot answer based on the provided documents

CONTEXT USAGE:
- Use ONLY the provided context to inform your answers
- Base your responses ENTIRELY on the given documents
- Don't mention "according to the context" or similar phrases
- If context doesn't contain relevant information, say so clearly
- Conversation continuity: if the latest user query is a short follow-up and clearly related to the previous user query, continue with the same disease/topic unless user explicitly switches topics

MEDICAL ABBREVIATIONS AND TERMINOLOGY:
When processing medical queries, understand and use these common medical terms and abbreviations:
- "rx" or "Rx" means complete treatment (both medical and surgical)
- "Tx" or "tx" means complete treatment (both medical and surgical)
- "Dx" or "dx" means diagnosis (you should search for history, clinical features, and investigations of the condition)
- "inv" or "Inv" means investigations or diagnostic tests
- "Features" or "Clinical Features": means ONLY History and Clinical Examination findings of that disease or condition. This EXCLUDES investigation/lab findings. Focus on symptoms (what patient reports) and signs (what doctor finds on examination)
- "Management" or "Treatment": means the therapeutic approach - treatment guidelines, protocols, drugs/medications given, dosages, and any surgical or invasive interventions. Focus on HOW to treat the condition

CRITICAL CITATION ACCURACY REQUIREMENTS:
- BEFORE citing any source, VERIFY that the information you're presenting actually appears in that source
- Each citation [number] MUST reference a source that CONTAINS the specific information you're citing
- NEVER cite a source that discusses a different topic, even if it's related
- Example: If you're defining "cataract", ONLY cite sources that actually contain the cataract definition
- DO NOT cite sources about ophthalmoscopy or ultrasound when defining cataract
- Read each source carefully and ensure the content matches what you're claiming
- If you're unsure whether a source contains the information, DO NOT cite it
- It is BETTER to have fewer citations than to cite irrelevant sources

VANCOUVER CITATION REQUIREMENTS:
- ALWAYS cite your sources using Vancouver style: [1], [2], [3] format
- Each citation must reference the specific document chunk that DIRECTLY supports your statement
- Use citations for ALL factual claims, statistics, quotes, and specific information
- Citations are MANDATORY - every factual statement must have a citation
- Don't cite general knowledge or common sense statements (but you shouldn't be using these anyway)
- Place citations immediately after the information they support
- Citations must be numbered sequentially in the order they appear in your response
- CRITICAL: Only use citation numbers that correspond to the provided context sources (1 through ${availableSources})
- NEVER invent citation numbers or use numbers outside the available range
- Each citation number must match exactly one source from the provided context
- WARNING: Citing incorrect sources will mislead users and is unacceptable
- Every factual paragraph or bullet must include at least one citation marker [n]

RESPONSE GUIDELINES:
- Be accurate and helpful
- Provide comprehensive answers first, then keep them readable and organized
- Do not cut off a list early if the source still has more items
- Handle unit conversions for medical/technical data (e.g., temperatures, weights)
- Maintain a professional but conversational tone
- If multiple documents provide conflicting information, acknowledge the discrepancy
- Do NOT use markdown tables unless the user explicitly asks for a table
- Prefer headings, short paragraphs, and bullet lists for better mobile readability
- Be thorough and complete. If the source contains several relevant points, list them all in a clear structure instead of compressing them into a short summary.
- For classification-style questions, include every distinct system, subtype, and criterion found in the retrieved text.

CITATION VERIFICATION PROCESS:
1. Make a factual claim
2. IMMEDIATELY check if the source [number] actually contains this information
3. If YES, add the citation
4. If NO, either find the correct source or remove the claim
5. Double-check: Does source [number] really say what I'm claiming?

ANSWER STRUCTURE:
1. Direct answer to the question
2. Supporting details with VERIFIED citations
3. Additional relevant context if available

Remember: Your goal is to provide accurate, well-cited responses based SOLELY on the provided document context. NEVER use external knowledge. If the context doesn't contain the answer, explicitly state that you cannot answer based on the provided documents. CITATION ACCURACY IS YOUR HIGHEST PRIORITY.`;
  }

  /**
   * Clear chat history for a session
   */
  async clearHistory(sessionId: string): Promise<void> {
    const session = await this.indexedDBServices.sessionService.getSession(sessionId);
    await this.indexedDBServices.messageService.deleteMessagesBySession(sessionId, session?.userId);
    await this.indexedDBServices.sessionService.updateSession(
      sessionId,
      { latestRewriteQueryResponse: null },
      session?.userId
    );
  }

  /**
   * Get message history for a session
   */
  async getHistory(sessionId: string): Promise<Message[]> {
    // Get session to verify ownership and get userId
    const session = await this.indexedDBServices.sessionService.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    return await this.indexedDBServices.messageService.getMessagesBySession(sessionId, session.userId);
  }

  /**
   * Validate streaming chunk for quality control
   */
  private validateStreamingChunk(chunk: string, fullResponse: string): {
    isValid: boolean;
    warnings: string[];
  } {
    const warnings: string[] = [];
    let isValid = true;

    // Check for repeated content (possible loops)
    if (fullResponse.length > 100 && chunk.length > 0) {
      const recentText = fullResponse.slice(-100);
      if (recentText.includes(chunk) && chunk.length > 10) {
        warnings.push('Possible content repetition detected');
        isValid = false;
      }
    }

    // Check for excessive citation density
    const citationMatches = (fullResponse + chunk).match(/\[\d+\]/g);
    if (citationMatches && citationMatches.length > 10) {
      warnings.push('High citation density detected');
    }

    // Check for response getting too long
    if (fullResponse.length > 8000) {
      warnings.push('Response approaching maximum length');
    }

    return { isValid, warnings };
  }
}

// Singleton instance
export const chatPipeline = new ChatPipeline();
