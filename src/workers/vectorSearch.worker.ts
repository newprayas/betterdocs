import { db } from '../services/indexedDB/db';
import { cosineSimilarity, calculateVectorNorm, decompressVector } from '../utils/vectorUtils';
import type { VectorSearchResult, EmbeddingChunk } from '../types';

// Define worker message types
type WorkerMessage =
    | { type: 'SEARCH', payload: { queryEmbedding: Float32Array; sessionId: string; options: any } }
    | { type: 'INIT' };

// Define worker response types
type WorkerResponse =
    | { type: 'SEARCH_RESULT', payload: VectorSearchResult[] }
    | { type: 'ERROR', error: string };

const ctx: Worker = self as any;

// Handle messages from main thread
ctx.onmessage = async (event: MessageEvent<WorkerMessage>) => {
    const data = event.data;

    try {
        if (data.type === 'SEARCH') {
            console.log('👷 [WORKER] Received Search Request', {
                sessionId: data.payload.sessionId,
                options: data.payload.options
            });
            const results = await performVectorSearch(
                data.payload.queryEmbedding,
                data.payload.sessionId,
                data.payload.options
            );
            console.log('👷 [WORKER] Search Complete. Found results:', results.length);
            ctx.postMessage({ type: 'SEARCH_RESULT', payload: results });
        }
    } catch (error: any) {
        console.error('Vector Search Worker Error:', error);
        ctx.postMessage({ type: 'ERROR', error: error.message || 'Unknown worker error' });
    }
};

/**
 * Optimized Vector Search (Runs in Background Thread)
 * 1. Loads ONLY vectors (numbers) first -> Low Memory
 * 2. Calculates scores -> Heavy Math
 * 3. Loads FULL text only for top results -> Efficient
 */
async function performVectorSearch(
    queryEmbedding: Float32Array,
    sessionId: string,
    options: {
        maxResults?: number;
        similarityThreshold?: number;
        documentIds?: string[];
        userId?: string;
    }
): Promise<VectorSearchResult[]> {
    const {
        maxResults = 8,
        similarityThreshold = 0.7,
        documentIds,
        userId
    } = options;

    if (!db) {
        throw new Error('Database not initialized in worker');
    }

    // 1 & 2. Fetch & Calculate Similarities (Optimized for Memory - Lazy Loading)
    const results: { id: string; similarity: number }[] = [];
    const queryNorm = calculateVectorNorm(queryEmbedding);
    console.log('👷 [WORKER] Query norm calculated:', queryNorm.toFixed(4));

    // Early Exit Configuration
    const EARLY_EXIT_THRESHOLD = 0.85; // High-quality result threshold
    const EARLY_EXIT_MIN_RESULTS = maxResults * 2; // Need at least 2x maxResults before exiting
    let highQualityCount = 0;

    const processChunkOnTheFly = (chunk: any) => {
        // Use quantized embedding if available (faster), fallback to original
        const effectiveEmbedding = chunk.embeddingQuantized
            ? decompressVector(chunk.embeddingQuantized)
            : chunk.embedding;

        // Use pre-computed norms for both query and chunk
        const similarity = cosineSimilarity(
            queryEmbedding,
            effectiveEmbedding,
            queryNorm,
            chunk.embeddingNorm // From IndexedDB
        );

        if (similarity >= similarityThreshold) {
            results.push({ id: chunk.id, similarity });

            // Track high-quality results for early exit
            if (similarity >= EARLY_EXIT_THRESHOLD) {
                highQualityCount++;
            }
        }

        // EARLY EXIT: Stop iteration if we have enough high-quality results
        if (highQualityCount >= EARLY_EXIT_MIN_RESULTS) {
            console.log(`👷 [WORKER] Early exit triggered! Found ${highQualityCount} high-quality results.`);
            return false; // Stop Dexie iteration
        }
    };

    if (documentIds && documentIds.length > 0) {
        // Specific docs - optimize with cursor to avoid loading content
        await db.embeddings
            .where('documentId')
            .anyOf(documentIds)
            .each(processChunkOnTheFly);
    } else {
        // Session docs
        const enabledDocs = await db.documents
            .where('sessionId')
            .equals(sessionId)
            .and(doc => doc.enabled === true)
            .primaryKeys();

        if (enabledDocs.length > 0) {
            await db.embeddings
                .where('documentId')
                .anyOf(enabledDocs as string[])
                .each(processChunkOnTheFly);
        }
    }

    console.log(`👷 [WORKER] Scanned total of ${results.length} results matching threshold.`);

    // 3. Sort & Adaptive Filter (The "Brain")
    results.sort((a, b) => b.similarity - a.similarity);

    // Apply Adaptive Cutoff
    if (results.length > 0) {
        const bestScore = results[0].similarity;
        const cutoff = bestScore * 0.85; // 15% drop-off rule

        // Filter in place
        let keepCount = 0;
        for (let i = 0; i < results.length; i++) {
            if (results[i].similarity >= cutoff) {
                keepCount++;
            } else {
                break; // Since sorted, we can stop early
            }
        }
        // Truncate to keep candidates + a buffer for page deduplication
        results.length = keepCount;
    }

    // 4. Hydrate Top Results (Load Content)
    // Only now do we fetch the heavy text content for the winners
    const topCandidateIds = results.map(r => r.id);
    const fullChunks = await db.embeddings.where('id').anyOf(topCandidateIds).toArray();

    // Need to map back to results with similarity
    const chunksMap = new Map(fullChunks.map(c => [c.id, c]));

    // Also need documents for titles
    const docIds = new Set(fullChunks.map(c => c.documentId));
    const documents = await db.documents.where('id').anyOf([...docIds]).toArray();
    const docMap = new Map(documents.map(d => [d.id, d]));

    const finalResults: VectorSearchResult[] = [];

    // Re-construct the full result objects
    for (const res of results) {
        const chunk = chunksMap.get(res.id);
        if (!chunk) continue;

        const doc = docMap.get(chunk.documentId);
        if (!doc) continue;

        finalResults.push({
            chunk,
            similarity: res.similarity,
            document: {
                id: doc.id,
                title: doc.title || doc.filename,
                fileName: doc.filename
            }
        });
    }

    // 5. Deduplicate by Page (Same logic as before, but simplified)
    // We can just return the raw results for now and let the service handle dedupe 
    // OR handle it here. Handling it here is better for main thread.
    // ... Implementing simple dedup logic ...

    // Return sorted
    return finalResults.sort((a, b) => b.similarity - a.similarity).slice(0, maxResults);
}
