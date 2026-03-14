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
  catalog: DrugCatalog | AskDrugCatalog;
}

export interface DrugQueryParseResult {
  drug_name: string;
  confidence: number;
}

export type AskDrugSectionKey =
  | 'indications_and_dose'
  | 'important_safety_information'
  | 'contra_indications'
  | 'cautions'
  | 'cautions_further_information'
  | 'interactions'
  | 'side_effects'
  | 'pregnancy'
  | 'breast_feeding'
  | 'hepatic_impairment'
  | 'renal_impairment'
  | 'treatment_cessation'
  | 'directions_for_administration'
  | 'prescribing_and_dispensing_information'
  | 'patient_and_carer_advice';

export type AskDrugRequestedSection = AskDrugSectionKey | 'all_details';

export interface AskDrugEntry {
  title: string;
  source_pdf: string;
  pages: number[];
  indications_and_dose?: string | null;
  important_safety_information?: string | null;
  contra_indications?: string | null;
  cautions?: string | null;
  cautions_further_information?: string | null;
  interactions?: string | null;
  side_effects?: string | null;
  pregnancy?: string | null;
  breast_feeding?: string | null;
  hepatic_impairment?: string | null;
  renal_impairment?: string | null;
  treatment_cessation?: string | null;
  directions_for_administration?: string | null;
  prescribing_and_dispensing_information?: string | null;
  patient_and_carer_advice?: string | null;
}

export interface AskDrugCatalog {
  format_version: 'drug-sections-catalog-1.0';
  generated_at: string;
  directory: string;
  pdf_count: number;
  drug_count: number;
  drugs: AskDrugEntry[];
}

export interface AskDrugQueryParseResult {
  drug_name: string;
  sections: AskDrugRequestedSection[];
  indication_terms: string[];
  confidence: number;
}

export interface AskDrugBroadMatch {
  entry: AskDrugEntry;
  matchedSections: Partial<Record<AskDrugSectionKey, string>>;
  score: number;
}

export type SessionChatMode = 'chat' | 'drug' | 'ask-drug';
