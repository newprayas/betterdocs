import type { VectorSearchResult } from '@/types/embedding';

export type SourceTrustClass = 'textbook' | 'notes' | 'unknown';

export interface TrustScoreBreakdown {
  baseSimilarity: number;
  trustBoost: number;
  structureBoost: number;
  adjustedScore: number;
  sourceTrustClass: SourceTrustClass;
}

export interface RetrievalPostProcessConfig {
  maxResults: number;
  maxPerPageCluster: number;
  maxPerDocument: number;
  nearDuplicateThreshold: number;
  textbookBoost: number;
  structureBoost: number;
}

export interface RetrievalPostProcessTelemetry {
  dedupRemovedCount: number;
  nearDuplicateRemovedCount: number;
  diversityRemovedCount: number;
  sourceMixDistribution: Record<SourceTrustClass, number>;
  trustScoreBreakdown: Record<string, TrustScoreBreakdown>;
}

export interface RetrievalPostProcessResult {
  results: VectorSearchResult[];
  telemetry: RetrievalPostProcessTelemetry;
}

const DEFAULT_CONFIG: RetrievalPostProcessConfig = {
  maxResults: 12,
  maxPerPageCluster: 3,
  maxPerDocument: 7,
  nearDuplicateThreshold: 0.88,
  textbookBoost: 0.02,
  structureBoost: 0.14,
};

const TEXTBOOK_PATTERNS = [
  /\btextbook\b/i,
  /\bchapter\b/i,
  /\bedition\b/i,
  /\bmanual\b/i,
  /\bbailey\b/i,
  /\bharrison\b/i,
  /\brobbins\b/i,
  /\bschwartz\b/i,
  /\bshort practice of surgery\b/i,
];

const NOTES_PATTERNS = [
  /\bnotes?\b/i,
  /\blecture\b/i,
  /\byoutube\b/i,
  /\bhandout\b/i,
  /\bclass\b/i,
  /\bprof\b/i,
  /\bppt\b/i,
  /\bslide\b/i,
];

interface RankedResult {
  result: VectorSearchResult;
  adjustedScore: number;
  sourceTrustClass: SourceTrustClass;
  structureBoost: number;
  normalizedContent: string;
  tokens: Set<string>;
  pageClusterKey: string;
}

export function postProcessRetrievalResults(
  input: VectorSearchResult[],
  partialConfig: Partial<RetrievalPostProcessConfig> = {}
): RetrievalPostProcessResult {
  const config: RetrievalPostProcessConfig = {
    ...DEFAULT_CONFIG,
    ...partialConfig,
  };

  if (input.length === 0) {
    return {
      results: [],
      telemetry: {
        dedupRemovedCount: 0,
        nearDuplicateRemovedCount: 0,
        diversityRemovedCount: 0,
        sourceMixDistribution: { textbook: 0, notes: 0, unknown: 0 },
        trustScoreBreakdown: {},
      },
    };
  }

  const dedupedByExactContent = dedupeByExactContent(input);
  const dedupRemovedCount = Math.max(0, input.length - dedupedByExactContent.length);

  const scored = dedupedByExactContent.map((result) => {
    const sourceTrustClass = classifySourceTrust(result);
    const trustBoost = sourceTrustClass === 'textbook' ? config.textbookBoost : 0;
    const structureBoost = scoreStructuredChunkBoost(result, config.structureBoost);
    const adjustedScore = Math.min(1, result.similarity + trustBoost + structureBoost);
    const normalizedContent = normalizeContent(result.chunk.content || '');
    const tokens = tokenizeForOverlap(normalizedContent);
    const pageClusterKey = buildPageClusterKey(result);

    return {
      result: {
        ...result,
        similarity: adjustedScore,
      },
      adjustedScore,
      sourceTrustClass,
      structureBoost,
      normalizedContent,
      tokens,
      pageClusterKey,
    } satisfies RankedResult;
  });

  scored.sort((a, b) => b.adjustedScore - a.adjustedScore);

  const selected: RankedResult[] = [];
  let nearDuplicateRemovedCount = 0;

  for (const candidate of scored) {
    const duplicate = selected.some((picked) => isNearDuplicate(candidate, picked, config.nearDuplicateThreshold));
    if (duplicate) {
      nearDuplicateRemovedCount += 1;
      continue;
    }
    selected.push(candidate);
  }

  const diversified: RankedResult[] = [];
  const pageCounts = new Map<string, number>();
  const docCounts = new Map<string, number>();
  let diversityRemovedCount = 0;

  for (const candidate of selected) {
    const pageCount = pageCounts.get(candidate.pageClusterKey) || 0;
    const docCount = docCounts.get(candidate.result.document.id) || 0;

    if (pageCount >= config.maxPerPageCluster) {
      diversityRemovedCount += 1;
      continue;
    }

    if (docCount >= config.maxPerDocument) {
      diversityRemovedCount += 1;
      continue;
    }

    diversified.push(candidate);
    pageCounts.set(candidate.pageClusterKey, pageCount + 1);
    docCounts.set(candidate.result.document.id, docCount + 1);
  }

  const finalRanked = diversified.slice(0, config.maxResults);

  const sourceMixDistribution: Record<SourceTrustClass, number> = {
    textbook: 0,
    notes: 0,
    unknown: 0,
  };

  const trustScoreBreakdown: Record<string, TrustScoreBreakdown> = {};
  for (const item of finalRanked) {
    sourceMixDistribution[item.sourceTrustClass] += 1;
    trustScoreBreakdown[item.result.chunk.id] = {
      baseSimilarity: Math.max(0, item.adjustedScore - (item.sourceTrustClass === 'textbook' ? config.textbookBoost : 0) - item.structureBoost),
      trustBoost: item.sourceTrustClass === 'textbook' ? config.textbookBoost : 0,
      structureBoost: item.structureBoost,
      adjustedScore: item.adjustedScore,
      sourceTrustClass: item.sourceTrustClass,
    };
  }

  return {
    results: finalRanked.map((item) => item.result),
    telemetry: {
      dedupRemovedCount,
      nearDuplicateRemovedCount,
      diversityRemovedCount,
      sourceMixDistribution,
      trustScoreBreakdown,
    },
  };
}

function dedupeByExactContent(results: VectorSearchResult[]): VectorSearchResult[] {
  const byContent = new Map<string, VectorSearchResult>();
  for (const result of results) {
    const key = normalizeContent(result.chunk.content || '');
    const existing = byContent.get(key);
    if (!existing || result.similarity > existing.similarity) {
      byContent.set(key, result);
    }
  }
  return Array.from(byContent.values());
}

function classifySourceTrust(result: VectorSearchResult): SourceTrustClass {
  const combined = `${result.document.title || ''} ${result.document.fileName || ''} ${result.chunk.source || ''}`.toLowerCase();

  if (TEXTBOOK_PATTERNS.some((pattern) => pattern.test(combined))) {
    return 'textbook';
  }
  if (NOTES_PATTERNS.some((pattern) => pattern.test(combined))) {
    return 'notes';
  }
  return 'unknown';
}

function scoreStructuredChunkBoost(result: VectorSearchResult, maxBoost: number): number {
  const combined = normalizeContent(
    `${result.document.title || ''}\n${result.chunk.source || ''}\n${result.chunk.content || ''}`
  );

  if (!combined) return 0;

  const hasTableLikeStructure =
    /\btable\b/.test(combined) ||
    /\bfigure\b/.test(combined) ||
    /\bfig\b/.test(combined) ||
    /\bsummary box\b/.test(combined) ||
    /\bbox\b/.test(combined) ||
    /\bcaption\b/.test(combined) ||
    /\bcriteria list\b/.test(combined) ||
    /\bcriteria\b/.test(combined);

  if (!hasTableLikeStructure) return 0;

  let boost = maxBoost * 0.75;

  const hasThresholdSignals =
    /\bthreshold\b/.test(combined) ||
    /\bindications?\b/.test(combined) ||
    /\blevels?\b/.test(combined) ||
    /\bhb\b/.test(combined) ||
    /\bhaemoglobin\b/.test(combined) ||
    /\bhemoglobin\b/.test(combined) ||
    /\bg dl\b/.test(combined) ||
    /\bg l\b/.test(combined) ||
    /\b\d+\s*(?:to|-|–)\s*\d+\b/.test(combined) ||
    /\b[<>]=?\s*\d+\b/.test(combined);

  if (hasThresholdSignals) {
    boost += maxBoost * 0.5;
  }

  const hasDenseNumericContent =
    (combined.match(/\b\d+(?:\.\d+)?\b/g) || []).length >= 3 ||
    /\bpercent\b/.test(combined) ||
    /\bmg\b/.test(combined);

  if (hasDenseNumericContent) {
    boost += maxBoost * 0.2;
  }

  return Math.min(maxBoost, boost);
}

function normalizeContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeForOverlap(normalizedContent: string): Set<string> {
  const tokens = normalizedContent
    .split(/\s+/)
    .filter((token) => token.length > 2);
  return new Set(tokens);
}

function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function buildPageClusterKey(result: VectorSearchResult): string {
  const page =
    result.chunk.metadata?.pageNumbers?.[0] ??
    result.chunk.page ??
    result.chunk.metadata?.pageNumber ??
    'unknown';
  return `${result.document.id}:${page}`;
}

function isNearDuplicate(a: RankedResult, b: RankedResult, threshold: number): boolean {
  const sameDoc = a.result.document.id === b.result.document.id;
  const samePageCluster = a.pageClusterKey === b.pageClusterKey;
  const overlap = jaccardOverlap(a.tokens, b.tokens);
  if (sameDoc && samePageCluster && overlap >= 0.5) return true;
  return overlap >= threshold;
}
