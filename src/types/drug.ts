export interface DrugEntry {
  id: string;
  drug_name: string;
  aliases: string[];
  pages: number[];
  indications?: string;
  cautions?: string;
  contraindications?: string;
  side_effects?: string;
  dose?: string;
  notes?: string;
  proprietary_preparations?: string;
  raw_text: string;
  search_text: string;
}

export interface DrugCatalog {
  format_version: 'drug-catalog-1.0';
  source_metadata: {
    document_id: string;
    filename: string;
    page_count: number;
    generated_at: string;
    source_system: string;
  };
  entries: DrugEntry[];
}

export interface DrugDatasetConfig {
  id: string;
  name: string;
  filename: string;
  size: string;
}

export interface DrugDatasetRecord {
  id: string;
  name: string;
  filename: string;
  size: string;
  downloadedAt: string;
  catalog: DrugCatalog;
}

export interface DrugQueryParseResult {
  drug_name: string;
  confidence: number;
}
