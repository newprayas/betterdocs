import { db } from '../services/indexedDB/db';
import { cosineSimilarity, calculateVectorNorm, decompressVector } from '../utils/vectorUtils';
import type { VectorSearchResult } from '../types';

type WorkerMessage =
  | { type: 'SEARCH', payload: { queryEmbedding: Float32Array; sessionId: string; options: SearchOptions } }
  | { type: 'INIT' };

type WorkerResponse =
  | { type: 'SEARCH_RESULT', payload: VectorSearchResult[] }
  | { type: 'ERROR', error: string };

type RetrievalMode = 'legacy_hybrid' | 'ann_rerank_v1';

interface SearchOptions {
  maxResults?: number;
  similarityThreshold?: number;
  documentIds?: string[];
  userId?: string;
  retrievalMode?: RetrievalMode;
  annCandidateMultiplier?: number;
}

interface ParsedAnnGraph {
  dimension: number;
  nodeCount: number;
  m: number;
  entryPoint: number;
  efSearch: number;
  scale: number;
  vectors: Int8Array;
  norms: Float32Array;
  neighbors: Int32Array;
}

interface ParsedAnnIndex {
  id: string;
  documentId: string;
  idMap: string[];
  graph: ParsedAnnGraph;
}

interface CandidateScore {
  id: string;
  similarity: number;
}

const MAGIC = 'HNSWANN1';
const HEADER_BYTES = 36;
const MAX_DOC_EF_FLOOR = 48;
const ANN_CACHE = new Map<string, ParsedAnnIndex>();
const ctx: Worker = self as any;

ctx.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const data = event.data;

  try {
    if (data.type === 'SEARCH') {
      const results = await performVectorSearch(
        data.payload.queryEmbedding,
        data.payload.sessionId,
        data.payload.options
      );
      ctx.postMessage({ type: 'SEARCH_RESULT', payload: results } satisfies WorkerResponse);
    }
  } catch (error: any) {
    console.error('Vector Search Worker Error:', error);
    ctx.postMessage({ type: 'ERROR', error: error.message || 'Unknown worker error' } satisfies WorkerResponse);
  }
};

async function performVectorSearch(
  queryEmbedding: Float32Array,
  sessionId: string,
  options: SearchOptions
): Promise<VectorSearchResult[]> {
  const {
    maxResults = 8,
    similarityThreshold = 0.7,
    documentIds,
    retrievalMode = 'legacy_hybrid',
    annCandidateMultiplier = 12
  } = options;

  if (!db) {
    throw new Error('Database not initialized in worker');
  }

  console.log(
    '[RETRIEVAL WORKER] mode=%s maxResults=%d threshold=%s',
    retrievalMode,
    maxResults,
    similarityThreshold.toFixed(3)
  );

  if (retrievalMode !== 'ann_rerank_v1') {
    console.log('[RETRIEVAL WORKER] Using legacy brute-force vector search');
    return bruteForceVectorSearch(queryEmbedding, sessionId, {
      maxResults,
      similarityThreshold,
      documentIds
    });
  }

  console.log('[RETRIEVAL WORKER] Using ANN candidate search');
  try {
    return await annVectorSearch(queryEmbedding, sessionId, {
      maxResults,
      similarityThreshold,
      documentIds,
      annCandidateMultiplier
    });
  } catch (annError) {
    console.warn('[ANN SEARCH] Falling back to brute-force:', annError);
    return bruteForceVectorSearch(queryEmbedding, sessionId, {
      maxResults,
      similarityThreshold,
      documentIds
    });
  }
}

async function annVectorSearch(
  queryEmbedding: Float32Array,
  sessionId: string,
  options: {
    maxResults: number;
    similarityThreshold: number;
    documentIds?: string[];
    annCandidateMultiplier: number;
  }
): Promise<VectorSearchResult[]> {
  const enabledDocIds = await getEnabledDocumentIds(sessionId, options.documentIds);
  if (enabledDocIds.length === 0) {
    return [];
  }

  const globalCandidateBudget = Math.max(options.maxResults * options.annCandidateMultiplier, 96);
  const perDocBudget = Math.max(Math.ceil(globalCandidateBudget / enabledDocIds.length), 24);
  console.log(
    '[ANN SEARCH] enabledDocs=%d globalBudget=%d perDocBudget=%d',
    enabledDocIds.length,
    globalCandidateBudget,
    perDocBudget
  );

  const queryNorm = calculateVectorNorm(queryEmbedding);
  const annCandidates: CandidateScore[] = [];
  const fallbackDocIds: string[] = [];
  let annDocsUsed = 0;

  for (const documentId of enabledDocIds) {
    let annIndex: ParsedAnnIndex | null = null;
    try {
      annIndex = await loadAnnIndex(documentId);
    } catch (indexError) {
      console.warn(`[ANN SEARCH] Index load failed for ${documentId}, using brute-force fallback`, indexError);
      fallbackDocIds.push(documentId);
      continue;
    }

    if (!annIndex) {
      fallbackDocIds.push(documentId);
      continue;
    }

    const approxCandidates = searchAnnGraph(
      annIndex,
      queryEmbedding,
      queryNorm,
      perDocBudget
    );

    if (approxCandidates.length === 0) {
      fallbackDocIds.push(documentId);
      continue;
    }

    annDocsUsed += 1;
    annCandidates.push(...approxCandidates);
  }

  const candidateMap = new Map<string, number>();
  annCandidates.forEach(candidate => {
    const existing = candidateMap.get(candidate.id);
    if (existing === undefined || candidate.similarity > existing) {
      candidateMap.set(candidate.id, candidate.similarity);
    }
  });

  const candidateIds = Array.from(candidateMap.keys());
  console.log(
    '[ANN SEARCH] annDocsUsed=%d fallbackDocs=%d approxCandidates=%d uniqueCandidates=%d',
    annDocsUsed,
    fallbackDocIds.length,
    annCandidates.length,
    candidateIds.length
  );
  const exactAnnScores = await scoreCandidatesExactly(queryEmbedding, queryNorm, candidateIds, options.similarityThreshold);

  const fallbackScores = fallbackDocIds.length > 0
    ? await bruteForceCandidateScores(queryEmbedding, queryNorm, fallbackDocIds, options.similarityThreshold)
    : [];
  console.log(
    '[ANN SEARCH] exactMatches=%d fallbackMatches=%d',
    exactAnnScores.length,
    fallbackScores.length
  );

  const combined = [...exactAnnScores, ...fallbackScores];
  combined.sort((a, b) => b.similarity - a.similarity);

  if (combined.length === 0) {
    return [];
  }

  const bestScore = combined[0].similarity;
  const cutoff = bestScore * 0.85;
  const filtered = combined.filter(item => item.similarity >= cutoff);
  const top = filtered.slice(0, Math.max(options.maxResults * 2, options.maxResults));
  console.log(
    '[ANN SEARCH] filtered=%d returnLimit=%d',
    filtered.length,
    Math.max(options.maxResults * 2, options.maxResults)
  );

  return hydrateVectorSearchResults(top).then(results => results.slice(0, options.maxResults));
}

async function bruteForceVectorSearch(
  queryEmbedding: Float32Array,
  sessionId: string,
  options: {
    maxResults: number;
    similarityThreshold: number;
    documentIds?: string[];
  }
): Promise<VectorSearchResult[]> {
  const queryNorm = calculateVectorNorm(queryEmbedding);
  const targetDocIds = await getEnabledDocumentIds(sessionId, options.documentIds);
  const candidateScores = await bruteForceCandidateScores(
    queryEmbedding,
    queryNorm,
    targetDocIds,
    options.similarityThreshold
  );

  candidateScores.sort((a, b) => b.similarity - a.similarity);

  if (candidateScores.length > 0) {
    const bestScore = candidateScores[0].similarity;
    const cutoff = bestScore * 0.85;
    const keepCount = candidateScores.findIndex(score => score.similarity < cutoff);
    if (keepCount > 0) {
      candidateScores.length = keepCount;
    }
  }

  const top = candidateScores.slice(0, options.maxResults);
  return hydrateVectorSearchResults(top);
}

async function bruteForceCandidateScores(
  queryEmbedding: Float32Array,
  queryNorm: number,
  documentIds: string[],
  similarityThreshold: number
): Promise<CandidateScore[]> {
  const scores: CandidateScore[] = [];
  if (!db || documentIds.length === 0) {
    return scores;
  }

  const processChunk = (chunk: any) => {
    const effectiveEmbedding = chunk.embeddingQuantized
      ? decompressVector(chunk.embeddingQuantized)
      : chunk.embedding;

    const similarity = cosineSimilarity(
      queryEmbedding,
      effectiveEmbedding,
      queryNorm,
      chunk.embeddingNorm
    );

    if (similarity >= similarityThreshold) {
      scores.push({ id: chunk.id, similarity });
    }
  };

  await db.embeddings
    .where('documentId')
    .anyOf(documentIds)
    .each(processChunk);

  return scores;
}

async function scoreCandidatesExactly(
  queryEmbedding: Float32Array,
  queryNorm: number,
  candidateIds: string[],
  similarityThreshold: number
): Promise<CandidateScore[]> {
  if (!db || candidateIds.length === 0) {
    return [];
  }

  const chunks = await db.embeddings.where('id').anyOf(candidateIds).toArray();
  const scores: CandidateScore[] = [];

  for (const chunk of chunks) {
    const effectiveEmbedding = chunk.embeddingQuantized
      ? decompressVector(chunk.embeddingQuantized)
      : chunk.embedding;

    const similarity = cosineSimilarity(queryEmbedding, effectiveEmbedding, queryNorm, chunk.embeddingNorm);
    if (similarity >= similarityThreshold) {
      scores.push({ id: chunk.id, similarity });
    }
  }

  return scores;
}

async function hydrateVectorSearchResults(scores: CandidateScore[]): Promise<VectorSearchResult[]> {
  if (!db || scores.length === 0) {
    return [];
  }

  const ids = scores.map(item => item.id);
  const chunks = await db.embeddings.where('id').anyOf(ids).toArray();
  const chunkMap = new Map(chunks.map(chunk => [chunk.id, chunk]));

  const docIds = Array.from(new Set(chunks.map(chunk => chunk.documentId)));
  const documents = docIds.length > 0 ? await db.documents.where('id').anyOf(docIds).toArray() : [];
  const docMap = new Map(documents.map(doc => [doc.id, doc]));

  const finalResults: VectorSearchResult[] = [];
  for (const item of scores) {
    const chunk = chunkMap.get(item.id);
    if (!chunk) continue;
    const doc = docMap.get(chunk.documentId);
    if (!doc) continue;

    finalResults.push({
      chunk,
      similarity: item.similarity,
      document: {
        id: doc.id,
        title: doc.title || doc.filename,
        fileName: doc.filename
      }
    });
  }

  return finalResults.sort((a, b) => b.similarity - a.similarity);
}

async function getEnabledDocumentIds(sessionId: string, explicitDocumentIds?: string[]): Promise<string[]> {
  if (!db) return [];
  if (explicitDocumentIds && explicitDocumentIds.length > 0) {
    return explicitDocumentIds;
  }

  const enabledDocIds = await db.documents
    .where('sessionId')
    .equals(sessionId)
    .and((doc: any) => doc.enabled === true)
    .primaryKeys();

  return enabledDocIds as string[];
}

async function loadAnnIndex(documentId: string): Promise<ParsedAnnIndex | null> {
  if (!db) return null;

  const entries = await db.annIndexes
    .where('documentId')
    .equals(documentId)
    .and((entry: any) => entry.state === 'ready')
    .toArray();

  if (entries.length === 0) {
    return null;
  }

  entries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const newest = entries[0];
  const cacheKey = newest.id;
  const cached = ANN_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  const parsedGraph = parseAnnGraph(newest.graphData);
  if (parsedGraph.nodeCount !== newest.idMap.length) {
    throw new Error(`ANN id-map size mismatch for document ${documentId}`);
  }

  const parsed: ParsedAnnIndex = {
    id: newest.id,
    documentId,
    idMap: newest.idMap,
    graph: parsedGraph
  };
  ANN_CACHE.set(cacheKey, parsed);
  return parsed;
}

function parseAnnGraph(buffer: ArrayBuffer): ParsedAnnGraph {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error('ANN graph buffer is too small');
  }

  const view = new DataView(buffer);
  const magicBytes = new Uint8Array(buffer, 0, 8);
  const magic = String.fromCharCode(...magicBytes);
  if (magic !== MAGIC) {
    throw new Error(`Invalid ANN graph magic: ${magic}`);
  }

  const version = view.getUint32(8, true);
  if (version !== 1) {
    throw new Error(`Unsupported ANN graph version: ${version}`);
  }

  const dimension = view.getUint32(12, true);
  const nodeCount = view.getUint32(16, true);
  const m = view.getUint32(20, true);
  const entryPoint = view.getUint32(24, true);
  const efSearch = view.getUint32(28, true);
  const scale = view.getFloat32(32, true);

  const vectorsBytes = nodeCount * dimension;
  const normsBytes = nodeCount * 4;
  const neighborsBytes = nodeCount * m * 4;
  const expected = HEADER_BYTES + vectorsBytes + normsBytes + neighborsBytes;
  if (buffer.byteLength !== expected) {
    throw new Error(`ANN graph size mismatch: expected ${expected}, got ${buffer.byteLength}`);
  }

  const vectorsOffset = HEADER_BYTES;
  const normsOffset = vectorsOffset + vectorsBytes;
  const neighborsOffset = normsOffset + normsBytes;

  return {
    dimension,
    nodeCount,
    m,
    entryPoint,
    efSearch,
    scale,
    vectors: new Int8Array(buffer, vectorsOffset, nodeCount * dimension),
    norms: new Float32Array(buffer, normsOffset, nodeCount),
    neighbors: new Int32Array(buffer, neighborsOffset, nodeCount * m)
  };
}

function searchAnnGraph(
  index: ParsedAnnIndex,
  queryEmbedding: Float32Array,
  queryNorm: number,
  docCandidateLimit: number
): CandidateScore[] {
  const { graph, idMap } = index;
  const ef = Math.max(graph.efSearch, MAX_DOC_EF_FLOOR, docCandidateLimit);

  if (graph.dimension !== queryEmbedding.length || graph.nodeCount === 0) {
    return [];
  }

  const visited = new Uint8Array(graph.nodeCount);
  const entry = Math.min(graph.entryPoint, graph.nodeCount - 1);

  const entryScore = approximateCosine(graph, queryEmbedding, queryNorm, entry);
  const candidates: Array<{ node: number; score: number }> = [{ node: entry, score: entryScore }];
  const top: Array<{ node: number; score: number }> = [{ node: entry, score: entryScore }];
  visited[entry] = 1;

  while (candidates.length > 0) {
    const current = candidates.shift()!;
    const worstTop = top.length >= ef ? top[top.length - 1].score : -Infinity;

    if (top.length >= ef && current.score < worstTop) {
      break;
    }

    const base = current.node * graph.m;
    for (let i = 0; i < graph.m; i++) {
      const neighbor = graph.neighbors[base + i];
      if (neighbor < 0 || neighbor >= graph.nodeCount) continue;
      if (visited[neighbor]) continue;

      visited[neighbor] = 1;
      const score = approximateCosine(graph, queryEmbedding, queryNorm, neighbor);
      if (top.length < ef || score > top[top.length - 1].score) {
        insertSortedDesc(candidates, { node: neighbor, score });
        insertTopResult(top, { node: neighbor, score }, ef);
      }
    }
  }

  const results = top
    .sort((a, b) => b.score - a.score)
    .slice(0, docCandidateLimit)
    .map(item => ({
      id: idMap[item.node],
      similarity: item.score
    }))
    .filter(item => !!item.id);

  return results;
}

function approximateCosine(
  graph: ParsedAnnGraph,
  queryEmbedding: Float32Array,
  queryNorm: number,
  nodeIndex: number
): number {
  const dim = graph.dimension;
  const start = nodeIndex * dim;
  let dot = 0;

  for (let i = 0; i < dim; i++) {
    dot += queryEmbedding[i] * (graph.vectors[start + i] * graph.scale);
  }

  const nodeNorm = graph.norms[nodeIndex];
  if (queryNorm === 0 || nodeNorm === 0) {
    return 0;
  }
  return dot / (queryNorm * nodeNorm);
}

function insertSortedDesc(
  arr: Array<{ node: number; score: number }>,
  item: { node: number; score: number }
): void {
  if (arr.length === 0) {
    arr.push(item);
    return;
  }

  let inserted = false;
  for (let i = 0; i < arr.length; i++) {
    if (item.score > arr[i].score) {
      arr.splice(i, 0, item);
      inserted = true;
      break;
    }
  }

  if (!inserted) {
    arr.push(item);
  }
}

function insertTopResult(
  top: Array<{ node: number; score: number }>,
  item: { node: number; score: number },
  limit: number
): void {
  insertSortedDesc(top, item);
  if (top.length > limit) {
    top.length = limit;
  }
}
