export type RetrievalMode = 'legacy_hybrid' | 'ann_rerank_v1';

export type AnnIndexState = 'ready' | 'missing' | 'corrupt';

export interface AnnIndexParams {
  m: number;
  efConstruction: number;
  efSearch: number;
}

export interface AnnIndexRecord {
  id: string;
  documentId: string;
  algorithm: 'hnsw';
  embeddingDimensions: number;
  distance: 'cosine';
  version: string;
  params: AnnIndexParams;
  graphData: ArrayBuffer;
  idMap: string[];
  artifactName?: string;
  artifactChecksum?: string;
  artifactSize?: number;
  idMapName?: string;
  idMapChecksum?: string;
  idMapSize?: number;
  state: AnnIndexState;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RuntimeSearchTelemetry {
  retrievalMode: RetrievalMode;
  vectorLatencyMs: number;
  textRerankLatencyMs?: number;
  annCandidates?: number;
  rerankCandidates?: number;
  fallbackReason?: string;
}

