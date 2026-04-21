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
  interactions?: string;
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
  requested_indication: string;
  confidence: number;
}

export interface ParsedProprietaryPreparation {
  brand_name: string;
  company_name: string;
  display_name: string;
  details: string;
  parsed_details?: ParsedBrandDetail[];
  is_combination: boolean;
}

export interface ParsedBrandDetail {
  raw_text: string;
  formulation_raw: string;
  formulation: string;
  release_type?: 'SR' | 'XR';
  strength: string;
  price: string;
  price_unit?: string;
  is_modified_release: boolean;
  is_paediatric: boolean;
}

export interface BrandExtractionParseResult {
  drug_names: string[];
}

export interface BrandLookupRequest {
  sourceMode: 'chat' | 'ask-drug';
  answerText: string;
}

export type DrugModeRequestedField =
  | 'indications'
  | 'cautions'
  | 'contraindications'
  | 'side_effects'
  | 'pregnancy'
  | 'breast_feeding'
  | 'hepatic_impairment'
  | 'renal_impairment'
  | 'dose';

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

export interface AskDrugDoseInstruction {
  group: string;
  text: string;
}

export interface AskDrugDoseRoute {
  route: string;
  instructions: AskDrugDoseInstruction[];
}

export interface AskDrugDoseIndication {
  indication: string;
  routes: AskDrugDoseRoute[];
}

export interface AskDrugIndicationsAndDoseStructured {
  indications: AskDrugDoseIndication[];
  notes: string[];
  raw_text: string;
}

export interface AskDrugEntry {
  title: string;
  source_pdf: string;
  pages: number[];
  indications_and_dose?: string | null;
  indications_and_dose_structured?: AskDrugIndicationsAndDoseStructured | null;
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

export interface MedexPackageInfo {
  label?: string | null;
  price_kind?: string | null;
  price_text?: string | null;
  price_bdt?: string | null;
  pack_size_info?: string | null;
}

export interface MedexBrandCard {
  brand_name?: string | null;
  strength?: string | null;
  company?: string | null;
  price_label?: string | null;
  price_bdt?: string | null;
  price_text?: string | null;
  pack_size_info?: string | null;
}

export interface MedexAlternateBrandRow {
  brand_name?: string | null;
  dosage_form?: string | null;
  strength?: string | null;
  company?: string | null;
  brand_url?: string | null;
  price_label?: string | null;
  unit_price_bdt?: string | null;
  pack_size_info?: string | null;
  price_text?: string | null;
}

export interface MedexAlternateBrandGroup {
  company: string;
  dosage_forms: Array<{
    dosage_form: string;
    brands: MedexAlternateBrandRow[];
  }>;
}

export interface MedexAlternateBrands {
  source_url: string;
  page_title?: string | null;
  rows: MedexAlternateBrandRow[];
  grouped_by_company: MedexAlternateBrandGroup[];
}

export interface MedexSummaryBlock {
  display_name?: string | null;
  dosage_form?: string | null;
  generic_name?: string | null;
  manufacturer?: string | null;
  strength?: string | null;
  unit_price_bdt?: string | null;
  strip_price_bdt?: string | null;
  pricing?: {
    unit_price_bdt?: string | null;
    strip_price_bdt?: string | null;
    packages?: MedexPackageInfo[] | null;
  } | null;
  available_as?: string[] | null;
}

export interface MedexResolvedPayload {
  query: string;
  resolved_query: string;
  selected_kind: 'brand' | 'generic';
  search_url: string;
  search_result_count_estimate: number;
  selected_result_title: string;
  selected_result_url: string;
  summary_above_indications: MedexSummaryBlock;
  sections: {
    description?: string | null;
    indications?: string | null;
    pharmacology?: string | null;
    dosage_and_administration?: string | null;
    interaction?: string | null;
    contraindications?: string | null;
    side_effects?: string | null;
    pregnancy_and_lactation?: string | null;
    precautions_and_warnings?: string | null;
    overdose_effects?: string | null;
  };
  available_brand_names: MedexBrandCard[];
  alternate_brands?: MedexAlternateBrands | null;
  logs?: {
    search_fetch_ms?: number;
    brand_fetch_ms?: number;
    total_ms?: number;
    alternate_brands_fetch_ms?: number;
    http_status?: Record<string, number>;
  };
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
