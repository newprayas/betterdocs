import { groqService } from '@/services/groq/groqService';
import { getIndexedDBServices } from '@/services/indexedDB';
import { libraryService } from '@/services/libraryService';
import type {
  AskDrugIndicationsAndDoseStructured,
  DrugCatalog,
  DrugDatasetConfig,
  DrugDatasetRecord,
  DrugEntry,
  ParsedBrandDetail,
  DrugModeRequestedField,
  DrugQueryParseResult,
  MessageCreate,
  ParsedProprietaryPreparation,
} from '@/types';
import { MessageSender } from '@/types/message';
import type { ChatStreamEvent } from '@/services/rag';

const DRUG_QUERY_PARSER_MODEL = 'llama-3.3-70b-versatile';
const DRUG_ANSWER_MODEL = 'llama-3.3-70b-versatile';
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
  id: 'newdoc_voyage_1a4',
  name: 'Prescription BD',
  filename: 'shard_1a4.bin',
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

const hasStructuredIndicationsAndDose = (
  value?: AskDrugIndicationsAndDoseStructured | null,
): value is AskDrugIndicationsAndDoseStructured =>
  Boolean(value && (value.indications.length > 0 || value.notes.length > 0));

const sanitizeStructuredIndicationsAndDoseForPrompt = (
  value: AskDrugIndicationsAndDoseStructured,
): Omit<AskDrugIndicationsAndDoseStructured, 'raw_text'> => ({
  indications: value.indications,
  notes: value.notes,
});

const logDrugAskContextDebugRawText = (
  resolvedGenericName: string,
  matchedAskDrugTitle: string,
  rawText?: string | null,
): void => {
  const compactRawText = compactField(rawText || undefined);
  if (!compactRawText) return;

  console.log(
    `[DRUG ASK-DRUG CONTEXT] DEBUG RAW TEXT | resolvedGenericName=${resolvedGenericName} | matchedAskDrugTitle=${matchedAskDrugTitle} | ${compactRawText}`,
  );
};

const QUERY_DRUG_NAME_PREFIX_PATTERNS = [
  /^(?:what(?:'s| is)?\s+)?(?:the\s+)?(?:brands?|brand\s*names?|trade\s*names?)\s+of\s+/i,
  /^(?:what(?:'s| is)?\s+)?(?:the\s+)?(?:dose|doses|dosage|dosing|regimen|schedule)\s+of\s+/i,
  /^(?:what(?:'s| is)?\s+)?(?:the\s+)?(?:price|prices|cost|costs)\s+of\s+/i,
  /^(?:what(?:'s| is)?\s+)?(?:the\s+)?(?:indications?|side[\s-]?effects?|contra[\s-]?indications?|cautions?)\s+of\s+/i,
];

const sanitizeParsedDrugName = (value: string): string => {
  let cleaned = compactField(value) || '';
  if (!cleaned) return '';

  cleaned = cleaned.replace(/^['"`]+|['"`]+$/g, '').trim();
  for (const pattern of QUERY_DRUG_NAME_PREFIX_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  cleaned = cleaned.replace(/[?!.,;:]+$/g, '').trim();

  return cleaned;
};

const inferDrugNameFromRawQuery = (content: string): string => {
  const compact = compactField(content) || '';
  if (!compact) return '';

  const trailingOfPattern =
    /(?:^|\b)(?:brands?|brand\s*names?|trade\s*names?|dose|doses|dosage|dosing|regimen|schedule|price|prices|cost|costs|indications?|side[\s-]?effects?|contra[\s-]?indications?|cautions?)\s+of\s+([A-Za-z][A-Za-z0-9\s+'().\-]{1,80})$/i;
  const trailingBrandPattern = /([A-Za-z][A-Za-z0-9\s+'().\-]{1,80})\s+(?:brands?|brand\s*names?)$/i;

  const fromOf = compact.match(trailingOfPattern)?.[1];
  if (fromOf) return sanitizeParsedDrugName(fromOf);

  const fromBrand = compact.match(trailingBrandPattern)?.[1];
  if (fromBrand) return sanitizeParsedDrugName(fromBrand);

  return '';
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

type FormulationParseResult = {
  formulationRaw: string;
  formulation: string;
  releaseType?: 'SR' | 'XR';
};

const PROPRIETARY_FORMULATION_PATTERNS: Array<{
  pattern: RegExp;
  formulationRaw: string;
  formulation: string;
  releaseType?: 'SR' | 'XR';
}> = [
  { pattern: /^(?:SR|XR)\s*Tab(?:let)?\.?/i, formulationRaw: 'SR Tab.', formulation: 'TABLET', releaseType: 'SR' },
  { pattern: /^(?:SR|XR)\s*Cap(?:sule)?\.?/i, formulationRaw: 'SR Cap.', formulation: 'CAPSULE', releaseType: 'SR' },
  { pattern: /^Paed\.?\s*drops?\.?/i, formulationRaw: 'Paed. drops', formulation: 'DROPS' },
  { pattern: /^Tab(?:let)?\.?/i, formulationRaw: 'Tab.', formulation: 'TABLET' },
  { pattern: /^Cap(?:sule)?\.?/i, formulationRaw: 'Cap.', formulation: 'CAPSULE' },
  { pattern: /^Inj(?:ection)?\.?/i, formulationRaw: 'Inj.', formulation: 'INJECTION' },
  { pattern: /^Amp(?:oule)?\.?/i, formulationRaw: 'Amp.', formulation: 'INJECTION' },
  { pattern: /^Suppo?\.?/i, formulationRaw: 'Supp.', formulation: 'SUPPOSITORY' },
  { pattern: /^Supp(?:ository)?\.?/i, formulationRaw: 'Supp.', formulation: 'SUPPOSITORY' },
  { pattern: /^Syrup\.?/i, formulationRaw: 'Syrup', formulation: 'SYRUP' },
  { pattern: /^Suspn?\.?/i, formulationRaw: 'Suspn.', formulation: 'SUSPENSION' },
  { pattern: /^Drops?\.?/i, formulationRaw: 'Drops', formulation: 'DROPS' },
  { pattern: /^Gel\.?/i, formulationRaw: 'Gel', formulation: 'GEL' },
  { pattern: /^Infusion\.?/i, formulationRaw: 'Infusion', formulation: 'INFUSION' },
  { pattern: /^Sachet\.?/i, formulationRaw: 'Sachet', formulation: 'SACHET' },
];

const PROPRIETARY_NEXT_ITEM_BOUNDARY_PATTERN =
  /,\s*(?=(?:(?:SR\s*)?(?:Tab(?:let)?\.?|Cap(?:sule)?\.?|Supp(?:o(?:sitory)?)?\.?|Inj(?:ection)?\.?|Amp(?:oule)?\.?|Syrup\.?|Suspn?\.?|Drops?\.?|Paed\.?\s*drops?\.?|Gel\.?|Infusion\.?|Sachet\.?)|\d))/i;

const standardizeProprietaryFormulation = (
  formulationRaw: string,
  releaseType?: 'SR' | 'XR',
): FormulationParseResult => {
  const compactRaw = compactField(formulationRaw) || '';
  if (!compactRaw) {
    return {
      formulationRaw: '',
      formulation: 'UNKNOWN',
    };
  }

  const normalized = compactRaw.replace(/\s+/g, ' ').trim();
  const pattern = PROPRIETARY_FORMULATION_PATTERNS.find((item) => item.pattern.test(normalized));
  if (!pattern) {
    return {
      formulationRaw: normalized,
      formulation: 'UNKNOWN',
    };
  }

  return {
    formulationRaw: pattern.formulationRaw,
    formulation: pattern.formulation,
    releaseType: pattern.releaseType || releaseType,
  };
};

const inferPaediatricProprietaryDetail = (
  rawText: string,
  standardizedFormulation: FormulationParseResult,
): boolean => {
  const normalized = rawText.toLowerCase();
  return (
    /\bpaed(?:iatric)?\.?\b/.test(normalized) ||
    /\bpediatric\b/.test(normalized) ||
    /\bpaed\.?\s*drops?\b/.test(normalized) ||
    /\bpaed\.?/i.test(standardizedFormulation.formulationRaw)
  );
};

const parseProprietaryDetailSegment = (
  segment: string,
  currentFormulationRaw?: string,
): { detail: ParsedBrandDetail | null; nextFormulationRaw: string | undefined } => {
  const cleanedSegment = compactField(segment) || '';
  if (!cleanedSegment) {
    return { detail: null, nextFormulationRaw: currentFormulationRaw };
  }

  const priceMatch = cleanedSegment.match(/T\s*k\s*\.?\s*([0-9]+(?:\.[0-9]+)?)(?:\s*\/\s*([^,;]+))?/i);
  if (!priceMatch || priceMatch.index == null) {
    return { detail: null, nextFormulationRaw: currentFormulationRaw };
  }

  const beforePrice = cleanedSegment.slice(0, priceMatch.index).replace(/^[,;.\s-]+/, '').trim();
  const afterPriceUnit = compactField(priceMatch[2] || '') || undefined;
  const formulationMatch = PROPRIETARY_FORMULATION_PATTERNS.find((item) => item.pattern.test(beforePrice));

  const resolvedFormulationRaw = formulationMatch?.formulationRaw || currentFormulationRaw || '';
  const standardized = standardizeProprietaryFormulation(resolvedFormulationRaw);
  const strengthText = compactField(
    formulationMatch
      ? beforePrice.replace(formulationMatch.pattern, '').replace(/^[,;.\s-]+/, '').trim()
      : beforePrice,
  );

  const detail: ParsedBrandDetail = {
    raw_text: cleanedSegment,
    formulation_raw: standardized.formulationRaw,
    formulation: standardized.formulation,
    release_type: standardized.releaseType,
    strength: strengthText || '',
    price: priceMatch[1],
    price_unit: afterPriceUnit,
    is_modified_release: Boolean(standardized.releaseType),
    is_paediatric: inferPaediatricProprietaryDetail(cleanedSegment, standardized),
  };

  return {
    detail,
    nextFormulationRaw: standardized.formulationRaw || currentFormulationRaw,
  };
};

const parseProprietaryDetailChunks = (details: string): ParsedBrandDetail[] => {
  const normalized = details.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const chunks = normalized
    .split(';')
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  const parsed: ParsedBrandDetail[] = [];
  let currentFormulationRaw: string | undefined;

  for (const chunk of chunks) {
    let cursor = 0;
    while (cursor < chunk.length) {
      while (cursor < chunk.length && /[\s,]/.test(chunk[cursor] || '')) {
        cursor += 1;
      }
      if (cursor >= chunk.length) break;

      const remaining = chunk.slice(cursor);
      const priceMatch = remaining.match(/T\s*k\s*\.?\s*([0-9]+(?:\.[0-9]+)?)/i);
      if (!priceMatch || priceMatch.index == null) break;

      const priceStart = cursor + priceMatch.index;
      const priceEnd = priceStart + priceMatch[0].length;
      const nextBoundaryMatch = chunk.slice(priceEnd).match(PROPRIETARY_NEXT_ITEM_BOUNDARY_PATTERN);
      const itemEnd = nextBoundaryMatch?.index != null ? priceEnd + nextBoundaryMatch.index : chunk.length;
      const itemText = chunk.slice(cursor, itemEnd).replace(/[;,.\s]+$/, '').trim();
      if (!itemText) {
        cursor = itemEnd + 1;
        continue;
      }

      const itemPriceMatch = itemText.match(/T\s*k\s*\.?\s*([0-9]+(?:\.[0-9]+)?)(?:\s*\/\s*([^,;]+))?/i);
      if (!itemPriceMatch || itemPriceMatch.index == null) {
        cursor = itemEnd + 1;
        continue;
      }

      const beforePrice = itemText.slice(0, itemPriceMatch.index).replace(/^[,;.\s-]+/, '').trim();
      const afterPrice = compactField(itemPriceMatch[2] || '') || undefined;
      const formulationMatch = PROPRIETARY_FORMULATION_PATTERNS.find((item) => item.pattern.test(beforePrice));
      const explicitFormulationRaw = formulationMatch?.formulationRaw || currentFormulationRaw || '';
      const standardized = standardizeProprietaryFormulation(explicitFormulationRaw);
      const strengthText = compactField(
        formulationMatch
          ? beforePrice.replace(formulationMatch.pattern, '').replace(/^[,;.\s-]+/, '').trim()
          : beforePrice,
      );

      parsed.push({
        raw_text: itemText,
        formulation_raw: standardized.formulationRaw,
        formulation: standardized.formulation,
        release_type: standardized.releaseType,
        strength: strengthText || '',
        price: itemPriceMatch[1],
        price_unit: afterPrice,
        is_modified_release: Boolean(standardized.releaseType),
        is_paediatric: inferPaediatricProprietaryDetail(itemText, standardized),
      });

      currentFormulationRaw = standardized.formulationRaw || currentFormulationRaw;
      cursor = itemEnd + 1;
    }
  }

  return parsed;
};

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

const toPromptBrandContext = (brand: ParsedProprietaryPreparation): Record<string, unknown> => ({
  brand_name: brand.brand_name,
  company_name: brand.company_name,
  display_name: brand.display_name,
  ...(brand.parsed_details?.length
    ? { parsed_details: brand.parsed_details }
    : { details: brand.details }),
  is_combination: brand.is_combination,
});

const toPromptBrandContexts = (
  brands: ParsedProprietaryPreparation[],
): Record<string, unknown>[] => brands.map(toPromptBrandContext);

type DrugModeAnswerKind = 'sectional' | 'dose_with_brands' | 'brands';
type DrugDoseAudience = 'adult' | 'child';

type DrugModeIntentClassifierResult = {
  intent: string;
  confidence: number;
};

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

const DRUG_AGE_LABEL_PREFIX =
  '(?:Adult|Elderly|Child|Paediatric|Pediatric|Infant|Neonate|Toddler|Baby)';

const normalizeDrugDoseAgeLine = (line: string): string => {
  const trimmedLine = line.trim();
  if (!trimmedLine) return trimmedLine;

  const plainLine = trimmedLine.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
  const match = plainLine.match(
    new RegExp(`^(${DRUG_AGE_LABEL_PREFIX}\\b[^:]{0,80}):\\s*(.*)$`, 'i'),
  );

  if (!match) return trimmedLine;

  const [, ageLabel, remainder] = match;
  if (!remainder) {
    return `**${ageLabel}:**`;
  }

  return `**${ageLabel}:**\nDose : ${remainder}`;
};

const normalizeDrugDoseBlock = (block: string): string =>
  block
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const normalizedAgeLine = normalizeDrugDoseAgeLine(line);
      if (/^Price:/i.test(normalizedAgeLine)) {
        return `Price: ${normalizedAgeLine.replace(/^Price:\s*/i, '').trim()}`;
      }
      return normalizedAgeLine;
    })
    .join('\n');

const isDrugFormulationHeadingBlock = (block: string): boolean => {
  const firstLine = block.split('\n').find((line) => line.trim())?.trim() || '';
  return /^\*\*✅/.test(firstLine) && !/\bIndications\b/i.test(firstLine);
};

const isDrugBrandBlock = (block: string): boolean => {
  const firstLine = block.split('\n').find((line) => line.trim())?.trim() || '';
  return /^🎉/.test(firstLine);
};

const isReferenceOnlyDrugBrandBlock = (block: string): boolean =>
  isDrugBrandBlock(block) &&
  /\[same strength dosing already (?:listed|covered) above\]/i.test(block) &&
  !/(^|\n)🎯/m.test(block) &&
  !new RegExp(`(^|\\n)\\*\\*${DRUG_AGE_LABEL_PREFIX}\\b`, 'im').test(block);

const reorderDrugFormulationBlocks = (blocks: string[]): string[] => {
  const reorderedBlocks: string[] = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!isDrugFormulationHeadingBlock(block)) {
      reorderedBlocks.push(block);
      continue;
    }

    reorderedBlocks.push(block);

    const formulationBlocks: string[] = [];
    let cursor = index + 1;
    while (cursor < blocks.length && !isDrugFormulationHeadingBlock(blocks[cursor])) {
      formulationBlocks.push(blocks[cursor]);
      cursor += 1;
    }

    const leadingNonBrandBlocks: string[] = [];
    const trailingNonBrandBlocks: string[] = [];
    const brandBlocks: string[] = [];

    for (const formulationBlock of formulationBlocks) {
      if (isDrugBrandBlock(formulationBlock)) {
        brandBlocks.push(formulationBlock);
        continue;
      }

      if (brandBlocks.length === 0) {
        leadingNonBrandBlocks.push(formulationBlock);
      } else {
        trailingNonBrandBlocks.push(formulationBlock);
      }
    }

    const primaryBrandBlocks = brandBlocks.filter(
      (formulationBlock) => !isReferenceOnlyDrugBrandBlock(formulationBlock),
    );
    const referenceBrandBlocks = brandBlocks.filter(isReferenceOnlyDrugBrandBlock);

    reorderedBlocks.push(
      ...leadingNonBrandBlocks,
      ...primaryBrandBlocks,
      ...referenceBrandBlocks,
      ...trailingNonBrandBlocks,
    );

    index = cursor - 1;
  }

  return reorderedBlocks;
};

const renderDrugDoseBlock = (block: string): string => {
  const lines = block
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return '';
  if (isDrugBrandBlock(block)) {
    return lines.join('  \n');
  }

  return lines.join('\n');
};

const formatDrugDoseOutput = (raw: string): string => {
  const strippedPreludeRaw = (() => {
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const firstContentIndex = lines.findIndex((line) => {
      const trimmedLine = line.trim();
      return (
        /^\*\*✅(?!\s*Indications\b)/i.test(trimmedLine) ||
        /^🎉/.test(trimmedLine) ||
        /^🔴/.test(trimmedLine)
      );
    });

    return firstContentIndex >= 0 ? lines.slice(firstContentIndex).join('\n') : raw;
  })();

  const normalizedRaw = strippedPreludeRaw
    .replace(/\r\n/g, '\n')
    .replace(new RegExp(`\\*\\*\\s+(?=${DRUG_AGE_LABEL_PREFIX}\\b)`, 'gi'), '**')
    .replace(/([^\n])\s*(?=\*\*✅)/g, '$1\n\n')
    .replace(/([^\n])\s*(?=🎉)/g, '$1\n\n')
    .replace(/([^\n])\s*(?=🎯)/g, '$1\n')
    .replace(
      new RegExp(`([^\\n])\\s*(?=\\*\\*${DRUG_AGE_LABEL_PREFIX}\\b[^*]{0,80}:\\*\\*)`, 'gi'),
      '$1\n',
    )
    .replace(/([^\n])\s*(?=Price:)/gi, '$1\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const reorderedBlocks = reorderDrugFormulationBlocks(
    normalizedRaw
      .split(/\n{2,}/)
      .map(normalizeDrugDoseBlock)
      .filter(Boolean),
  );

  return reorderedBlocks.map(renderDrugDoseBlock).filter(Boolean).join('\n\n').trim();
};

const formatDrugBrandsOutput = (raw: string): string =>
  formatDrugDoseOutput(raw)
    .split('\n')
    .map((line) => {
      if (/^\s*🎉/.test(line) || /^\s*Price:/i.test(line)) {
        return line.replace(/\*\*/g, '');
      }
      return line;
    })
    .join('\n');

const capitalizeContraindicationText = (value: string): string =>
  value.replace(/^([a-z])/, (_, firstLetter: string) => firstLetter.toUpperCase());

const isContraindicationsHeading = (trimmedLine: string): boolean =>
  /^(?:\*\*)?❌\s*Contraindications(?:\*\*)?$/i.test(trimmedLine) ||
  /^(?:\*\*)?Contraindications(?:\*\*)?$/i.test(trimmedLine);

const isContraindicationsBlockBoundary = (trimmedLine: string): boolean =>
  /^(?:\*\*)?✅/.test(trimmedLine) ||
  /^(?:\*\*)?❌/.test(trimmedLine) ||
  /^#{1,6}\s/.test(trimmedLine) ||
  /^🎉/.test(trimmedLine) ||
  /^🎯/.test(trimmedLine) ||
  /^\*\*(?:Adult|Child|Paediatric|Pediatric|Infant|Neonate|Toddler|Baby)/.test(trimmedLine) ||
  /^Price:/i.test(trimmedLine);

const cleanContraindicationSentence = (value: string): string =>
  capitalizeContraindicationText(
    value
      .replace(/\s+\./g, '.')
      .replace(/\s+/g, ' ')
      .replace(/^[,;:.()\[\]\s-]+/, '')
      .replace(/[,;:.()\[\]\s-]+$/, '')
      .trim(),
  );

const splitContraindicationSentenceItems = (value: string): string[] =>
  value
    .split(/\s*(?:\.(?=\s|$)|;(?=\s|$))\s*/)
    .map(cleanContraindicationSentence)
    .filter(Boolean);

const expandContraindicationSegmentToBullets = (segment: string): string[] => {
  const cleanedSegment = segment
    .replace(/^\s*[-*]\s*/, '')
    .replace(/\s+\./g, '.')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleanedSegment) {
    return [];
  }

  const groupedMatch =
    cleanedSegment.match(/^(With .+? use)\s+([A-Z][\s\S]*)$/) ||
    cleanedSegment.match(/^(When used for .+?)\s+([A-Z][\s\S]*)$/);

  if (groupedMatch) {
    const label = cleanContraindicationSentence(groupedMatch[1]);
    const items = splitContraindicationSentenceItems(groupedMatch[2]);
    if (items.length > 0) {
      return [`- ${label}:`, ...items.map((item) => `- ${item}`)];
    }
  }

  const items = splitContraindicationSentenceItems(cleanedSegment);
  if (items.length > 1) {
    return items.map((item) => `- ${item}`);
  }

  const singleItem = cleanContraindicationSentence(cleanedSegment);
  return singleItem ? [`- ${singleItem}`] : [];
};

const normalizeContraindicationsBlockLines = (lines: string[]): string[] =>
  lines.flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return [];
    }

    return trimmed
      .split(/\s*▶\s*/)
      .flatMap((segment) => expandContraindicationSegmentToBullets(segment));
  });

const normalizeContraindicationCapitalization = (text: string): string => {
  const lines = text.split('\n');
  const normalizedLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!isContraindicationsHeading(trimmed)) {
      normalizedLines.push(line);
      continue;
    }

    normalizedLines.push(line);

    const blockLines: string[] = [];
    let innerIndex = index + 1;
    while (innerIndex < lines.length) {
      const candidateLine = lines[innerIndex];
      const candidateTrimmed = candidateLine.trim();

      if (candidateTrimmed && isContraindicationsBlockBoundary(candidateTrimmed)) {
        break;
      }

      blockLines.push(candidateLine);
      innerIndex += 1;
    }

    const normalizedBlockLines = normalizeContraindicationsBlockLines(blockLines);
    if (normalizedBlockLines.length > 0) {
      normalizedLines.push('');
      normalizedLines.push(...normalizedBlockLines);
      if (innerIndex < lines.length && lines[innerIndex]?.trim()) {
        normalizedLines.push('');
      }
    }

    index = innerIndex - 1;
  }

  return normalizedLines.join('\n');
};

const cleanDoseSummaryItem = (value: string): string | null => {
  let cleaned = compactField(value) || '';
  if (!cleaned) return null;

  cleaned = cleaned
    .replace(/^(?:and|or)\s+/i, '')
    .replace(/^[,;:.()\[\]\s-]+/, '')
    .replace(/[,;:.()\[\]\s-]+$/, '')
    .trim();

  if (!cleaned) return null;
  return cleaned;
};

const extractIndicationLabelsFromAskDrugText = (value: string): string[] => {
  const compact = compactField(value) || '';
  if (!compact) return [];

  const matches: string[] = [];
  const pattern =
    /(?:^|▶\s*(?:Adult|Child|Elderly|Neonate|Infant|Adolescent|Young person)[^▶]{0,700}?)([^▶]{1,320}?)(?=\s*▶\s*BY\b)/gi;

  for (const match of compact.matchAll(pattern)) {
    const rawSegment = compactField(match[1] || '');
    if (!rawSegment) continue;

    for (const part of rawSegment.split(/\s+\|\s+/)) {
      const cleaned = cleanDoseSummaryItem(part);
      if (cleaned) {
        matches.push(cleaned);
      }
    }
  }

  return uniqueStrings(matches);
};

const extractDoseSummaryIndications = (promptContext: Record<string, unknown>): string[] => {
  const source = compactField(String(promptContext.clinical_context_source || '')) || '';
  const clinicalContext =
    promptContext.clinical_context && typeof promptContext.clinical_context === 'object'
      ? (promptContext.clinical_context as Record<string, unknown>)
      : null;

  if (!clinicalContext) {
    return [];
  }

  if (source === 'ask_drug_indications_and_dose') {
    const structured =
      clinicalContext.indications_and_dose_structured &&
      typeof clinicalContext.indications_and_dose_structured === 'object'
        ? (clinicalContext.indications_and_dose_structured as AskDrugIndicationsAndDoseStructured)
        : null;

    if (structured?.indications?.length) {
      return uniqueStrings(
        structured.indications
          .map((item) => cleanDoseSummaryItem(item.indication))
          .filter((item): item is string => Boolean(item)),
      );
    }

    if (typeof clinicalContext.indications_and_dose === 'string') {
      return extractIndicationLabelsFromAskDrugText(clinicalContext.indications_and_dose);
    }

    return [];
  }

  if (typeof clinicalContext.indications !== 'string') {
    return [];
  }

  return uniqueStrings(
    clinicalContext.indications
      .split(/\s*\|\s*|\n+/)
      .map((item) => cleanDoseSummaryItem(item))
      .filter((item): item is string => Boolean(item)),
  );
};

const extractDoseSummaryContraindications = (
  promptContext: Record<string, unknown>,
): string | undefined => {
  const source = compactField(String(promptContext.clinical_context_source || '')) || '';
  const clinicalContext =
    promptContext.clinical_context && typeof promptContext.clinical_context === 'object'
      ? (promptContext.clinical_context as Record<string, unknown>)
      : null;

  if (!clinicalContext) {
    return undefined;
  }

  const rawContraindications =
    source === 'ask_drug_indications_and_dose'
      ? clinicalContext.contra_indications
      : clinicalContext.contraindications;

  return typeof rawContraindications === 'string'
    ? compactField(rawContraindications)
    : undefined;
};

const buildDoseResponsePrelude = (
  drugName: string,
  promptContext: Record<string, unknown>,
  requestedDoseAudience: DrugDoseAudience,
): string => {
  const lines: string[] = [`**${drugName}** - Generic : ${drugName}`];
  const clinicalContextSource =
    compactField(String(promptContext.clinical_context_source || '')) || 'drug_mode_fallback';

  if (clinicalContextSource === 'drug_mode_fallback') {
    lines.push(
      '',
      '⚠️ British National Pharmacopoeia data not found, using regional information',
    );
  }

  lines.push(
    '',
    requestedDoseAudience === 'child'
      ? '⚠️ Only **CHILD** dose given, search adult dose separately'
      : '⚠️ Only **ADULT** dose given, search child dose separately',
  );

  const indications = extractDoseSummaryIndications(promptContext);
  lines.push('', '**✅ Indications**');

  if (indications.length > 0) {
    lines.push(...indications.map((indication) => `- ${indication}`));
  } else {
    lines.push('- Not found in provided drug dataset.');
  }

  const contraindications = extractDoseSummaryContraindications(promptContext);
  if (contraindications) {
    lines.push('', '**❌ Contraindications**', contraindications);
  }

  return lines.join('\n').trim();
};

// ─── PASS 1: Extraction-only prompt (no dose math) ───────────────────────────
const DRUG_EXTRACTION_SYSTEM_PROMPT_TEMPLATE = `You are a drug-data extraction assistant.
For the DRUG: {{DRUG_NAME}}, extract all brand names with exact verbatim dose text for ONLY the most common ward-use indications from the clinical context.

[ie; all brands of the generic drug in the context]
[the app has already filtered and prioritized these brand names when available: Square, Incepta, Healthcare, Opsonin, Beximco, Aristopharma]
[Use ONLY the filtered proprietary brand entries provided in context. Do not invent extra brands.]
[If a brand entry includes parsed_details, use parsed_details first and treat the raw details string as fallback text only.]
[If parsed_details is present, do not use the raw details string unless parsed_details is empty or unusable.]
[Use ONLY the provided clinical_context as the source for indications and dose text. Do not mix it with any other source.]
[If clinical_context_source is ask_drug_indications_and_dose, use clinical_context.indications_and_dose_structured when present; otherwise use clinical_context.indications_and_dose.]
[If clinical_context_source is drug_mode_fallback, use only clinical_context.indications and clinical_context.dose.]
[Never combine the ask-drug clinical context and the drug-mode clinical context together.]
[If the context contains multiple matched entries for the same generic drug, use all of them together and combine carefully.]
[If two matched entries differ, keep the difference clear instead of deleting one.]
[Route-to-formulation mapping rules:
  - BY MOUTH USING IMMEDIATE-RELEASE MEDICINES -> immediate-release TABLET or CAPSULE only.
  - BY MOUTH USING MODIFIED-RELEASE MEDICINES -> modified-release TABLET only, such as SR TABLET or XR TABLET.
  - BY RECTUM -> SUPPOSITORY only.
  - BY INTRAVENOUS INFUSION -> INJECTION or INFUSION only when the context explicitly supports intravenous use.
  - Do not apply oral dosing to suppositories, rectal products, or intravenous products.
]
[You will receive an optional requested_indication_query in the input context.]
[You will receive requested_dose_audience in the input context with value "adult" or "child".]
[If requested_dose_audience is "adult", include adult dosing lines and elderly dosing lines when present. Exclude child, pediatric, paediatric, infant, neonate, baby, and toddler dosing lines.]
[If requested_dose_audience is "child", include ONLY child/pediatric/paediatric/infant/neonate/baby/toddler dosing lines when present. Do NOT include adult dosing.]
[Never include both adult and child dosing in the same extracted output.]
[If any parsed_details item has is_modified_release: true, only use modified-release oral dosing for that item and never apply immediate-release dosing to it.]
[If any parsed_details item has is_paediatric: true, do not apply adult dosing to that item. Mark it as exactly: 🔴 No adult dosing — paediatric formulation]
[If the requested dose audience is missing for the selected indication, write exactly "**Adult:** Not found in provided drug dataset." or "**Child:** Not found in provided drug dataset." as appropriate, and do not substitute the other audience.]
[If requested_brand_query is present in the input context, that means the user asked by a brand name or alias.]
[When requested_brand_query is present, do NOT limit the answer to only that brand. Include the requested brand if available, plus the other filtered brands for the resolved generic drug from context.]
[If requested_indication_query is non-empty, select EXACTLY 1 indication that best matches that requested indication from clinical_context.]
[When matching requested_indication_query, prioritize exact/near-exact indication label matches over broader alternatives.]
[If requested_indication_query is empty, select EXACTLY 1 most common general ward-use indication from clinical_context.]
[CRITICAL: indication count must be exactly 1 (minimum 1, maximum 1).]
[Prioritize broad/high-frequency ward indications and ignore rare, niche, or specialty indications when no specific indication is requested.]
[Merge obvious duplicate or near-identical indication labels before final selection.]
[Do not include multiple indication labels in the extracted output.]
[If a formulation exists in filtered_proprietary_preparations, include it. Do not skip sachet, suspension, syrup, drops, suppository, topical, injection, infusion, or capsule forms.]
[Use only clearly stated brand strengths from filtered_proprietary_preparations with explicit units (mg, g, mcg, ml, %).]
[Do not invent a separate brand strength from a suspicious trailing numeric fragment.]
[If a brand detail looks malformed or ambiguous, ignore that malformed strength.]
[Do not add administration timing or advice such as "after food", "after meals" unless that exact detail is present in the chosen clinical_context.]

IMPORTANT RULES:
- Do NOT convert doses into tablet/capsule/vial counts. Just copy the exact dose text verbatim from clinical_context.
- Do NOT calculate any tablet, capsule, vial, ampoule, or unit-count schedule.
- DO list ONLY the single selected indication with exact verbatim dose text (Adult, Child, etc.) from the clinical context.
- CRITICAL: ALWAYS output exactly 1 indication (never 0, never more than 1).
- DO include the price for each brand.
- DO treat brands as duplicates for dosing when they have the SAME formulation AND the SAME explicit strength, even if the brand names and companies are different.
- Example of duplicates for dosing: "Tab. Fenac 100 mg - Acme" and "Tab. Clofenac 100 mg - Square" are both TABLET 100 mg, so ONLY the first 100 mg tablet brand should carry the indication and dose lines.
- For the second and later brands with the same formulation + same strength, show ONLY the brand line and price line, plus "[same strength dosing already listed above]". Do NOT repeat the indication or dose text.
- If two brands have DIFFERENT mg strengths (e.g. 50 mg and 100 mg), you MUST repeat the full verbatim dose text for EACH strength, even if the source clinical_context uses the same dose description.
- Within each formulation, list ALL brands that keep full indication/dose content first, and only after those list the reference-only same-strength brands that say "[same strength dosing already listed above]".

Formatting:

**{{DRUG_NAME}}** - Generic : resolved generic name

**✅ TABLET**

🎉 **Tab. Pantonix 20 mg - Incepta**
Price: 20 tk/tab
🎯 Helicobacter pylori eradication [in combination with other drugs]
**Adult:** 40 mg twice daily for 7 days for first- and second-line eradication therapy; 10 days for third-line eradication therapy

🎉 **Tab. Esonix 20 mg - Square** [same strength dosing already listed above]
Price: 33 tk/tab

**✅ INJECTION**

🎉 **Inj. Pantonix 40 mg - Incepta**
Price: 120 tk/vial
🎯 indication...
**Adult:** exact verbatim dose text...

And so on for every formulation and brand.`;

// ─── PASS 2: Verification and Formatting Fixes ───────────────────────────────
const DRUG_VERIFICATION_SYSTEM_PROMPT = `You are a clinical data verification assistant.
You will receive the extracted drug data from a previous step, along with the original matched drug entries and clinical context.

Your job is to VERIFY, FIX, and FINALIZE the extracted data. The output from this step is the final model-generated body that the app will display below its own title and summary sections.

Before finalizing, apply these route-to-formulation checks:
- BY MOUTH USING IMMEDIATE-RELEASE MEDICINES -> immediate-release TABLET or CAPSULE only.
- BY MOUTH USING MODIFIED-RELEASE MEDICINES -> modified-release TABLET only, such as SR TABLET or XR TABLET.
- BY RECTUM -> SUPPOSITORY only.
- BY INTRAVENOUS INFUSION -> INJECTION or INFUSION only when the context explicitly supports intravenous use.
- Never apply oral dosing to suppositories, rectal products, or intravenous products.
- If a parsed_details item has is_modified_release: true, only keep modified-release dosing for that item.
- If a parsed_details item has is_paediatric: true, do not apply adult dosing to that item. Keep the label exactly: 🔴 No adult dosing — paediatric formulation.

FORMATTING AND INCLUSION RULES TO CHECK AND FIX:
1. Missing Formulations Check:
   - Compare the formulations (Tablet, Capsule, Injection, Suppository, Syrup, Suspension, Drops, etc.) present in the provided "Matched drug entry or entries" against the dosages/indications present in the context.
   - If a formulation exists in the matched drug entries (brands exist) BUT there is no dosing information for it in the clinical context, include the formulation heading, the brands under that formulation, and add exactly this notice:
     🔴 No dosing information was present in dose and indications
   - If the clinical context provides dosing for a specific formulation (e.g. "BY RECTUM") BUT there are no brands for it in the matched drug entries, create the formulation heading, include the verbatim dose text, and add exactly this notice:
     🔴 No brands could be found for this formulation

2. Duplication and Strength Rules (CRITICAL):
   - Treat two brand blocks as duplicates for dosing when they have the SAME formulation AND the SAME explicit strength, even if the brand names or companies differ.
   - Example: "Tab. Fenac 100 mg - Acme" and "Tab. Clofenac 100 mg - Square" are both 100 mg tablets, so only one of them should keep the indication and dosing text.
   - For the second and later brands with the same formulation + same strength, keep ONLY the brand line and the price line, plus "[same strength dosing already listed above]". Remove any repeated indication or dose lines if present.
   - If two brands have DIFFERENT mg strengths (e.g. 50 mg and 100 mg), you MUST repeat the full verbatim dose text for EACH strength, even if the source clinical_context uses the same dose description.
   - Before finalizing, explicitly re-check the entire output for duplicate dosing blocks under the same formulation + same strength and collapse them if any slipped through.
   - Within each formulation, move all brands with full indication/dose content to the top, and place the reference-only same-strength brands below them.

3. Indication Selection Rule (CRITICAL):
   - Keep EXACTLY 1 indication in the extracted output (never 0, never more than 1).
   - If requested_indication_query is present in context, the selected indication must match it as closely as possible from the clinical context.
   - If requested_indication_query is empty, keep the single most common ward-use indication.

4. Dose Audience Rule (CRITICAL):
   - Use requested_dose_audience from context.
   - If requested_dose_audience is "adult", keep adult dosing lines and elderly dosing lines when present.
   - If requested_dose_audience is "child", keep ONLY child/pediatric/paediatric/infant/neonate/baby/toddler dosing lines.
   - Never mix adult and child dosing in the same verified output.
   - If the requested dose audience is missing for the selected indication, keep the same audience label and write "Not found in provided drug dataset."

5. Final Output Shape (CRITICAL):
   - Do NOT calculate tablets, capsules, ampoules, vials, or any other unit counts.
   - Keep the original dose text verbatim from the clinical context.
   - Do NOT include the main title, audience notice, indications summary, or contraindications summary. The app will render those.
   - Output formulation headings and brand blocks only.
   - Every brand name line MUST start with 🎉 and be wrapped in bold markers.
   - Every brand name line MUST be on its own line.
   - Every 🎯 indication line MUST start on a new line.
   - Every age-group label MUST be on its own line and bolded, e.g. **Adult:**, **Child 12-17 years:**.
   - Put the dose text on the next line in this exact style:
     Dose : 0.5-1 g every 4-6 hours; maximum 4 g per day
   - Every "Price:" line MUST start on its own line.
   - There MUST be a blank line between each brand block.
   - There MUST be a blank line before and after each formulation heading (**✅ TABLET**, etc.).

If these rules are not being followed in the provided extraction output, you MUST FIX the output perfectly.

Output ONLY the fixed and verified formulation/brand dataset. Do not add any conversational text.`;

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

const DRUG_BRANDS_SYSTEM_PROMPT = `You answer brand-name-only drug queries using ONLY the provided structured context.

Core rules:
- Use only "filtered_proprietary_preparations" from the context.
- If a brand entry includes parsed_details, prefer parsed_details over the raw details string.
- Include all brand entries provided in "filtered_proprietary_preparations" (this list is already pre-filtered and capped to top results).
- The list is capped to a maximum of 5 brands and prioritizes preferred companies first when available.
- Treat each object in "filtered_proprietary_preparations" as ONE distinct brand block.
- The number of 🎉 brand lines must equal the number of objects in "filtered_proprietary_preparations".
- Never split one brand object into multiple 🎉 lines.
- If one brand has multiple strengths/pack sizes/prices inside "details", keep them inside the same brand block (extra plain lines are allowed), not as new 🎉 items.
- Do not include indications, dose schedules, frequencies, age groups, contraindications, or counseling.
- Show only formulation, brand, company, strength, and price when available.
- Group brands under formulation headings.
- If a price is missing for a specific item, write: Price: Not specified
- Do not invent formulations, strengths, or prices.

Formatting:
- First line: **{GENERIC_NAME}** - Generic : {GENERIC_NAME}
- Then formulation groups using bold headings like:
  - **✅ TABLET**
  - **✅ CAPSULE**
  - **✅ INJECTION**
  - **✅ SUPPOSITORY**
  - **✅ SYRUP**
  - **✅ SUSPENSION**
  - **✅ GEL**
- Under each group, list each brand entry in this style:
  - 🎉 Brand line
  - Price line
- Brand lines (🎉 ...) and Price lines must be plain text (no bold markdown).
- Keep a blank line between brand items.
- Keep output clean and compact.`;

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
    const systemPrompt = `Extract the single drug/brand name and an optional requested indication phrase from the user's query.
Return ONLY valid JSON with this exact shape:
{
  "drug_name": "Pantonix",
  "requested_indication": "",
  "confidence": 0.98
}

Rules:
- Return only one drug or brand name.
- Remove all unrelated words from drug_name (for example, return "Napa" from "brands of napa").
- Do not correct, normalize, or change the spelling of the drug or brand name.
- Auto-capitalize the final drug_name in standard title case only.
- If the query contains a specific indication target (for example "for migraine", "for cough", "in postoperative pain"), set requested_indication to that clinical target phrase only.
- If no specific indication target is present, return requested_indication as an empty string.
- requested_indication must be short and clean (no dose, no route, no age group, no frequency, no brand names).
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
    const parserDrugName = sanitizeParsedDrugName(String(parsed.drug_name || ''));
    const inferredDrugName = inferDrugNameFromRawQuery(content);
    const resolvedDrugName = parserDrugName || inferredDrugName;
    const safeParsed: DrugQueryParseResult = {
      drug_name: canonicalizeDrugQueryCase(resolvedDrugName),
      requested_indication: compactField(String(parsed.requested_indication || '')) || '',
      confidence:
        typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0,
    };

    console.log('[DRUG PARSER]', 'Parsed query JSON', safeParsed);
    return safeParsed;
  }

  private resolveRequestedDoseAudience(content: string): DrugDoseAudience {
    const normalized = content.toLowerCase();

    if (
      /\b(child|children|pediatric|pediatrics|paediatric|paediatrics|peds|peds\.|paeds|paeds\.|infant|infants|baby|babies|toddler|toddlers|neonate|neonates|neonatal|newborn|newborns)\b/.test(
        normalized,
      )
    ) {
      return 'child';
    }

    return 'adult';
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
      /\b(dose|doses|dosage|dosing|schedule|regimen|how much|how many)\b/.test(
        normalized,
      );
    const brandOnlyRequested =
      /\b(brand|brands|brand\s+name(?:s)?|brands?\s+of|company|companies|price|prices|cost|costs|trade\s+name(?:s)?)\b/.test(
        normalized,
      );

    if (doseRequested) {
      addField('indications');
      addField('dose');
      return {
        requestedFields,
        answerKind: 'dose_with_brands',
        needsBrands: true,
      };
    }

    if (brandOnlyRequested) {
      return {
        requestedFields: [],
        answerKind: 'brands',
        needsBrands: true,
      };
    }

    if (requestedFields.length === 0) {
      return {
        requestedFields: [],
        answerKind: 'sectional',
        needsBrands: false,
      };
    }

    return {
      requestedFields,
      answerKind: 'sectional',
      needsBrands: false,
    };
  }

  private shouldUseIntentFallbackForTypos(content: string): boolean {
    const normalized = content.toLowerCase();
    const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
    const anchorKeywords = ['brand', 'brands', 'company', 'price', 'cost', 'dose', 'dosage', 'dosing', 'regimen', 'schedule'];

    return tokens.some((token) => {
      if (token.length < 4) return false;
      return anchorKeywords.some((keyword) => {
        if (Math.abs(token.length - keyword.length) > 1) return false;
        return levenshteinDistance(token, keyword) <= 1;
      });
    });
  }

  private async classifyAmbiguousIntentWithGroq(content: string): Promise<DrugModeAnswerKind | null> {
    const systemPrompt = `Classify the user query into exactly one intent.
Return ONLY valid JSON with this exact shape:
{
  "intent": "dose_with_brands",
  "confidence": 0.95
}

Valid "intent" values:
- "dose_with_brands": user asks for dose/dosing/regimen/schedule/how much for a drug.
- "brands": user asks for brand names/company/price list only, without dosing.
- "sectional": user asks for other sections (indications only, side-effects, cautions, contraindications, etc.) without dose and without brand-list request.

Rules:
- Handle common typos (example: "brads of voltalin" means brands).
- If both dose and brands are asked together, choose "dose_with_brands".
- Do not include any text outside JSON.`;

    try {
      const raw = await groqService.generateResponseWithGroq(
        content,
        systemPrompt,
        DRUG_QUERY_PARSER_MODEL,
        {
          temperature: 0,
          maxTokens: 120,
        },
      );
      const parsed = extractJsonObject<DrugModeIntentClassifierResult>(raw);
      const intent = String(parsed.intent || '').toLowerCase().trim();
      const normalizedIntent: DrugModeAnswerKind | null =
        intent === 'dose_with_brands' || intent === 'dose'
          ? 'dose_with_brands'
          : intent === 'brands' || intent === 'brand' || intent === 'brands_only'
            ? 'brands'
            : intent === 'sectional' || intent === 'section'
              ? 'sectional'
              : null;

      if (normalizedIntent) {
        console.log('[DRUG INTENT FALLBACK]', 'Resolved ambiguous query with mini intent call', {
          query: content,
          intent: normalizedIntent,
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
        });
        return normalizedIntent;
      }
    } catch (error) {
      console.warn('[DRUG INTENT FALLBACK]', 'Mini intent call failed, using app-level default', {
        query: content,
        error,
      });
    }

    return null;
  }

  private async resolveDrugQueryIntent(content: string): Promise<DrugModeIntent> {
    const heuristicIntent = this.analyzeDrugQueryIntent(content);
    if (heuristicIntent.answerKind !== 'sectional') {
      return heuristicIntent;
    }

    if (heuristicIntent.requestedFields.length > 0) {
      return heuristicIntent;
    }

    if (!this.shouldUseIntentFallbackForTypos(content)) {
      return {
        requestedFields: ['indications', 'dose'],
        answerKind: 'dose_with_brands',
        needsBrands: true,
      };
    }

    const fallbackIntent = await this.classifyAmbiguousIntentWithGroq(content);
    if (fallbackIntent === 'brands') {
      return {
        requestedFields: [],
        answerKind: 'brands',
        needsBrands: true,
      };
    }

    if (fallbackIntent === 'sectional') {
      return {
        requestedFields: ['indications', 'dose'],
        answerKind: 'dose_with_brands',
        needsBrands: true,
      };
    }

    return {
      requestedFields: ['indications', 'dose'],
      answerKind: 'dose_with_brands',
      needsBrands: true,
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
      /^(?:Tab(?:let)?\.?|Cap(?:sule)?\.?|Inj(?:ection)?\.?|Amp(?:oule)?\.?|Vials?\.?|Syrup|Suspn?\.?|Supp\.?|Paed\.?\s*drops?|Paed\.?\s*drop|Drops?)\s+/i,
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
      .map((header, index): ParsedProprietaryPreparation | null => {
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
        const parsedDetails = parseProprietaryDetailChunks(details);

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
          ...(parsedDetails.length > 0 ? { parsed_details: parsedDetails } : {}),
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
    const orderedBrands = [...preferred, ...others];
    const requestedBrand =
      this.findRequestedBrandMatch(pool, requestedBrandQuery) ??
      this.findRequestedBrandMatch(parsedBrands, requestedBrandQuery);

    if (!requestedBrand) {
      return orderedBrands.slice(0, DRUG_BRAND_RESULT_LIMIT);
    }

    const requestedBrandKey = normalizeDrugLookupText(requestedBrand.display_name);
    const remainingBrands = orderedBrands.filter(
      (brand) => normalizeDrugLookupText(brand.display_name) !== requestedBrandKey,
    );

    return [requestedBrand, ...remainingBrands].slice(0, DRUG_BRAND_RESULT_LIMIT);
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
    brandPreparations: ParsedProprietaryPreparation[] = [],
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
        {
          brandPreparations,
        },
      );

      if (askDrugContext) {
        const structuredIndicationsAndDose = hasStructuredIndicationsAndDose(
          askDrugContext.indications_and_dose_structured,
        )
          ? askDrugContext.indications_and_dose_structured
          : undefined;

        console.log('[DRUG ASK-DRUG CONTEXT]', 'Using ask-drug indications_and_dose context', {
          resolvedGenericName,
          matchedAskDrugTitle: askDrugContext.title,
          askDrugPages: askDrugContext.pages,
        });

        if (structuredIndicationsAndDose) {
          logDrugAskContextDebugRawText(
            resolvedGenericName,
            askDrugContext.title,
            structuredIndicationsAndDose.raw_text,
          );
        }

        return {
          clinical_context_source: 'ask_drug_indications_and_dose',
          clinical_context: {
            title: askDrugContext.title,
            pages: askDrugContext.pages,
            indications_and_dose: structuredIndicationsAndDose
              ? undefined
              : compactField(askDrugContext.indications_and_dose),
            indications_and_dose_structured: structuredIndicationsAndDose
              ? sanitizeStructuredIndicationsAndDoseForPrompt(structuredIndicationsAndDose)
              : undefined,
            contra_indications: compactField(askDrugContext.contra_indications),
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
        contraindications:
          uniqueStrings(safeEntries.map((entry) => compactField(entry.contraindications))).join(' | ') ||
          undefined,
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
    const preferredClinicalContext = await this.buildPreferredClinicalDoseContext(
      safeEntries,
      filteredBrands,
    );

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
        filtered_proprietary_preparations: toPromptBrandContexts(filteredBrands),
        ...preferredClinicalContext,
      };
    }

    return {
      generic_name: cleanDrugDisplayName(primaryEntry.drug_name),
      aliases: uniqueStrings(safeEntries.flatMap((entry) => entry.aliases)),
      pages: uniquePages(safeEntries),
      filtered_proprietary_preparations: toPromptBrandContexts(filteredBrands),
      ...preferredClinicalContext,
      matched_entry_count: safeEntries.length,
      matched_entries: safeEntries.map((entry, index) => ({
        entry_label: `Entry ${index + 1}`,
        pages: entry.pages,
        filtered_proprietary_preparations: toPromptBrandContexts(
          this.selectPreferredBrandEntries(entry, requestedBrandQuery),
        ),
      })),
    };
  }

  private buildBrandsPromptContexts(
    entries: DrugEntry[],
    requestedBrandQuery?: string,
  ): Record<string, unknown> {
    const safeEntries = dedupeDrugEntries(entries);
    const primaryEntry = safeEntries[0];
    const allCandidateBrands = dedupeParsedBrands(
      safeEntries.flatMap((entry) => this.selectPreferredBrandEntries(entry, requestedBrandQuery)),
    );
    const preferredBrands = allCandidateBrands.filter((brand) =>
      PREFERRED_BRAND_COMPANIES.includes(normalizeDrugLookupText(brand.company_name)),
    );
    const otherBrands = allCandidateBrands.filter(
      (brand) => !PREFERRED_BRAND_COMPANIES.includes(normalizeDrugLookupText(brand.company_name)),
    );
    const filteredBrands = [...preferredBrands, ...otherBrands].slice(0, DRUG_BRAND_RESULT_LIMIT);

    if (!primaryEntry) {
      return {
        generic_name: '',
        aliases: [],
        pages: [],
        filtered_proprietary_preparations: [],
        matched_entries: [],
      };
    }

    if (safeEntries.length === 1) {
      return {
        generic_name: cleanDrugDisplayName(primaryEntry.drug_name),
        aliases: uniqueStrings(primaryEntry.aliases),
        pages: primaryEntry.pages,
        filtered_proprietary_preparations: toPromptBrandContexts(filteredBrands),
      };
    }

    return {
      generic_name: cleanDrugDisplayName(primaryEntry.drug_name),
      aliases: uniqueStrings(safeEntries.flatMap((entry) => entry.aliases)),
      pages: uniquePages(safeEntries),
      filtered_proprietary_preparations: toPromptBrandContexts(filteredBrands),
      matched_entry_count: safeEntries.length,
      matched_entries: safeEntries.map((entry, index) => ({
        entry_label: `Entry ${index + 1}`,
        pages: entry.pages,
        filtered_proprietary_preparations: toPromptBrandContexts(
          this.selectPreferredBrandEntries(entry, requestedBrandQuery).slice(0, DRUG_BRAND_RESULT_LIMIT),
        ),
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
      requested_indication: '',
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
    const proprietaryStrictMatches =
      strictMatches.length > 0 || normalizedMatches.length > 0
        ? []
        : searchableEntries.filter((entry) => this.entryHasProprietaryPhraseMatch(entry, query));
    const proprietaryNormalizedMatches =
      strictMatches.length > 0 ||
      normalizedMatches.length > 0 ||
      proprietaryStrictMatches.length > 0
        ? []
        : searchableEntries.filter((entry) => this.entryHasProprietaryNormalizedMatch(entry, query));
    const fuzzyTitleMatches =
      strictMatches.length > 0 ||
      normalizedMatches.length > 0 ||
      proprietaryStrictMatches.length > 0 ||
      proprietaryNormalizedMatches.length > 0
        ? []
        : searchableEntries.filter((entry) => this.entryHasFuzzyTitleMatch(entry, query));
    const preferredFuzzyTitleMatches = fuzzyTitleMatches.filter(
      (entry) => entry.pages.length <= PREFERRED_MAX_PAGE_COUNT,
    );

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
      candidates.proprietaryStrictMatches,
      candidates.proprietaryNormalizedMatches,
      candidates.preferredFuzzyTitleMatches,
      candidates.fuzzyTitleMatches,
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
      const intent = await this.resolveDrugQueryIntent(content);

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
      const requestedIndicationQuery = compactField(parsed.requested_indication) || '';
      const requestedDoseAudience = this.resolveRequestedDoseAudience(content);
      const requestedBrandQuery =
        normalizeDrugIdentity(parsed.drug_name) !== normalizeDrugIdentity(resolvedDrugName)
          ? parsed.drug_name
          : '';
      const promptContext =
        intent.answerKind === 'sectional'
          ? this.buildSectionPromptContexts(matchedEntries, intent)
          : intent.answerKind === 'brands'
            ? this.buildBrandsPromptContexts(matchedEntries, parsed.drug_name)
            : await this.buildDosePromptContexts(matchedEntries, requestedBrandQuery);
      const promptContextForModel =
        intent.answerKind === 'dose_with_brands'
          ? {
              ...(promptContext as Record<string, unknown>),
              requested_indication_query: requestedIndicationQuery || null,
              requested_dose_audience: requestedDoseAudience,
              requested_brand_query: requestedBrandQuery || null,
            }
          : promptContext;

      if (
        (intent.answerKind === 'dose_with_brands' || intent.answerKind === 'brands') &&
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

Extracted user-requested drug or brand:
${parsed.drug_name}

Requested indication from query:
${requestedIndicationQuery || 'None'}

Requested dose audience:
${requestedDoseAudience}

Requested brand query:
${requestedBrandQuery || 'None'}

Resolved generic drug:
${resolvedDrugName}

Matched drug entry or entries:
${stringifyEntryForPrompt(promptContextForModel)}`;

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

        // ── PASS 2: Verification and Formatting Fixes ──
        onStreamEvent?.({
          type: 'status',
          message: 'Verifying drug data rules...',
        });

        const pass2SystemPrompt = DRUG_VERIFICATION_SYSTEM_PROMPT;
        const pass2UserPrompt = `${contextPrompt}\n\nHere is the extracted output from Pass 1. Please verify and fix it according to the rules:\n\n${extractionOutput}`;

        logFullPromptText('[DRUG PASS 2 PROMPT][SYSTEM]', pass2SystemPrompt);
        logFullPromptText('[DRUG PASS 2 PROMPT][USER]', pass2UserPrompt);

        const verificationOutput = await groqService.generateResponseWithGroq(
          pass2UserPrompt,
          pass2SystemPrompt,
          DRUG_ANSWER_MODEL,
          {
            temperature: 0.1,
            maxTokens: 2400,
          },
        );

        console.log('[DRUG PASS 2]', 'Verification complete', {
          responseLength: verificationOutput.length,
        });
        logFullPromptText('[DRUG PASS 2 OUTPUT]', verificationOutput);
        onStreamEvent?.({
          type: 'status',
          message: 'Formatting final drug answer...',
        });

        const formattedBody = formatDrugDoseOutput(verificationOutput);
        const prelude = buildDoseResponsePrelude(
          resolvedDrugName,
          promptContext as Record<string, unknown>,
          requestedDoseAudience,
        );

        fullResponse = formattedBody ? `${prelude}\n\n${formattedBody}` : prelude;
      } else if (intent.answerKind === 'brands') {
        onStreamEvent?.({
          type: 'status',
          message: 'Formatting brand list...',
        });

        const systemPrompt = DRUG_BRANDS_SYSTEM_PROMPT;
        logFullPromptText('[DRUG BRANDS PROMPT][SYSTEM]', systemPrompt);
        logFullPromptText('[DRUG BRANDS PROMPT][USER]', contextPrompt);

        const brandOnlyResponse = await groqService.generateResponseWithGroq(
          contextPrompt,
          systemPrompt,
          DRUG_ANSWER_MODEL,
          {
            temperature: 0.1,
            maxTokens: 1800,
          },
        );
        fullResponse = brandOnlyResponse;

        console.log('[DRUG BRANDS]', 'Brand-only answer complete', {
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

      const formattedResponse = intent.answerKind === 'sectional'
        ? fullResponse
        : intent.answerKind === 'brands'
          ? formatDrugBrandsOutput(fullResponse)
          : fullResponse;
      const finalResponse = normalizeContraindicationCapitalization(formattedResponse);

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
