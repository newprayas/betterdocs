import { groqService } from '@/services/groq/groqService';
import { getIndexedDBServices } from '@/services/indexedDB';
import { libraryService } from '@/services/libraryService';
import type {
  DrugCatalog,
  DrugDatasetConfig,
  DrugDatasetRecord,
  DrugEntry,
  DrugModeRequestedField,
  DrugQueryParseResult,
  MessageCreate,
  ParsedProprietaryPreparation,
} from '@/types';
import { MessageSender } from '@/types/message';
import type { ChatStreamEvent } from '@/services/rag';

const DRUG_QUERY_PARSER_MODEL = 'llama-3.3-70b-versatile';
const DRUG_ANSWER_MODEL = 'moonshotai/kimi-k2-instruct-0905';
const DRUG_PROMPT_LOG_CHUNK_SIZE = 4000;
const DRUG_NAME_DENYLIST = new Set(['ACE', 'FDA', 'KN.VDN', 'CNS']);
const VERIFIED_DRUG_NAMES_URL = '/drug/verified-drug-names.txt';
const DRUG_SUGGESTION_LIMIT = 8;
const PREFERRED_MAX_PAGE_COUNT = 4;
const DRUG_BRAND_RESULT_LIMIT = 5;
const PREFERRED_BRAND_COMPANIES = [
  'square',
  'incepta',
  'healthcare',
  'opsonin',
  'beximco',
  'aristopharma',
  'novartis',
  'acme',
  'ziska',
  'renata',
  'radiant',
];

export const DRUG_DATASET_CONFIG: DrugDatasetConfig = {
  id: 'newdoc_voyage_9e7',
  name: 'BD prescription',
  filename: 'shard_9e7.bin',
  size: '2.9 MB',
};

const canonicalizeDrugQueryCase = (value: string): string =>
  value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      if (part.toUpperCase() === part) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(' ');

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeDrugLookupText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();

const stripDrugNameQualifiers = (value: string): string =>
  value
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]+\)$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeDrugIdentity = (value: string): string =>
  normalizeDrugLookupText(stripDrugNameQualifiers(value));

const isPlausibleDrugName = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^\d+$/.test(trimmed)) return false;
  return /[A-Za-z]/.test(trimmed);
};

const hasMinimumSuggestionLength = (value: string): boolean =>
  normalizeDrugLookupText(value).length > 2;

const levenshteinDistance = (left: string, right: string): number => {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;

    for (let col = 1; col <= right.length; col += 1) {
      const temp = previous[col];
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      previous[col] = Math.min(
        previous[col] + 1,
        previous[col - 1] + 1,
        diagonal + cost,
      );
      diagonal = temp;
    }
  }

  return previous[right.length];
};

const hasExactPhraseMatch = (text: string, query: string): boolean => {
  const trimmedQuery = query.trim();
  if (!text || !trimmedQuery) return false;

  const pattern = new RegExp(
    `(^|[^A-Za-z0-9])${escapeRegExp(trimmedQuery)}(?=\\s*\\(|[^A-Za-z0-9]|$)`,
  );
  return pattern.test(text);
};

const extractJsonObject = <T>(raw: string): T => {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || trimmed;

  try {
    return JSON.parse(candidate) as T;
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as T;
    }
    throw new Error('Groq parser did not return valid JSON');
  }
};

const compactField = (value?: string): string | undefined => {
  if (!value) return undefined;
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact || undefined;
};

const uniqueStrings = (values: Array<string | undefined | null>): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const compact = compactField(value || undefined);
    if (!compact) continue;
    const normalized = compact.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(compact);
  }

  return result;
};

const cleanDrugDisplayName = (value: string): string =>
  canonicalizeDrugQueryCase(value.replace(/\[[^\]]*]/g, ' ').replace(/\s+/g, ' ').trim());

const dedupeDrugEntries = (entries: DrugEntry[]): DrugEntry[] => {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
};

const uniquePages = (entries: DrugEntry[]): number[] =>
  Array.from(new Set(entries.flatMap((entry) => entry.pages))).sort((left, right) => left - right);

const dedupeParsedBrands = (
  brands: ParsedProprietaryPreparation[],
): ParsedProprietaryPreparation[] => {
  const seen = new Set<string>();
  return brands.filter((brand) => {
    const key = `${normalizeDrugLookupText(brand.display_name)}|${normalizeDrugLookupText(brand.details)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

type DrugModeAnswerKind = 'sectional' | 'dose_with_brands';

interface DrugModeIntent {
  requestedFields: DrugModeRequestedField[];
  answerKind: DrugModeAnswerKind;
  needsBrands: boolean;
}

interface DrugSearchCandidates {
  strictMatches: DrugEntry[];
  preferredStrictMatches: DrugEntry[];
  normalizedMatches: DrugEntry[];
  preferredNormalizedMatches: DrugEntry[];
  fuzzyTitleMatches: DrugEntry[];
  preferredFuzzyTitleMatches: DrugEntry[];
  proprietaryStrictMatches: DrugEntry[];
  proprietaryNormalizedMatches: DrugEntry[];
}

const stringifyEntryForPrompt = (entry: Record<string, unknown>): string =>
  JSON.stringify(entry, null, 2);

const logFullPromptText = (label: string, text: string): void => {
  const chunkCount = Math.max(1, Math.ceil(text.length / DRUG_PROMPT_LOG_CHUNK_SIZE));
  console.log(`${label}[META]`, {
    length: text.length,
    chunkSize: DRUG_PROMPT_LOG_CHUNK_SIZE,
    chunkCount,
  });

  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * DRUG_PROMPT_LOG_CHUNK_SIZE;
    const end = start + DRUG_PROMPT_LOG_CHUNK_SIZE;
    console.log(
      `${label}[CHUNK ${index + 1}/${chunkCount}]`,
      text.slice(start, end),
    );
  }
};

const formatDrugDoseOutput = (raw: string): string =>
  raw
    // Blank line before formulation headings and brand blocks
    .replace(/([^\n])\s*(?=\*\*✅)/g, '$1\n\n')
    .replace(/([^\n])\s*(?=🎉)/g, '$1\n\n')
    // Markdown line break (two spaces + newline) for items within a brand block
    .replace(/([^\n])\s*(?=🎯)/g, '$1\n\n')
    .replace(/([^\n])\s*(?=\*\*(?:Adult|Child)[^*]*\*\*[:\s])/g, '$1  \n')
    .replace(/([^\n])\s*(?=Price:)/g, '$1  \n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

// ─── PASS 1: Extraction-only prompt (no dose math) ───────────────────────────
const DRUG_EXTRACTION_SYSTEM_PROMPT_TEMPLATE = `You are a drug-data extraction assistant.
For the DRUG: {{DRUG_NAME}}, extract all brand names with their exact verbatim indications and dose text from the clinical context.

[ie; all brands of the generic drug in the context]
[the app has already filtered and prioritized these brand names when available: Square, Incepta, Healthcare, Opsonin, Beximco, Aristopharma]
[Use ONLY the filtered proprietary brand entries provided in context. Do not invent extra brands.]
[Use ONLY the provided clinical_context as the source for indications and dose text. Do not mix it with any other source.]
[If clinical_context_source is ask_drug_indications_and_dose, use only clinical_context.indications_and_dose.]
[If clinical_context_source is drug_mode_fallback, use only clinical_context.indications and clinical_context.dose.]
[Never combine the ask-drug clinical context and the drug-mode clinical context together.]
[If the context contains multiple matched entries for the same generic drug, use all of them together and combine carefully.]
[If two matched entries differ, keep the difference clear instead of deleting one.]
[When using ask-drug clinical context, prefer broad/common indication labels, merge obvious duplicates, but do not aggressively remove distinct uncommon indications.]
[Keep distinct indication labels when they represent a different clinical use-case. Keep Acute migraine, Acute gout, Postoperative pain, Ureteric colic, Actinic keratosis etc. as separate indications.]
[Only merge indications when they are truly the same or near-identical.]
[Do not omit distinct route-specific or formulation-specific indications. Keep oral, rectal, injection, infusion, topical uses separate when the clinical_context separates them.]
[Include all distinct clinically supported indications that map to the available brand formulations.]
[If a formulation exists in filtered_proprietary_preparations, include it. Do not skip sachet, suspension, syrup, drops, suppository, topical, injection, infusion, or capsule forms.]
[Use only clearly stated brand strengths from filtered_proprietary_preparations with explicit units (mg, g, mcg, ml, %).]
[Do not invent a separate brand strength from a suspicious trailing numeric fragment.]
[If a brand detail looks malformed or ambiguous, ignore that malformed strength.]
[Do not add administration timing or advice such as "after food", "after meals" unless that exact detail is present in the chosen clinical_context.]

IMPORTANT RULES:
- Do NOT convert doses into tablet/capsule/vial counts. Just copy the exact dose text verbatim from clinical_context.
- Do NOT calculate any dosing schedule. That is done in a separate step.
- DO list each unique indication with its exact verbatim dose text (Adult, Child, etc.) from the clinical context.
- DO include the price for each brand.
- DO avoid duplication ONLY when two brands have the EXACT SAME mg strength (e.g. two different 50 mg brands). In that case list the dose under the first brand and just show price for the later one.
- If two brands have DIFFERENT mg strengths (e.g. 50 mg and 100 mg), you MUST repeat the full verbatim dose text for EACH strength, even if the source clinical_context uses the same dose description. This is critical because a separate step will calculate different unit counts for different strengths.

Formatting:

**{{DRUG_NAME}}** - Generic : resolved generic name

**✅ TABLET**

🎉 **Tab. Pantonix 20 mg - Incepta**
Price: 20 tk/tab
🎯 Helicobacter pylori eradication [in combination with other drugs]
**Adult:** 40 mg twice daily for 7 days for first- and second-line eradication therapy; 10 days for third-line eradication therapy
**Child:** Not recommended
🎯 Benign gastric ulcer
**Adult:** 40 mg daily for 8 weeks; increased if necessary up to 80 mg daily, dose increased in severe cases
**Child:** ...

🎉 **Tab. Esonix 20 mg - Square** [same strength dosing already listed above]
Price: 33 tk/tab

**✅ INJECTION**

🎉 **Inj. Pantonix 40 mg - Incepta**
Price: 120 tk/vial
🎯 indication...
**Adult:** exact verbatim dose text...

And so on for every formulation and brand.`;

// ─── PASS 2: Dose-conversion-only prompt ─────────────────────────────────────
const DRUG_DOSE_CONVERSION_SYSTEM_PROMPT = `You are a dosing-schedule calculator.
You will receive an extracted drug data sheet with brand names, indications, and VERBATIM dose text.
Your ONLY job is to convert each verbatim dose into a practical dosing schedule based on the brand's actual listed strength.

Dose-conversion workflow for EVERY indication + formulation strength:
1. Identify the exact required mg dose and frequency from the verbatim dose text for that indication.
2. Identify the actual listed strength of the brand formulation (from the brand line, e.g. "Tab. Pantonix 20 mg").
3. Convert the mg dose into the correct number of units for that exact strength.

[Never reverse this workflow. Do not start from the brand strength and guess the clinical dose.]
[Map indication first, then mg dose, then unit count + explicit unit.]
[Strength-conversion rule: always calculate from the required total dose and the actual strength.]
[If source says 40 mg daily: 40 mg tablet = 1 tablet + 0 + 0, 20 mg tablet = 1 tablet + 0 + 1 tablet, 10 mg tablet = 2 tablets + 0 + 2 tablets.]
[CRITICAL: ALWAYS append the unit type (tablet, capsule, amp, vial, suppository) to ALL numbers. Never say just "1" or "2" - say "1 tablet", "2 capsules", "1 amp", etc.]
[Do not copy a 40 mg once-daily instruction directly onto a 20 mg tablet as 1 tablet + 0 + 0. The unit count must match the listed strength.]
[Apply this to all formulations: tablets, capsules, dispersible tablets, suppositories, injections, infusions, syrups, suspensions, drops.]
[Per-indication mapping: keep different mg totals separate. Do not merge 20 mg daily, 40 mg daily, 40 mg twice daily, etc.]
[Do not write shortcuts like "all above indications (same daily mg totals)" unless truly identical.]
[If one brand strength covers several indications with different mg totals, list them separately.]
[Before outputting, sanity-check that units per dose × doses per day match the source mg requirement.]
[If the source gives a dose range, preserve it in unit form: e.g. 50-100 mg every 4-6 hours with 100 mg tablet → 1/2 or 1 tablet every 4-6 hours.]
[Use range-based wording when it better matches the source: 1/2 or 1 tablet, 1-2 tablets, etc.]
[Rectal divided-dose rule: if source says divided doses, split using 1 + 0 + 1 or 1 + 1 + 1 style.]
[Practical prescribing: do not generate impractical schedules with excessive unit counts. Prefer practical strengths.]
[Injection/vial rule: if required dose < vial strength, use vial fractions (e.g. 1/2 vial) not full vial.]
[Do not add administration timing or advice ("after food", "after meals") unless it was present in the input.]
[For the same formulation and same strength, show dosing for the first brand only. For later brands of same strength, just reference that dosing is already covered + show price.]

CRITICAL FORMATTING RULES — you MUST follow these exactly:
- Every brand name line MUST start with 🎉 and be wrapped in bold markers, e.g. 🎉 **Tab. Pantonix 20 mg - Incepta**, 🎉 **Inj. Pantonix 40 mg - Incepta**.
- Every brand name line MUST be on its own line.
- Every 🎯 indication line MUST start on a NEW line.
- Age group labels MUST be bolded and include the colon, e.g. **Adult:**, **Child 12-17 years:**, **Infant:**.
- Every bolded age group line MUST start on a NEW line.
- Every "Price:" line MUST start on a NEW line.
- There MUST be a blank line between each brand block.
- There MUST be a blank line before and after each formulation heading (**✅ TABLET**, etc.).
- NEVER run multiple items together on one line or in a paragraph. Each element gets its own line.
- Use newline characters to separate every distinct piece of information.

Output format — convert the input into EXACTLY this style (note: each line below is a SEPARATE line in the output):

**{{DRUG_NAME}}** - Generic : resolved generic name
Brands and dose

[Always format the main title exactly like this: **{{DRUG_NAME}}** - Generic : resolved generic name]
[Only the drug name itself should be bold. The text after it should remain normal.]
[Formulation headings must be bold and uppercase with a leading check mark emoji: **✅ TABLET**, **✅ INJECTION**, **✅ SUPPOSITORY**]

**✅ TABLET**

🎉 **Tab. Pantonix 20 mg - Incepta**
Price: 20 tk/tab
🎯 Helicobacter pylori eradication
**Adult:** 1 tablet + 0 + 1 tablet — for 7 days for first-line eradication therapy; 10 days for third-line
🎯 Benign gastric ulcer
**Adult:** 1 tablet + 0 + 1 tablet — for 8 weeks; increased if necessary up to 2 tablets + 0 + 2 tablets daily

🎉 **Tab. Esonix 20 mg - Square** [same strength dosing already covered above]
Price: 33 tk/tab

**✅ INJECTION** (be mindful of IV or IM or SC)

🎉 **Inj. Pantonix 40 mg - Incepta**
Price: 120 tk/vial
🎯 indication
**Adult:** 1 vial IV 12 hourly — for gastric ulcer

[ALL answers should be neatly formatted with clear line breaks between every element]`;

const DRUG_MODE_SECTION_SYSTEM_PROMPT = `You answer drug questions using ONLY the provided structured drug context.

Rules:
- Use only the fields provided in the context.
- Answer only the requested section(s).
- Do not add brand names, prices, or dosing unless those fields are explicitly provided in the context.
- Do not use outside knowledge.
- If a requested field is missing or empty, say "Not found in provided drug dataset."
- If multiple matched entries are provided for the same drug, use all of them and combine them carefully.
- If matched entries disagree or cover different use-cases, keep that distinction clear in the answer.
- Keep the answer clean and direct.

Formatting:
- Use the matched generic drug name as the main heading.
- Use a section heading for each requested section.
- Use bullet points or short paragraphs under each section.
- If only indications are requested, return only the indications section.
- If indications and side-effects are requested, return both, separately.
`;

export interface DrugBrandLookupResult {
  query: string;
  resolved_generic_name: string;
  filtered_proprietary_preparations: ParsedProprietaryPreparation[];
  indications?: string;
  dose?: string;
  notes?: string;
}

export class DrugModeService {
  private indexedDBServices = getIndexedDBServices();
  private verifiedDrugNamesPromise: Promise<string[]> | null = null;

  private validateCatalog(data: unknown): DrugCatalog {
    if (!data || typeof data !== 'object') {
      throw new Error('Drug dataset is missing or invalid');
    }

    const catalog = data as Partial<DrugCatalog>;
    if (catalog.format_version !== 'drug-catalog-1.0') {
      throw new Error('Unsupported drug dataset format');
    }
    if (!Array.isArray(catalog.entries)) {
      throw new Error('Drug dataset entries are missing');
    }
    return catalog as DrugCatalog;
  }

  private makeRecord(catalog: DrugCatalog): DrugDatasetRecord {
    return {
      id: DRUG_DATASET_CONFIG.id,
      name: DRUG_DATASET_CONFIG.name,
      filename: DRUG_DATASET_CONFIG.filename,
      size: DRUG_DATASET_CONFIG.size,
      downloadedAt: new Date().toISOString(),
      catalog,
    };
  }

  async ensureDatasetReady(forceRefresh = false): Promise<DrugCatalog> {
    console.log('[DRUG DOWNLOAD]', 'Checking cached drug dataset', {
      datasetId: DRUG_DATASET_CONFIG.id,
      filename: DRUG_DATASET_CONFIG.filename,
      forceRefresh,
    });

    if (!forceRefresh) {
      const cached = await this.indexedDBServices.drugDatasetService.getDataset(
        DRUG_DATASET_CONFIG.id,
      );
      if (cached?.catalog) {
        const catalog = this.validateCatalog(cached.catalog);
        console.log('[DRUG DOWNLOAD]', 'Cache hit', {
          datasetId: cached.id,
          downloadedAt: cached.downloadedAt,
          entryCount: catalog.entries.length,
        });
        return catalog;
      }
    }

    console.log('[DRUG DOWNLOAD]', 'Downloading dataset from Hugging Face', {
      datasetId: DRUG_DATASET_CONFIG.id,
      filename: DRUG_DATASET_CONFIG.filename,
    });

    const downloaded = await libraryService.downloadAndParseBook(
      DRUG_DATASET_CONFIG.filename,
    );
    const catalog = this.validateCatalog(downloaded);

    await this.indexedDBServices.drugDatasetService.saveDataset(
      this.makeRecord(catalog),
    );

    console.log('[DRUG DOWNLOAD]', 'Dataset cached successfully', {
      datasetId: DRUG_DATASET_CONFIG.id,
      entryCount: catalog.entries.length,
    });

    return catalog;
  }

  private async loadVerifiedDrugNames(): Promise<string[]> {
    if (!this.verifiedDrugNamesPromise) {
      this.verifiedDrugNamesPromise = fetch(VERIFIED_DRUG_NAMES_URL)
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Failed to load verified drug names: ${response.status}`);
          }

          const text = await response.text();
          return Array.from(
            new Set(
              text
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => isPlausibleDrugName(line))
                .filter((line) => hasMinimumSuggestionLength(line)),
            ),
          );
        })
        .catch((error) => {
          console.warn('[DRUG SUGGESTIONS]', 'Verified drug-name list unavailable', error);
          this.verifiedDrugNamesPromise = Promise.resolve([]);
          return [];
        });
    }

    return this.verifiedDrugNamesPromise;
  }

  private async parseDrugQuery(content: string): Promise<DrugQueryParseResult> {
    const systemPrompt = `Extract only the single drug or brand name from the user's query.
Return ONLY valid JSON with this exact shape:
{
  "drug_name": "Pantonix",
  "confidence": 0.98
}

Rules:
- Return only one drug or brand name.
- Remove all other words from the query.
- Do not correct, normalize, or change the spelling of the drug or brand name.
- Auto-capitalize the final drug_name in standard title case only.
- If no drug or brand name can be identified, return an empty string for drug_name and 0 for confidence.
- Do not include any text outside JSON.`;

    console.log('[DRUG PARSER PROMPT][SYSTEM]', systemPrompt);
    console.log('[DRUG PARSER PROMPT][USER]', content);

    const raw = await groqService.generateResponseWithGroq(
      content,
      systemPrompt,
      DRUG_QUERY_PARSER_MODEL,
      {
        temperature: 0,
        maxTokens: 700,
      },
    );

    console.log('[DRUG PARSER]', 'Raw parser output', raw);

    const parsed = extractJsonObject<DrugQueryParseResult>(raw);
    const safeParsed: DrugQueryParseResult = {
      drug_name: canonicalizeDrugQueryCase(String(parsed.drug_name || '').trim()),
      confidence:
        typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0,
    };

    console.log('[DRUG PARSER]', 'Parsed query JSON', safeParsed);
    return safeParsed;
  }

  private analyzeDrugQueryIntent(content: string): DrugModeIntent {
    const normalized = content.toLowerCase();
    const requestedFields: DrugModeRequestedField[] = [];

    const addField = (field: DrugModeRequestedField): void => {
      if (!requestedFields.includes(field)) {
        requestedFields.push(field);
      }
    };

    if (/\bindications?\b/.test(normalized)) addField('indications');
    if (/\bside[\s-]?effects?\b|\badverse\s+effects?\b|\badverse\s+reactions?\b/.test(normalized)) {
      addField('side_effects');
    }
    if (/\bcautions?\b/.test(normalized)) addField('cautions');
    if (/\bcontra[\s-]?indications?\b/.test(normalized)) addField('contraindications');

    const doseRequested =
      /\b(dose|doses|dosage|dosing|schedule|regimen|strength|how much|how many|brands?|price|prices|cost|costs|tab(?:let)?s?|caps?(?:ule)?s?|syrup|susp(?:ension)?|drops?|supp(?:ository|ositories)?|injection|injectable|inj|infusion|iv|im|sc)\b/.test(
        normalized,
      );

    if (doseRequested) {
      addField('indications');
      addField('dose');
    }

    if (requestedFields.length === 0) {
      return {
        requestedFields: ['indications', 'dose'],
        answerKind: 'dose_with_brands',
        needsBrands: true,
      };
    }

    return {
      requestedFields,
      answerKind: doseRequested ? 'dose_with_brands' : 'sectional',
      needsBrands: doseRequested,
    };
  }

  private getFieldValue(entry: DrugEntry, field: DrugModeRequestedField): string | undefined {
    switch (field) {
      case 'indications':
        return compactField(entry.indications);
      case 'cautions':
        return compactField(entry.cautions);
      case 'contraindications':
        return compactField(entry.contraindications);
      case 'side_effects':
        return compactField(entry.side_effects);
      case 'dose':
        return compactField(entry.dose);
      default:
        return undefined;
    }
  }

  private getFieldLabel(field: DrugModeRequestedField): string {
    switch (field) {
      case 'indications':
        return 'Indications';
      case 'cautions':
        return 'Cautions';
      case 'contraindications':
        return 'Contraindications';
      case 'side_effects':
        return 'Side effects';
      case 'dose':
        return 'Dose';
      default:
        return field;
    }
  }

  private extractBrandCandidate(
    proprietaryText: string,
    companyStartIndex: number,
  ): { brandName: string; brandStart: number } | null {
    const prefixStart = Math.max(0, companyStartIndex - 80);
    const prefix = proprietaryText.slice(prefixStart, companyStartIndex);
    const brandMatch = prefix.match(/([A-Z][A-Za-z][A-Za-z .+'&\/-]{0,50})\s*$/);
    let brandName = brandMatch?.[1]?.replace(/\s+/g, ' ').trim() || '';
    if (!brandName) return null;

    const dosagePrefix = brandName.match(
      /^(?:Tab(?:let)?\.?|Cap(?:sule)?\.?|Inj(?:ection)?\.?|Syrup|Suspn?\.?|Supp\.?|Paed\.?\s*drops?|Paed\.?\s*drop|Drops?)\s+/i,
    );
    let brandStart = prefixStart + (brandMatch?.index || 0);
    if (dosagePrefix) {
      brandName = brandName.slice(dosagePrefix[0].length).trim();
      brandStart += dosagePrefix[0].length;
    }

    if (!/[A-Za-z]{2,}/.test(brandName)) return null;
    return { brandName, brandStart };
  }

  private parseProprietaryPreparations(entry: DrugEntry): ParsedProprietaryPreparation[] {
    const proprietaryText = entry.proprietary_preparations || '';
    if (!proprietaryText.trim()) return [];

    const companyPattern = /\(([A-Za-z][A-Za-z0-9.&'\/ -]{1,60})\)/g;
    const headers: Array<{
      brandName: string;
      companyName: string;
      brandStart: number;
      companyEnd: number;
      contextBefore: string;
    }> = [];

    let match: RegExpExecArray | null;
    while ((match = companyPattern.exec(proprietaryText)) !== null) {
      const companyName = compactField(match[1]);
      if (!companyName) continue;

      const extracted = this.extractBrandCandidate(proprietaryText, match.index);
      if (!extracted) continue;

      headers.push({
        brandName: extracted.brandName,
        companyName,
        brandStart: extracted.brandStart,
        companyEnd: match.index + match[0].length,
        contextBefore: proprietaryText.slice(Math.max(0, extracted.brandStart - 120), extracted.brandStart),
      });
    }

    return headers
      .map((header, index) => {
        const nextBrandStart = headers[index + 1]?.brandStart ?? proprietaryText.length;
        const details = compactField(
          proprietaryText
            .slice(header.companyEnd, nextBrandStart)
            .replace(/^[,;.\s]+/, '')
            .replace(
              /\s+[A-Za-z][A-Za-z0-9 ]+\d+(?:\.\d+)?\s*(?:mg|g|ml|mcg|micrograms?)\s*\+\s*[A-Za-z][A-Za-z0-9 ]+\d+(?:\.\d+)?\s*(?:mg|g|ml|mcg|micrograms?)\s*$/i,
              '',
            )
            .replace(/[;,\s]+$/, ''),
        );

        if (!details) return null;

        const isCombination =
          /\+\s*[A-Za-z]/.test(header.contextBefore) ||
          /\b\d+(?:\.\d+)?\s*(?:mg|g|ml|mcg|micrograms?)\b[^.]{0,40}\+\s*[A-Za-z]/i.test(
            header.contextBefore,
          );

        return {
          brand_name: header.brandName,
          company_name: header.companyName,
          display_name: `${header.brandName} (${header.companyName})`,
          details,
          is_combination: isCombination,
        } satisfies ParsedProprietaryPreparation;
      })
      .filter((value): value is ParsedProprietaryPreparation => Boolean(value));
  }

  private findRequestedBrandMatch(
    brands: ParsedProprietaryPreparation[],
    requestedBrandQuery?: string,
  ): ParsedProprietaryPreparation | null {
    const normalizedQuery = normalizeDrugLookupText(requestedBrandQuery || '');
    if (!normalizedQuery) return null;

    return (
      brands.find((brand) => normalizeDrugLookupText(brand.brand_name) === normalizedQuery) ??
      brands.find((brand) => normalizeDrugLookupText(brand.display_name) === normalizedQuery) ??
      null
    );
  }

  private selectPreferredBrandEntries(
    entry: DrugEntry,
    requestedBrandQuery?: string,
  ): ParsedProprietaryPreparation[] {
    const parsedBrands = this.parseProprietaryPreparations(entry);
    if (parsedBrands.length === 0) return [];

    const nonCombination = parsedBrands.filter((brand) => !brand.is_combination);
    const pool = nonCombination.length > 0 ? nonCombination : parsedBrands;
    const preferred = pool.filter((brand) =>
      PREFERRED_BRAND_COMPANIES.includes(normalizeDrugLookupText(brand.company_name)),
    );
    const others = pool.filter(
      (brand) => !PREFERRED_BRAND_COMPANIES.includes(normalizeDrugLookupText(brand.company_name)),
    );
    const selected = [...preferred, ...others].slice(0, DRUG_BRAND_RESULT_LIMIT);
    const requestedBrand =
      this.findRequestedBrandMatch(pool, requestedBrandQuery) ??
      this.findRequestedBrandMatch(parsedBrands, requestedBrandQuery);

    if (!requestedBrand) {
      return selected;
    }

    const alreadyIncluded = selected.some(
      (brand) =>
        normalizeDrugLookupText(brand.display_name) === normalizeDrugLookupText(requestedBrand.display_name),
    );

    return alreadyIncluded ? selected : [...selected, requestedBrand];
  }

  private buildSectionPromptContexts(entries: DrugEntry[], intent: DrugModeIntent): Record<string, unknown> {
    const safeEntries = dedupeDrugEntries(entries);
    const primaryEntry = safeEntries[0];
    const requestedSections = intent.requestedFields.map((field) => this.getFieldLabel(field));

    if (!primaryEntry) {
      return {
        generic_name: '',
        aliases: [],
        pages: [],
        requested_sections: requestedSections,
        matched_entries: [],
      };
    }

    if (safeEntries.length === 1) {
      const sections = Object.fromEntries(
        intent.requestedFields.map((field) => [
          field,
          this.getFieldValue(primaryEntry, field) ?? 'Not found in provided drug dataset.',
        ]),
      );

      return {
        generic_name: cleanDrugDisplayName(primaryEntry.drug_name),
        aliases: uniqueStrings(primaryEntry.aliases),
        pages: primaryEntry.pages,
        requested_sections: requestedSections,
        sections,
      };
    }

    return {
      generic_name: cleanDrugDisplayName(primaryEntry.drug_name),
      aliases: uniqueStrings(safeEntries.flatMap((entry) => entry.aliases)),
      pages: uniquePages(safeEntries),
      requested_sections: requestedSections,
      matched_entry_count: safeEntries.length,
      matched_entries: safeEntries.map((entry, index) => ({
        entry_label: `Entry ${index + 1}`,
        pages: entry.pages,
        aliases: uniqueStrings(entry.aliases),
        sections: Object.fromEntries(
          intent.requestedFields.map((field) => [
            field,
            this.getFieldValue(entry, field) ?? 'Not found in provided drug dataset.',
          ]),
        ),
      })),
    };
  }

  private buildSectionPromptContext(entry: DrugEntry, intent: DrugModeIntent): Record<string, unknown> {
    return this.buildSectionPromptContexts([entry], intent);
  }

  private async buildPreferredClinicalDoseContext(
    entries: DrugEntry[],
  ): Promise<Record<string, unknown>> {
    const safeEntries = dedupeDrugEntries(entries);
    const primaryEntry = safeEntries[0];

    if (!primaryEntry) {
      return {
        clinical_context_source: 'drug_mode_fallback',
        clinical_context: {},
      };
    }

    const resolvedGenericName = this.getResolvedGenericName(primaryEntry);

    try {
      const { askDrugModeService } = await import('./askDrugModeService');
      const askDrugContext = await askDrugModeService.lookupIndicationsAndDoseByDrugName(
        resolvedGenericName,
      );

      if (askDrugContext) {
        console.log('[DRUG ASK-DRUG CONTEXT]', 'Using ask-drug indications_and_dose context', {
          resolvedGenericName,
          matchedAskDrugTitle: askDrugContext.title,
          askDrugPages: askDrugContext.pages,
        });

        return {
          clinical_context_source: 'ask_drug_indications_and_dose',
          clinical_context: {
            title: askDrugContext.title,
            pages: askDrugContext.pages,
            indications_and_dose: compactField(askDrugContext.indications_and_dose),
          },
        };
      }

      console.log('[DRUG ASK-DRUG CONTEXT]', 'No ask-drug indications_and_dose context found, falling back to drug-mode fields', {
        resolvedGenericName,
      });
    } catch (error) {
      console.warn('[DRUG ASK-DRUG CONTEXT]', 'Ask-drug context lookup failed, falling back to drug-mode fields', {
        resolvedGenericName,
        error,
      });
    }

    return {
      clinical_context_source: 'drug_mode_fallback',
      clinical_context: {
        pages: uniquePages(safeEntries),
        indications: uniqueStrings(safeEntries.map((entry) => compactField(entry.indications))).join(' | ') || undefined,
        dose: uniqueStrings(safeEntries.map((entry) => compactField(entry.dose))).join(' | ') || undefined,
      },
    };
  }

  private async buildDosePromptContexts(
    entries: DrugEntry[],
    requestedBrandQuery?: string,
  ): Promise<Record<string, unknown>> {
    const safeEntries = dedupeDrugEntries(entries);
    const primaryEntry = safeEntries[0];
    const filteredBrands = dedupeParsedBrands(
      safeEntries.flatMap((entry) => this.selectPreferredBrandEntries(entry, requestedBrandQuery)),
    );
    const preferredClinicalContext = await this.buildPreferredClinicalDoseContext(safeEntries);

    if (!primaryEntry) {
      return {
        generic_name: '',
        aliases: [],
        pages: [],
        filtered_proprietary_preparations: [],
        ...preferredClinicalContext,
        matched_entries: [],
      };
    }

    if (safeEntries.length === 1) {
      return {
        generic_name: cleanDrugDisplayName(primaryEntry.drug_name),
        aliases: uniqueStrings(primaryEntry.aliases),
        pages: primaryEntry.pages,
        filtered_proprietary_preparations: filteredBrands,
        ...preferredClinicalContext,
      };
    }

    return {
      generic_name: cleanDrugDisplayName(primaryEntry.drug_name),
      aliases: uniqueStrings(safeEntries.flatMap((entry) => entry.aliases)),
      pages: uniquePages(safeEntries),
      filtered_proprietary_preparations: filteredBrands,
      ...preferredClinicalContext,
      matched_entry_count: safeEntries.length,
      matched_entries: safeEntries.map((entry, index) => ({
        entry_label: `Entry ${index + 1}`,
        pages: entry.pages,
        filtered_proprietary_preparations: this.selectPreferredBrandEntries(entry, requestedBrandQuery),
      })),
    };
  }

  private async buildDosePromptContext(entry: DrugEntry): Promise<Record<string, unknown>> {
    return this.buildDosePromptContexts([entry]);
  }

  getResolvedGenericName(entry: DrugEntry): string {
    return cleanDrugDisplayName(entry.drug_name);
  }

  getResolvedGenericNameFromEntries(entries: DrugEntry[]): string {
    return entries[0] ? this.getResolvedGenericName(entries[0]) : '';
  }

  async findDrugEntryByName(query: string, catalog?: DrugCatalog): Promise<DrugEntry | null> {
    const activeCatalog = catalog ?? (await this.ensureDatasetReady());
    return this.findTopExactMatch(activeCatalog, {
      drug_name: canonicalizeDrugQueryCase(query),
      confidence: 1,
    });
  }

  getFilteredBrandEntries(
    entry: DrugEntry,
    limit = 3,
  ): ParsedProprietaryPreparation[] {
    return this.selectPreferredBrandEntries(entry).slice(0, Math.max(0, limit));
  }

  buildBrandLookupResult(
    query: string,
    entry: DrugEntry,
    limit = 3,
  ): DrugBrandLookupResult {
    return {
      query,
      resolved_generic_name: this.getResolvedGenericName(entry),
      filtered_proprietary_preparations: this.getFilteredBrandEntries(entry, limit),
      indications: compactField(entry.indications),
      dose: compactField(entry.dose),
      notes: compactField(entry.notes),
    };
  }

  private entryHasExactCaseSensitiveMatch(entry: DrugEntry, query: string): boolean {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return false;

    const cleanedQuery = stripDrugNameQualifiers(trimmedQuery);
    if (stripDrugNameQualifiers(entry.drug_name.trim()) === cleanedQuery) return true;

    return false;
  }

  private entryHasExactNormalizedMatch(entry: DrugEntry, query: string): boolean {
    const normalizedQuery = normalizeDrugIdentity(query);
    if (!normalizedQuery) return false;

    if (normalizeDrugIdentity(entry.drug_name) === normalizedQuery) return true;

    return false;
  }

  private entryHasFuzzyTitleMatch(entry: DrugEntry, query: string): boolean {
    const normalizedQuery = normalizeDrugIdentity(query);
    if (normalizedQuery.length < 5) return false;

    const candidates = [entry.drug_name, ...entry.aliases].map((value) => normalizeDrugIdentity(value));
    return candidates.some((candidate) => {
      if (!candidate || candidate.length < 5) return false;
      return candidate.includes(normalizedQuery) || normalizedQuery.includes(candidate);
    });
  }

  private entryHasProprietaryPhraseMatch(entry: DrugEntry, query: string): boolean {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return false;
    return hasExactPhraseMatch(entry.proprietary_preparations || '', trimmedQuery);
  }

  private entryHasProprietaryNormalizedMatch(entry: DrugEntry, query: string): boolean {
    const normalizedQuery = normalizeDrugLookupText(query);
    if (!normalizedQuery) return false;
    return normalizeDrugLookupText(entry.proprietary_preparations || '').includes(normalizedQuery);
  }

  private collectSearchCandidates(
    catalog: DrugCatalog,
    parsed: DrugQueryParseResult,
  ): DrugSearchCandidates {
    const query = parsed.drug_name.trim();
    if (!query) {
      return {
        strictMatches: [],
        preferredStrictMatches: [],
        normalizedMatches: [],
        preferredNormalizedMatches: [],
        fuzzyTitleMatches: [],
        preferredFuzzyTitleMatches: [],
        proprietaryStrictMatches: [],
        proprietaryNormalizedMatches: [],
      };
    }

    const searchableEntries = catalog.entries.filter((entry) => {
      return !DRUG_NAME_DENYLIST.has(entry.drug_name.trim().toUpperCase());
    });

    const strictMatches = searchableEntries.filter((entry) =>
      this.entryHasExactCaseSensitiveMatch(entry, query),
    );

    const preferredStrictMatches = strictMatches.filter(
      (entry) => entry.pages.length <= PREFERRED_MAX_PAGE_COUNT,
    );
    const normalizedMatches =
      strictMatches.length > 0
        ? []
        : searchableEntries.filter((entry) => this.entryHasExactNormalizedMatch(entry, query));
    const preferredNormalizedMatches = normalizedMatches.filter(
      (entry) => entry.pages.length <= PREFERRED_MAX_PAGE_COUNT,
    );
    const fuzzyTitleMatches =
      strictMatches.length > 0 || normalizedMatches.length > 0
        ? []
        : searchableEntries.filter((entry) => this.entryHasFuzzyTitleMatch(entry, query));
    const preferredFuzzyTitleMatches = fuzzyTitleMatches.filter(
      (entry) => entry.pages.length <= PREFERRED_MAX_PAGE_COUNT,
    );
    const proprietaryStrictMatches =
      strictMatches.length > 0 || normalizedMatches.length > 0 || fuzzyTitleMatches.length > 0
        ? []
        : searchableEntries.filter((entry) => this.entryHasProprietaryPhraseMatch(entry, query));
    const proprietaryNormalizedMatches =
      strictMatches.length > 0 ||
      normalizedMatches.length > 0 ||
      fuzzyTitleMatches.length > 0 ||
      proprietaryStrictMatches.length > 0
        ? []
        : searchableEntries.filter((entry) => this.entryHasProprietaryNormalizedMatch(entry, query));

    return {
      strictMatches,
      preferredStrictMatches,
      normalizedMatches,
      preferredNormalizedMatches,
      fuzzyTitleMatches,
      preferredFuzzyTitleMatches,
      proprietaryStrictMatches,
      proprietaryNormalizedMatches,
    };
  }

  private collectTopExactMatches(
    catalog: DrugCatalog,
    parsed: DrugQueryParseResult,
  ): DrugEntry[] {
    const candidates = this.collectSearchCandidates(catalog, parsed);
    const rankedGroups = [
      candidates.preferredStrictMatches,
      candidates.strictMatches,
      candidates.preferredNormalizedMatches,
      candidates.normalizedMatches,
      candidates.preferredFuzzyTitleMatches,
      candidates.fuzzyTitleMatches,
      candidates.proprietaryStrictMatches,
      candidates.proprietaryNormalizedMatches,
    ];

    const activeGroup = rankedGroups.find((group) => group.length > 0) ?? [];
    if (activeGroup.length === 0) return [];

    const primaryNormalizedDrugIdentity = normalizeDrugIdentity(activeGroup[0].drug_name);
    const relatedMatches = activeGroup.filter(
      (entry) => normalizeDrugIdentity(entry.drug_name) === primaryNormalizedDrugIdentity,
    );

    return dedupeDrugEntries(relatedMatches.length > 0 ? relatedMatches : [activeGroup[0]]);
  }

  private findTopExactMatch(
    catalog: DrugCatalog,
    parsed: DrugQueryParseResult,
  ): DrugEntry | null {
    const query = parsed.drug_name.trim();
    if (!query) return null;
    const candidates = this.collectSearchCandidates(catalog, parsed);
    const topMatches = this.collectTopExactMatches(catalog, parsed);
    const finalMatch = topMatches[0] ?? null;

    console.log('[DRUG SEARCH]', 'Direct case-sensitive lookup', {
      query,
      confidence: parsed.confidence,
      strictCandidateCount: candidates.strictMatches.length,
      preferredStrictCandidateCount: candidates.preferredStrictMatches.length,
      normalizedCandidateCount: candidates.normalizedMatches.length,
      preferredNormalizedCandidateCount: candidates.preferredNormalizedMatches.length,
      fuzzyTitleCandidateCount: candidates.fuzzyTitleMatches.length,
      preferredFuzzyTitleCandidateCount: candidates.preferredFuzzyTitleMatches.length,
      proprietaryStrictCandidateCount: candidates.proprietaryStrictMatches.length,
      proprietaryNormalizedCandidateCount: candidates.proprietaryNormalizedMatches.length,
      selectedMatchCount: topMatches.length,
      selectedMatch: finalMatch
        ? {
            drug_name: finalMatch.drug_name,
            aliases: finalMatch.aliases,
            pages: finalMatch.pages,
          }
        : null,
      topCandidates: [
        ...candidates.preferredStrictMatches,
        ...candidates.strictMatches,
        ...candidates.preferredNormalizedMatches,
        ...candidates.normalizedMatches,
        ...candidates.preferredFuzzyTitleMatches,
        ...candidates.fuzzyTitleMatches,
        ...candidates.proprietaryStrictMatches,
        ...candidates.proprietaryNormalizedMatches,
      ]
        .filter((entry, index, array) => array.findIndex((item) => item.id === entry.id) === index)
        .slice(0, 5)
        .map((entry) => ({
        drug_name: entry.drug_name,
        aliases: entry.aliases,
        pages: entry.pages,
      })),
    });

    return finalMatch;
  }

  private scoreSuggestedDrugName(query: string, candidate: string): number {
    const normalizedQuery = normalizeDrugLookupText(query);
    const normalizedCandidate = normalizeDrugLookupText(candidate);

    if (!normalizedQuery || !normalizedCandidate) return Number.NEGATIVE_INFINITY;
    if (normalizedQuery === normalizedCandidate) return 1000;

    let score = 0;

    if (normalizedCandidate.startsWith(normalizedQuery)) score += 320;
    if (normalizedQuery.startsWith(normalizedCandidate)) score += 180;
    if (normalizedCandidate.includes(normalizedQuery)) score += 140;

    const distance = levenshteinDistance(normalizedQuery, normalizedCandidate);
    score += Math.max(0, 240 - distance * 40);
    score -= Math.abs(normalizedCandidate.length - normalizedQuery.length) * 5;

    if (normalizedCandidate[0] === normalizedQuery[0]) score += 25;

    return score;
  }

  private async buildFallbackSuggestions(query: string): Promise<string[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];

    const verifiedDrugNames = await this.loadVerifiedDrugNames();
    const ranked = verifiedDrugNames
      .map((name) => ({
        name,
        score: this.scoreSuggestedDrugName(trimmedQuery, name),
      }))
      .filter((candidate) => candidate.score >= 120)
      .filter((candidate) => hasMinimumSuggestionLength(candidate.name))
      .filter((candidate) => normalizeDrugLookupText(candidate.name) !== normalizeDrugLookupText(trimmedQuery))
      .sort((left, right) => right.score - left.score);

    return ranked
      .slice(0, DRUG_SUGGESTION_LIMIT)
      .map((candidate) => candidate.name);
  }

  private buildNoMatchMessage(
    content: string,
    parsed: DrugQueryParseResult,
    suggestions: string[],
  ): string {
    const unmatched = parsed.drug_name.trim() || content;
    if (suggestions.length === 0) {
      return `I could not find a matching drug entry for: ${unmatched}. Please check the spelling or ask with the exact generic or brand name.`;
    }

    return `I could not find a matching drug entry for: ${unmatched}. Did you mean: ${suggestions.join(', ')}?`;
  }

  buildNoBrandEntryMessage(entry: DrugEntry): string {
    return this.buildNoBrandEntriesMessage([entry]);
  }

  buildNoBrandEntriesMessage(entries: DrugEntry[]): string {
    const safeEntries = dedupeDrugEntries(entries);
    const primaryEntry = safeEntries[0];
    if (!primaryEntry) {
      return 'No matching brand entry found in BD prescription dataset.';
    }

    const genericName = this.getResolvedGenericName(primaryEntry);
    const indications = uniqueStrings(safeEntries.map((entry) => compactField(entry.indications)));
    const doses = uniqueStrings(safeEntries.map((entry) => compactField(entry.dose)));

    const sections = [
      `${genericName} - Generic : ${genericName}`,
      '',
      'Brands and dose',
      '',
      'No matching brand entry found in BD prescription dataset.',
    ];

    if (indications.length > 0) {
      sections.push('', `Indications: ${indications.join(' | ')}`);
    }

    if (doses.length > 0) {
      sections.push('', `Dose: ${doses.join(' | ')}`);
    }

    return sections.join('\n');
  }

  private async saveAssistantMessage(
    sessionId: string,
    content: string,
  ): Promise<void> {
    const session = await this.indexedDBServices.sessionService.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const assistantMessage: MessageCreate = {
      sessionId,
      content,
      role: MessageSender.ASSISTANT,
    };

    await this.indexedDBServices.messageService.createMessage(
      assistantMessage,
      session.userId,
    );
  }

  async warmup(): Promise<void> {
    await this.ensureDatasetReady();
  }

  private buildExtractionSystemPrompt(drugName: string): string {
    return DRUG_EXTRACTION_SYSTEM_PROMPT_TEMPLATE.split('{{DRUG_NAME}}').join(drugName);
  }

  private buildDoseConversionSystemPrompt(drugName: string): string {
    return DRUG_DOSE_CONVERSION_SYSTEM_PROMPT.split('{{DRUG_NAME}}').join(drugName);
  }

  async sendMessage(
    sessionId: string,
    content: string,
    onStreamEvent?: (event: ChatStreamEvent) => void,
  ): Promise<void> {
    console.log('[DRUG MODE]', 'Starting drug mode pipeline', {
      sessionId,
      query: content,
    });

    try {
      onStreamEvent?.({
        type: 'status',
        message: 'Drug Dataset',
      });
      const catalog = await this.ensureDatasetReady();

      onStreamEvent?.({
        type: 'status',
        message: 'Drug Query Parsing',
      });
      const parsed = await this.parseDrugQuery(content);
      const intent = this.analyzeDrugQueryIntent(content);

      onStreamEvent?.({
        type: 'status',
        message: 'Drug Search',
      });
      const matchedEntries = this.collectTopExactMatches(catalog, parsed);
      const match = matchedEntries[0] ?? null;

      console.log('[DRUG SEARCH]', 'Final matched entries', {
        requestedDrug: parsed.drug_name,
        matchedEntry: match?.drug_name ?? null,
        matchedEntryCount: matchedEntries.length,
        requestedFields: intent.requestedFields,
        answerKind: intent.answerKind,
      });

      if (!match) {
        const suggestions = await this.buildFallbackSuggestions(parsed.drug_name);
        const noMatchMessage = this.buildNoMatchMessage(content, parsed, suggestions);
        console.warn('[DRUG SEARCH]', 'No matching drug entries found', {
          query: content,
          parsed,
          suggestions,
        });
        if (suggestions.length > 0) {
          onStreamEvent?.({
            type: 'suggestions',
            suggestions,
          });
        }
        await this.saveAssistantMessage(sessionId, noMatchMessage);
        onStreamEvent?.({
          type: 'done',
          content: noMatchMessage,
        });
        return;
      }

      const resolvedDrugName = this.getResolvedGenericNameFromEntries(matchedEntries);
      const promptContext =
        intent.answerKind === 'dose_with_brands'
          ? await this.buildDosePromptContexts(matchedEntries, parsed.drug_name)
          : this.buildSectionPromptContexts(matchedEntries, intent);

      if (
        intent.answerKind === 'dose_with_brands' &&
        Array.isArray((promptContext as Record<string, unknown>).filtered_proprietary_preparations) &&
        ((promptContext as Record<string, unknown>).filtered_proprietary_preparations as unknown[]).length === 0
      ) {
        const noBrandMessage = this.buildNoBrandEntriesMessage(matchedEntries);
        await this.saveAssistantMessage(sessionId, noBrandMessage);
        onStreamEvent?.({
          type: 'done',
          content: noBrandMessage,
        });
        return;
      }

      const contextPrompt = `User question:
${content}

Extracted drug name:
${parsed.drug_name}

Resolved generic drug:
${resolvedDrugName}

Matched drug entry or entries:
${stringifyEntryForPrompt(promptContext)}`;

      let fullResponse = '';

      if (intent.answerKind === 'dose_with_brands') {
        // ── PASS 1: Extract brands + verbatim indications/doses (no conversion) ──
        onStreamEvent?.({
          type: 'status',
          message: 'Extracting drug data...',
        });

        const pass1SystemPrompt = this.buildExtractionSystemPrompt(resolvedDrugName);
        logFullPromptText('[DRUG PASS 1 PROMPT][SYSTEM]', pass1SystemPrompt);
        logFullPromptText('[DRUG PASS 1 PROMPT][USER]', contextPrompt);

        const extractionOutput = await groqService.generateResponseWithGroq(
          contextPrompt,
          pass1SystemPrompt,
          DRUG_ANSWER_MODEL,
          {
            temperature: 0.1,
            maxTokens: 2400,
          },
        );

        console.log('[DRUG PASS 1]', 'Extraction complete', {
          responseLength: extractionOutput.length,
        });
        logFullPromptText('[DRUG PASS 1 OUTPUT]', extractionOutput);

        // ── PASS 2: Convert verbatim doses into dosing schedules (streaming) ──
        onStreamEvent?.({
          type: 'status',
          message: 'Calculating dosing schedules...',
        });

        const pass2SystemPrompt = this.buildDoseConversionSystemPrompt(resolvedDrugName);
        const pass2UserPrompt = `Here is the extracted drug data sheet. Convert all verbatim doses into practical dosing schedules:\n\n${extractionOutput}`;

        logFullPromptText('[DRUG PASS 2 PROMPT][SYSTEM]', pass2SystemPrompt);
        logFullPromptText('[DRUG PASS 2 PROMPT][USER]', pass2UserPrompt);

        await groqService.generateStreamingResponse(
          pass2UserPrompt,
          pass2SystemPrompt,
          DRUG_ANSWER_MODEL,
          {
            temperature: 0.2,
            maxTokens: 2400,
            maxFailoverRetries: 2,
            retryBackoffMs: 300,
            onChunk: (chunk) => {
              fullResponse += chunk;
            },
          },
        );

        console.log('[DRUG PASS 2]', 'Dose conversion complete', {
          responseLength: fullResponse.length,
        });
      } else {
        // ── Sectional answer (side effects, indications, etc.) — single pass ──
        onStreamEvent?.({
          type: 'status',
          message: 'Drug Answer Generation',
        });

        const systemPrompt = DRUG_MODE_SECTION_SYSTEM_PROMPT;
        logFullPromptText('[DRUG ANSWER PROMPT][SYSTEM]', systemPrompt);
        logFullPromptText('[DRUG ANSWER PROMPT][USER]', contextPrompt);

        await groqService.generateStreamingResponse(
          contextPrompt,
          systemPrompt,
          DRUG_ANSWER_MODEL,
          {
            temperature: 0.2,
            maxTokens: 2400,
            maxFailoverRetries: 2,
            retryBackoffMs: 300,
            onChunk: (chunk) => {
              fullResponse += chunk;
            },
          },
        );

        console.log('[DRUG ANSWER]', 'Sectional answer complete', {
          responseLength: fullResponse.length,
        });
      }

      const finalResponse = intent.answerKind === 'dose_with_brands'
        ? formatDrugDoseOutput(fullResponse)
        : fullResponse;

      await this.saveAssistantMessage(sessionId, finalResponse);
      onStreamEvent?.({
        type: 'done',
        content: finalResponse,
      });
    } catch (error) {
      console.error('[DRUG ERROR]', error);
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Drug mode failed to process the request';

      onStreamEvent?.({
        type: 'error',
        message: errorMessage,
      });

      throw error instanceof Error ? error : new Error(errorMessage);
    }
  }
}

export const drugModeService = new DrugModeService();
