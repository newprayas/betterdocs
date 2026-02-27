import { getIndexedDBServices } from '../indexedDB';
import { chatService, embeddingService } from '../gemini';
import { groqService } from '../groq/groqService';
import { vectorSearchService } from './vectorSearch';
import { documentProcessor } from './documentProcessor';
import { citationService } from './citationService';
import { MessageSender, type MessageCreate, type Message } from '@/types';
import type { Document, RouteIndexRecord } from '@/types';
import type { ChatStreamEvent } from '../gemini/chatService';
import type { SimplifiedCitationGroup } from '@/types/citation';
import type { EmbeddingChunk, VectorSearchResult } from '@/types/embedding';
import { cosineSimilarity, calculateVectorNorm } from '@/utils/vectorUtils';

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

export class ChatPipeline {
  private indexedDBServices = getIndexedDBServices();

  /**
   * Enhance user query with context information
   */
  private async enhanceQueryWithContext(sessionId: string, content: string): Promise<string> {
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

      // Create the enhanced query with context
      const enhancedQuery = `${content} [Context - ${sessionName} and related to ${relatedDocuments}]`;

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

    return normalized.replace(/\s+/g, ' ').trim();
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
    return (
      normalized.includes('i cannot answer this question based on the provided documents') ||
      normalized.includes('cannot answer this question based on the provided documents') ||
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

  private logRetrievedChunkDetails(
    searchResults: VectorSearchResult[],
    baseSearchResults: VectorSearchResult[]
  ): void {
    if (searchResults.length === 0) {
      console.log('[RETRIEVAL CHUNK DEBUG] No chunks were fed to the model.');
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

    const rankedResults = [...searchResults].sort((a, b) => b.similarity - a.similarity);
    const chunkNumberById = new Map<string, number>(
      rankedResults.map((result, index) => [result.chunk.id, index + 1])
    );

    console.log('\n=== RETRIEVAL CHUNK DEBUG START ===');
    console.log('[MODEL INPUT SUMMARY]', {
      totalChunksFedToModel: searchResults.length,
      baseRetrievedChunks: baseSearchResults.length,
      neighborChunksAdded: Math.max(0, searchResults.length - baseSearchResults.length),
      sortedBySimilarityForDebugView: true
    });

    console.log('\n=== RETRIEVAL CHUNK CONTENT START ===');
    rankedResults.forEach((result, index) => {
      const rank = index + 1;
      const modelInputOrder = searchResults.findIndex((item) => item.chunk.id === result.chunk.id) + 1;
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

      console.log('--------------------------------------------------');
      if (debugInfo.isNeighborChunk) {
        const neighborOffset = debugInfo.neighborRelation === 'above' ? '-1' : '+1';
        const neighborChunkLabel = neighborChunkNumber ? `Chunk ${neighborChunkNumber}` : 'Chunk ?';
        console.log(`${neighborOffset} Neighbor chunk ${neighborChunkLabel} | Similarity score: ${result.similarity.toFixed(3)}`);
      } else {
        console.log(`Chunk ${rank} | Similarity score: ${result.similarity.toFixed(3)}`);
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
    minSimilarity: number = 0.4,
    maxTotal: number = 12
  ): VectorSearchResult[] {
    if (baseResults.length === 0 || sessionEmbeddings.length === 0) {
      console.log(
        '[TOP CHUNK CONTEXT] Skipped (insufficient input): baseResults=%d embeddings=%d',
        baseResults.length,
        sessionEmbeddings.length
      );
      return baseResults;
    }

    const availableSlots = Math.max(0, maxTotal - baseResults.length);
    if (availableSlots <= 0) {
      console.log(
        '[TOP CHUNK CONTEXT] Skipped (no space): current=%d maxTotal=%d',
        baseResults.length,
        maxTotal
      );
      return baseResults;
    }

    const existingChunkIds = new Set(baseResults.map((r) => r.chunk.id));
    const topResult = baseResults.reduce((best, current) =>
      current.similarity > best.similarity ? current : best
    );
    const topChunkIndex = this.getEffectiveChunkIndex(topResult.chunk);

    if (topChunkIndex === null) {
      console.log(
        '[TOP CHUNK CONTEXT] Skipped (top chunk index unavailable): chunkId=%s',
        topResult.chunk.id
      );
      return baseResults;
    }

    const targetIndices = [topChunkIndex - 1, topChunkIndex + 1].filter((idx) => idx >= 0);
    const docId = topResult.document.id;
    const docInfo = topResult.document;

    console.log(
      '[TOP CHUNK CONTEXT] Top chunk=%s doc=%s idx=%d sim=%.3f slots=%d threshold=%.2f targetNeighborIdx=%o',
      topResult.chunk.id,
      docId,
      topChunkIndex,
      topResult.similarity,
      availableSlots,
      minSimilarity,
      targetIndices
    );

    const candidates: Array<{ chunk: EmbeddingChunk; similarity: number; relation: 'above' | 'below' }> = [];
    const missedTargets: number[] = [];

    for (const idx of targetIndices) {
      const neighborChunk = sessionEmbeddings.find((chunk) => {
        if (chunk.documentId !== docId) return false;
        const chunkIdx = this.getEffectiveChunkIndex(chunk);
        return chunkIdx === idx;
      });

      if (!neighborChunk) {
        missedTargets.push(idx);
        continue;
      }

      if (existingChunkIds.has(neighborChunk.id)) {
        continue;
      }

      const sim = cosineSimilarity(queryEmbedding, neighborChunk.embedding);
      if (sim < minSimilarity) {
        console.log(
          '[TOP CHUNK CONTEXT] Candidate rejected (below threshold): chunkId=%s idx=%d sim=%.3f threshold=%.2f',
          neighborChunk.id,
          idx,
          sim,
          minSimilarity
        );
        continue;
      }

      candidates.push({
        chunk: neighborChunk,
        similarity: sim,
        relation: idx < topChunkIndex ? 'above' : 'below'
      });
    }

    if (missedTargets.length > 0) {
      console.log('[TOP CHUNK CONTEXT] Missing neighbor chunk(s) for target idx=%o', missedTargets);
    }

    if (candidates.length === 0) {
      console.log('[TOP CHUNK CONTEXT] Attempted but added 0 chunk(s).');
      return baseResults;
    }

    const additions = candidates
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, availableSlots)
      .map(({ chunk, similarity, relation }) => ({
        chunk,
        similarity,
        document: docInfo,
        relation
      }));

    console.log(
      '[TOP CHUNK CONTEXT] Added %d adjacent chunk(s): %o',
      additions.length,
      additions.map((a) => ({
        chunkId: a.chunk.id,
        relation: a.relation,
        chunkIndex: this.getEffectiveChunkIndex(a.chunk),
        page: this.getChunkPageNumber(a.chunk),
        similarity: a.similarity
      }))
    );

    // Keep original ranked retrieval order, append adjacency context at the end.
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
    history: any[]
  ): Promise<string> {
    const normalizedOriginal = this.normalizeCommonMedicalTypos(content.trim().replace(/\s+/g, ' '));
    const mostRecentClarifiedQuery = this.extractMostRecentClarifiedQuery(history);
    const mostRecentAnswerForLine = this.extractMostRecentAnswerForLine(history);
    const rewriterSystemPrompt =
      'You rewrite medical user input into one high-quality standalone retrieval query. Expand shorthand into a clear, natural query while preserving intent.';
    const rewriterSystemPromptStrict =
      'Return exactly one non-empty standalone medical search query line. Expand shorthand, fix typos, preserve intent. No explanations, labels, or quotes.';

    const prompt = `
Rewrite the latest user query into one standalone retrieval query.

Goals:
1) Understand user intent and express it as a clearer, more complete query.
2) Expand short/fragmented wording into natural phrasing that improves retrieval.
3) Correct spelling/grammar.
4) If the latest query is a follow-up, use prior context to resolve meaning.
5) If it is unrelated, ignore prior context.
6) Keep meaning faithful to user intent; do not invent a new topic.
7) Output exactly one line: only the rewritten query.

Most Recent Clarified Query:
${mostRecentClarifiedQuery || 'None'}

Most Recent Answer Header Line (optional):
${mostRecentAnswerForLine || 'None'}

Latest User Query:
${normalizedOriginal}
`.trim();

    const strictPrompt = `
Return exactly one non-empty standalone medical retrieval query.
Make it clear and explicit from user intent.
Fix spelling and grammar.
Use prior clarified context only when query is a continuation.
If context is insufficient, rewrite the latest user query into the clearest possible standalone form.
Output exactly one line and nothing else.

Most Recent Clarified Query:
${mostRecentClarifiedQuery || 'None'}

Most Recent Answer Header Line (optional):
${mostRecentAnswerForLine || 'None'}

Latest User Query:
${normalizedOriginal}
`.trim();

    console.log('[QUERY REWRITER CONTEXT]', {
      latestUserQuery: normalizedOriginal,
      mostRecentClarifiedQuery: mostRecentClarifiedQuery || null,
      mostRecentAnswerForLine: mostRecentAnswerForLine || null,
      historyMessages: Array.isArray(history) ? history.length : 0,
    });
    console.log('[QUERY REWRITER PROMPT][SYSTEM][PRIMARY]', rewriterSystemPrompt);
    console.log('[QUERY REWRITER PROMPT][USER][PRIMARY]', prompt);

    try {
      let rewrittenQuery = await groqService.generateResponse(
        prompt,
        rewriterSystemPrompt,
        'gpt-oss-120b',
        {
          temperature: 0.2,
          maxTokens: 128,
        }
      );
      console.log('[QUERY REWRITER RAW][PRIMARY]', rewrittenQuery);

      let cleanedQuery = this.sanitizeRewriterOutput(rewrittenQuery);

      // Hard retry once with stricter prompt if primary output is empty.
      if (!cleanedQuery) {
        console.warn('[QUERY REWRITER]', 'Primary rewrite was empty. Retrying with strict prompt.');
        console.log('[QUERY REWRITER PROMPT][SYSTEM][STRICT]', rewriterSystemPromptStrict);
        console.log('[QUERY REWRITER PROMPT][USER][STRICT]', strictPrompt);
        rewrittenQuery = await groqService.generateResponse(
          strictPrompt,
          rewriterSystemPromptStrict,
          'gpt-oss-120b',
          {
            temperature: 0,
            maxTokens: 128,
          }
        );
        console.log('[QUERY REWRITER RAW][STRICT]', rewrittenQuery);
        cleanedQuery = this.sanitizeRewriterOutput(rewrittenQuery);
      }

      // If gpt-oss still returns empty, use a backup model once.
      if (!cleanedQuery) {
        console.warn('[QUERY REWRITER]', 'Strict rewrite was empty. Retrying with backup model llama3.1-8b.');
        rewrittenQuery = await groqService.generateResponse(
          strictPrompt,
          rewriterSystemPromptStrict,
          'llama3.1-8b',
          {
            temperature: 0,
            maxTokens: 128,
          }
        );
        console.log('[QUERY REWRITER RAW][FALLBACK_MODEL]', rewrittenQuery);
        cleanedQuery = this.sanitizeRewriterOutput(rewrittenQuery);
      }

      const rewriterRateLimitNotice = this.extractRateLimitNotice(cleanedQuery);
      if (rewriterRateLimitNotice) {
        console.warn('[QUERY REWRITER]', `Rate-limited rewrite response detected. Falling back to original query.`);
        return this.normalizeStandaloneQueryShape(normalizedOriginal);
      }

      // Keep fallback simple: only reject empty output.
      const wordCount = cleanedQuery.split(/\s+/).filter(Boolean).length;
      if (!cleanedQuery || wordCount === 0) {
        console.warn('[QUERY REWRITER]', `Rejected weak rewrite "${cleanedQuery}". Falling back to "${normalizedOriginal}"`);
        return this.normalizeStandaloneQueryShape(normalizedOriginal);
      }

      if (this.isLikelyTruncatedRewrite(cleanedQuery, normalizedOriginal)) {
        console.warn('[QUERY REWRITER]', `Rejected truncated rewrite "${cleanedQuery}". Falling back to "${normalizedOriginal}"`);
        return this.normalizeStandaloneQueryShape(normalizedOriginal);
      }

      const finalRewritten = this.normalizeStandaloneQueryShape(cleanedQuery);

      console.log('[QUERY REWRITER]', `Original: "${normalizedOriginal}" -> Rewritten: "${finalRewritten}"`);
      return finalRewritten;

    } catch (error) {
      console.error('[QUERY REWRITER ERROR]', error);
      return this.normalizeStandaloneQueryShape(normalizedOriginal);
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
      const sessionForDocuments = await this.indexedDBServices.sessionService.getSession(sessionId);
      if (!sessionForDocuments) {
        throw new Error('Session not found');
      }

      // 1. FETCH HISTORY (NEW STEP)
      // We need the history BEFORE we do the search
      console.log('[HISTORY]', 'Fetching chat history for context awareness...');
      const history = await this.indexedDBServices.messageService.getMessagesBySession(
        sessionId,
        sessionForDocuments.userId
      );

      const retrievalMode: 'ann_rerank_v1' = 'ann_rerank_v1';
      console.log('[RETRIEVAL MODE]', retrievalMode);

      // 2. GENERATE STANDALONE QUERY (NEW STEP)
      // This converts "What are its causes?" -> "What are the causes of cataract?"
      console.log('[REWRITING]', 'Generating standalone query...');
      const standaloneQuery = await this.generateStandaloneQuery(content, history);

      // 🔴 PROMINENT LOG: Show the converted query for tracking
      console.log('🔴 Converted query -:', `"${standaloneQuery}"`);

      // Update progress: Embedding Generation (50%)
      if (onStreamEvent) {
        onStreamEvent({ type: 'status', message: 'Embedding Generation' });
      }

      // 3. ENHANCE THE REWRITTEN QUERY, NOT THE ORIGINAL
      // Modify this line to pass 'standaloneQuery' instead of 'content'
      const enhancedQuery = await this.enhanceQueryWithContext(sessionId, standaloneQuery);
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

      // Also check if there are any embeddings available for enabled documents
      const indexedDBEmbeddingService = this.indexedDBServices.embeddingService;
      let embeddings: EmbeddingChunk[] = [];

      if (enabledDocuments.length > 0) {
        embeddings = await indexedDBEmbeddingService.getEnabledEmbeddingsBySession(sessionId, sessionForDocuments.userId);
      }

      console.log('[EMBEDDING STATUS]', `${embeddings.length} embeddings found for enabled documents`);

      if (enabledDocuments.length === 0 || embeddings.length === 0) {
        // No enabled documents or no embeddings available, just chat without context
        console.log('[PROCESSING MODE]', 'Direct response (no RAG context available)');
        await this.generateDirectResponse(sessionId, content, onStreamEvent);
        console.log('=== CHAT PIPELINE PROCESS END ===\n');
        return;
      }

      // 4. GENERATE EMBEDDING USING THE REWRITTEN QUERY
      console.log('[EMBEDDING GENERATION]', 'Creating vector embedding for enhanced query...');
      const queryEmbedding = await embeddingService.generateEmbedding(retrievalQuery);
      console.log('[EMBEDDING GENERATED]', `Vector created with ${queryEmbedding.length} dimensions`);
      const routePrefilter = await this.buildRoutePrefilterPlan(enabledDocuments, queryEmbedding);
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
      let searchResults = await vectorSearchService.searchHybridEnhanced(
        queryEmbedding,
        sessionId,
        retrievalQuery, // Use retrieval-expanded query for better recall
        {
          maxResults: 12,
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
      if (searchResults.length === 0 && standaloneQuery.trim().toLowerCase() !== content.trim().toLowerCase()) {
        console.warn('[SEARCH FALLBACK]', 'No results for rewritten query. Retrying with original query.');
        const fallbackEnhancedQuery = await this.enhanceQueryWithContext(sessionId, content);
        const fallbackRetrievalQuery = fallbackEnhancedQuery;
        const fallbackEmbedding = await embeddingService.generateEmbedding(fallbackRetrievalQuery);
        const fallbackRoutePrefilter = await this.buildRoutePrefilterPlan(enabledDocuments, fallbackEmbedding);
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
            maxResults: 12,
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
          console.log('[SEARCH FALLBACK]', `Recovered ${fallbackResults.length} result(s) using original query.`);
          searchResults = fallbackResults;
        }
      }
      const baseSearchResults = [...searchResults];

      // Neighbor-page inclusion: include page N-1 / N+1 chunks to preserve section continuity.
      searchResults = this.includeNeighborPageChunks(searchResults, embeddings, queryEmbedding, 0.6);
      // Top-chunk continuity: include above/below chunks for the highest-similarity hit when slots remain.
      searchResults = this.includeTopChunkAdjacentChunks(searchResults, embeddings, queryEmbedding, 0.4, 12);

      console.log('[SEARCH RESULTS]', `${searchResults.length} relevant chunks found`);
      console.log('✅ CHUNKS USED =', searchResults.length);

      // Update progress: Response Generation (90%)
      if (onStreamEvent) {
        onStreamEvent({ type: 'status', message: 'Response Generation' });
      }

      // Build context from search results
      console.log('[CONTEXT BUILDING]', 'Constructing context from search results...');
      const context = this.buildContext(searchResults);
      console.log('[CONTEXT CREATED]', `Context string length: ${context.length} characters`);

      // ... The rest of the function (Context Building, LLM Generation) remains the same ...
      // IMPORTANT: The final LLM call (generateSimplifiedContextualResponse)
      // should use the standalone query for better context understanding

      await this.generateSimplifiedContextualResponse(
        sessionId,
        standaloneQuery, // Use the rewritten query instead of original content
        this.buildContext(searchResults),
        searchResults,
        onStreamEvent
      );

      // Log exact chunk content passed to the model at the end of the pipeline.
      this.logRetrievedChunkDetails(searchResults, baseSearchResults);

      console.log('=== CHAT PIPELINE PROCESS END ===\n');

    } catch (error) {
      console.error('[PIPELINE ERROR]', 'Error in chat pipeline:', error);

      // Save error message
      const errorMessage: MessageCreate = {
        sessionId,
        content: 'Sorry, I encountered an error while processing your message. Please try again.',
        role: MessageSender.ASSISTANT,
      };

      await this.indexedDBServices.messageService.createMessage(errorMessage);
      console.log('[ERROR HANDLED]', 'Error message saved to database');
      console.log('=== CHAT PIPELINE PROCESS END (WITH ERROR) ===\n');
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
    const groqModel = settings?.groqModel || 'gpt-oss-120b';
    const temperature = settings?.temperature || 0.7;
    const maxTokens = settings?.maxTokens || 2048;

    // Build conversation history for inference service
    const groqPrompt = messages.map(msg =>
      `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`
    ).join('\n') + `\nUser: ${content}`;

    await groqService.generateStreamingResponse(
      groqPrompt,
      "You are a helpful medical AI assistant.",
      groqModel,
      {
        temperature,
        maxTokens,
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

    const messages = await this.indexedDBServices.messageService.getMessagesBySession(sessionId, session.userId);
    console.log('[CHAT HISTORY]', `Found ${messages.length} previous messages`);

    let fullResponse = '';

    const groqModel = settings?.groqModel || 'gpt-oss-120b';

    await groqService.generateStreamingResponse(
      `Context:\n${context}\n\nQuestion: ${content}`,
      systemPrompt,
      groqModel,
      {
        temperature: settings?.temperature || 0.7,
        maxTokens: settings?.maxTokens || 2048,
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
    onStreamEvent?: (event: ChatStreamEvent) => void
  ): Promise<void> {
    console.log('\n=== SIMPLIFIED CONTEXTUAL RESPONSE MODE (WITH RAG) ===');
    console.log('[SIMPLIFIED RAG MODE]', 'Generating response with simplified page-based citations');
    console.log('[SIMPLIFIED CONTEXT]', `Providing ${searchResults.length} context sources to LLM`);

    // Get session for system prompt
    // Get session for system prompt and userId
    const session = await this.indexedDBServices.sessionService.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const systemPrompt = this.getSimplifiedSystemPrompt(searchResults);
    console.log('[SIMPLIFIED SYSTEM PROMPT]', 'Using default simplified system prompt');

    const settings = await this.indexedDBServices.settingsService.getSettings(session.userId);
    console.log('[SIMPLIFIED RAG SETTINGS]', 'Settings loaded for simplified contextual response');

    const messages = await this.indexedDBServices.messageService.getMessagesBySession(sessionId, session.userId);
    console.log('[SIMPLIFIED CHAT HISTORY]', `Found ${messages.length} previous messages`);

    let fullResponse = '';

    // Build context-aware prompt for inference service
    const groqModel = settings?.groqModel || 'gpt-oss-120b';

    // Construct simplified history and context
    const recentMessages = messages.slice(-5).map(m =>
      `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
    ).join('\n');

    const groqPrompt = `
      Context from documents:
      ---
      ${context}
      ---
      
      Conversation History:
      ${recentMessages}
      
      New Question: ${content}
    `;

    try {
      const cappedTemperature = Math.min(settings?.temperature ?? 0.7, 0.2);
      const maxTokens = settings?.maxTokens || 2048;

      await groqService.generateStreamingResponse(
        groqPrompt,
        systemPrompt,
        groqModel,
        {
          temperature: cappedTemperature,
          maxTokens,
          onChunk: (chunk: string) => {
            fullResponse += chunk;
          }
        }
      );

      console.log('[SIMPLIFIED RESPONSE COMPLETE]', `Generated ${fullResponse.length} characters`);

      let responseForCitation = fullResponse.trim();
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
        return;
      }

      let isNoEvidenceResponse = this.isInsufficientEvidenceResponse(responseForCitation);
      let citationResult: SimplifiedCitationGroup = citationService.processSimplifiedCitations(responseForCitation, searchResults);

      // Convert simplified citations to message citation format for storage
      let citationMetadata = citationService.convertSimplifiedToMessageCitations(citationResult.citations);
      let responseForCitationConsistency = citationResult.renumberedResponse;

      // Retry once with stronger citation instructions when output has no verifiable citations.
      if (!isNoEvidenceResponse && citationMetadata.length === 0) {
        console.warn('[CITATION RETRY]', 'Initial response had no verifiable citations. Retrying once with strict citation instructions.');

        let retryResponse = '';
        const retryPrompt = `
Context from documents:
---
${context}
---

Conversation History:
${recentMessages}

New Question: ${content}

IMPORTANT RETRY RULES:
- Regenerate the answer using ONLY the context above.
- Every factual paragraph or bullet MUST end with at least one citation marker like [1] or [2].
- Do NOT use "Citation:" labels. Use inline [n] markers only.
- If a point cannot be supported by context, do not include that point.
- Keep output well formatted with short headings and bullets.
`.trim();

        await groqService.generateStreamingResponse(
          retryPrompt,
          systemPrompt,
          groqModel,
          {
            temperature: 0.1,
            maxTokens,
            onChunk: (chunk: string) => {
              retryResponse += chunk;
            }
          }
        );

        console.log('[CITATION RETRY COMPLETE]', `Generated ${retryResponse.length} characters`);

        if (retryResponse.trim()) {
          responseForCitation = retryResponse.trim();
          const retryRateLimitNotice = this.extractRateLimitNotice(responseForCitation);
          if (retryRateLimitNotice) {
            console.warn('[RATE LIMIT SURFACE]', 'Retry hit rate limit. Returning rate-limit notice directly.');

            const assistantMessage: MessageCreate = {
              sessionId,
              content: retryRateLimitNotice,
              role: MessageSender.ASSISTANT,
            };
            await this.indexedDBServices.messageService.createMessage(assistantMessage);

            if (onStreamEvent) {
              onStreamEvent({
                type: 'done',
                content: retryRateLimitNotice,
                citations: undefined
              });
            }

            console.log('=== SIMPLIFIED CONTEXTUAL RESPONSE MODE END ===\n');
            return;
          }

          isNoEvidenceResponse = this.isInsufficientEvidenceResponse(responseForCitation);
          citationResult = citationService.processSimplifiedCitations(responseForCitation, searchResults);
          citationMetadata = citationService.convertSimplifiedToMessageCitations(citationResult.citations);
          responseForCitationConsistency = citationResult.renumberedResponse;
        }
      }

      // If model explicitly says evidence is insufficient, do not attach normal source cards.
      if (isNoEvidenceResponse) {
        citationMetadata = [];
      }

      // Strict grounding gate:
      // remove substantial lines that have no inline citations and fail closed if no verifiable citations remain.
      if (!isNoEvidenceResponse) {
        const groundingPass = this.removeUncitedSubstantiveLines(responseForCitationConsistency);
        responseForCitationConsistency = groundingPass.content;
        if (groundingPass.dropped > 0) {
          console.warn(
            '[GROUNDING FILTER]',
            `Removed ${groundingPass.dropped} uncited substantive line(s).`
          );
        }
      }

      if (!isNoEvidenceResponse && (citationMetadata.length === 0 || !this.hasInlineCitations(responseForCitationConsistency))) {
        console.warn('[STRICT CITATION MODE]', 'No explicit verifiable citations found after validation. Returning grounded insufficiency response.');
        responseForCitationConsistency = 'I cannot provide a fully grounded answer from the provided documents because explicit, verifiable citations were not found.';
        citationMetadata = [];
      }

      // Final hard guard: ensure text citation markers and reference panel are always in sync.
      const consistentCitationOutput = this.enforceCitationConsistency(
        responseForCitationConsistency,
        citationMetadata
      );
      const responseWithQueryHeader = this.prependAnsweredQueryHeader(
        consistentCitationOutput.content,
        content
      );

      // Save assistant message with formatted response
      const assistantMessage: MessageCreate = {
        sessionId,
        content: responseWithQueryHeader,
        role: MessageSender.ASSISTANT,
        citations: consistentCitationOutput.citations,
      };

      await this.indexedDBServices.messageService.createMessage(assistantMessage);

      if (onStreamEvent) {
        onStreamEvent({
          type: 'done',
          content: responseWithQueryHeader,
          citations: consistentCitationOutput.citations
        });
      }
    } catch (error) {
      console.error('[SIMPLIFIED RAG MODE ERROR]', 'Inference provider error:', error);
      if (onStreamEvent) {
        onStreamEvent({
          type: 'error',
          message: error instanceof Error ? error.message : 'Failed to generate response via inference provider'
        });
      }
    }

    console.log('=== SIMPLIFIED CONTEXTUAL RESPONSE MODE END ===\n');
  }

  /**
   * Get simplified system prompt for page-based citation system
   */
  private getSimplifiedSystemPrompt(searchResults?: any[]): string {
    const availableSources = searchResults?.length || 0;

    return `You are a medical RAG assistant.

You MUST follow these rules:
1) Use ONLY the provided context sources. No external knowledge.
2) If context is insufficient, say: "I cannot answer this question based on the provided documents."
3) Every factual paragraph or bullet MUST end with inline citations like [1], [2].
4) Use only citation numbers from 1 to ${availableSources}.
5) Do not invent citation numbers.
6) Do not use "Citation:" labels; use inline [n] markers only.
7) If a statement cannot be cited, do not include it.
8) Conversation continuity rule: if the new question is a short follow-up that is clearly related to the previous user question, continue with the same medical topic/condition unless the user explicitly changes topic.

Output format requirements:
- Never use markdown tables.
- Use section headers plus bullet points only.
- Do not use long plain paragraphs.
- Keep each section focused and scannable.

Coverage requirements:
- Do NOT summarize when the source contains detailed points.
- Reorganize and present the provided information; do not compress it into a short summary.
- Include all relevant classifications, subtypes, criteria, and key notes that appear in the retrieved context.
- Do not omit important source points for brevity.
- If the question asks for "types", "classification", "features", "management", or "investigations", include the full set of relevant points from context.
- Prefer completeness over brevity while staying strictly grounded to cited text.

Medical shorthand:
- rx/tx => treatment or management
- dx => diagnosis
- inv => investigations
- "clinical features" => history + examination (not investigations)

Goal: accurate, full-detail, source-grounded answer with correct citations.`;
  }

  /**
   * Build context string from search results following Flutter app's approach
   * Enhanced with clearer source labeling and content previews
   * IMPROVED: Better page number detection and clearer source identification
   */
  private buildContext(searchResults: any[]): string {
    if (searchResults.length === 0) {
      return '';
    }

    console.log('\n=== CONTEXT BUILDING DEBUG ===');
    console.log('[BUILDING CONTEXT]', `Processing ${searchResults.length} search results for context`);

    const contextParts: string[] = [];
    contextParts.push('Retrieved Context Sources:\n');

    for (let i = 0; i < searchResults.length; i++) {
      const result = searchResults[i];
      const chunk = result.chunk;
      const document = result.document;

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

      // Create content preview for better source identification
      const contentPreview = this.createContentPreview(chunk.content);
      const similarityScore = result.similarity ? ` (Similarity: ${(result.similarity * 100).toFixed(1)}%)` : '';

      console.log(`[CONTEXT SOURCE ${i + 1}]`, {
        documentTitle: document.title,
        pageInfo: pageInfo.trim(),
        similarity: result.similarity,
        chunkId: chunk.id,
        contentPreview: contentPreview,
        isCombined: chunk.metadata?.isCombined,
        originalChunkCount: chunk.metadata?.originalChunkCount
      });

      contextParts.push(`[${i + 1}] ${document.title}${pageInfo}${similarityScore}`);
      contextParts.push(`Preview: ${contentPreview}`);
      contextParts.push('');
      contextParts.push(`Full Content:`);
      contextParts.push(chunk.content.trim());
      contextParts.push('');
      contextParts.push('---');
      contextParts.push('');
    }

    const finalContext = contextParts.join('\n').trim();
    console.log('[CONTEXT BUILT]', `Final context length: ${finalContext.length} characters`);
    console.log('=== CONTEXT BUILDING DEBUG END ===\n');

    return finalContext;
  }

  /**
   * Create a brief content preview to help identify relevant sources
   */
  private createContentPreview(content: string, maxLength: number = 150): string {
    // Remove extra whitespace but preserve newlines for list formatting
    const cleanedContent = content.trim().replace(/[ \t]+/g, ' ');

    if (cleanedContent.length <= maxLength) {
      return cleanedContent;
    }

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
- "rx" or "Rx" means treatment or prescription
- "Tx" or "tx" means treatment
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
- Provide comprehensive but concise answers
- Handle unit conversions for medical/technical data (e.g., temperatures, weights)
- Maintain a professional but conversational tone
- If multiple documents provide conflicting information, acknowledge the discrepancy
- Do NOT use markdown tables unless the user explicitly asks for a table
- Prefer headings, short paragraphs, and bullet lists for better mobile readability

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
    await this.indexedDBServices.messageService.deleteMessagesBySession(sessionId);
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
