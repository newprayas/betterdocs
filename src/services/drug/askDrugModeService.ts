import { groqService } from '@/services/groq/groqService';
import { getIndexedDBServices } from '@/services/indexedDB';
import { libraryService } from '@/services/libraryService';
import { drugModeService } from './drugModeService';
import { decorateIndicationLinks, shouldDecorateIndicationLinksForQuery } from './drugActionLinks';
import type {
  AskDrugBroadMatch,
  AskDrugCatalog,
  AskDrugDoseIndication,
  AskDrugDoseInstruction,
  AskDrugDoseRoute,
  AskDrugEntry,
  AskDrugIndicationsAndDoseStructured,
  AskDrugQueryParseResult,
  AskDrugRequestedSection,
  AskDrugSectionKey,
  DrugDatasetConfig,
  DrugDatasetRecord,
  DrugEntry,
  MessageCreate,
  ParsedProprietaryPreparation,
} from '@/types';
import { MessageSender } from '@/types/message';
import type { ChatStreamEvent } from '@/services/rag';

const ASK_DRUG_QUERY_PARSER_MODEL = 'llama-3.3-70b-versatile';
const ASK_DRUG_ANSWER_MODEL = 'llama-3.3-70b-versatile';
const ASK_DRUG_PROMPT_LOG_CHUNK_SIZE = 4000;
const ASK_DRUG_MATCH_LIMIT = 25;
const ASK_DRUG_SUGGESTION_LIMIT = 8;
const ASK_DRUG_SAFETY_BUNDLE: AskDrugSectionKey[] = [
  'important_safety_information',
  'cautions',
  'contra_indications',
  'treatment_cessation',
];
const ASK_DRUG_ALLOWED_QUERY_SECTIONS = new Set<AskDrugSectionKey>([
  'indications_and_dose',
  'contra_indications',
  'side_effects',
  'renal_impairment',
  'pregnancy',
  'breast_feeding',
  'hepatic_impairment',
  'important_safety_information',
]);
const ASK_DRUG_ALL_SEARCHABLE_SECTIONS: AskDrugSectionKey[] = [
  'indications_and_dose',
  'important_safety_information',
  'contra_indications',
  'cautions',
  'side_effects',
  'pregnancy',
  'breast_feeding',
  'hepatic_impairment',
  'renal_impairment',
  'treatment_cessation',
];
const ASK_DRUG_ALL_DETAILS_SECTIONS: AskDrugSectionKey[] = [
  'indications_and_dose',
  'important_safety_information',
  'contra_indications',
  'cautions',
  'cautions_further_information',
  'interactions',
  'side_effects',
  'pregnancy',
  'breast_feeding',
  'hepatic_impairment',
  'renal_impairment',
  'treatment_cessation',
  'directions_for_administration',
  'prescribing_and_dispensing_information',
  'patient_and_carer_advice',
];
const ASK_DRUG_BROAD_TERM_EXPANSIONS: Record<string, string[]> = {
  vomiting: ['vomiting', 'nausea', 'emesis'],
  nausea: ['nausea', 'vomiting', 'emesis'],
  emesis: ['emesis', 'vomiting', 'nausea'],
  hiccup: ['hiccup', 'hiccups', 'singultus'],
  hiccups: ['hiccups', 'hiccup', 'singultus'],
  singultus: ['singultus', 'hiccup', 'hiccups'],
  fever: ['fever', 'pyrexia', 'febrile'],
  pyrexia: ['pyrexia', 'fever', 'febrile'],
  febrile: ['febrile', 'fever', 'pyrexia'],
  itching: ['itching', 'pruritus'],
  itch: ['itch', 'itching', 'pruritus'],
  pruritus: ['pruritus', 'itching'],
  breathlessness: ['breathlessness', 'dyspnoea', 'shortness of breath'],
  dyspnoea: ['dyspnoea', 'breathlessness', 'shortness of breath'],
  'shortness of breath': ['shortness of breath', 'breathlessness', 'dyspnoea'],
};

export const ASK_DRUG_DATASET_CONFIG: DrugDatasetConfig = {
  id: 'drug_sections_bnf',
  name: 'BNF drug sections',
  filename: 'drug_sections.bin',
  size: 'Unknown',
};

type AskDrugPromptEntry = {
  title: string;
  pages: number[];
  sections: Partial<Record<AskDrugSectionKey, string>>;
  indications_and_dose_structured?: Omit<AskDrugIndicationsAndDoseStructured, 'raw_text'>;
};

type AskDrugBroadIndicationPromptEntry = {
  title: string;
  pages: number[];
  matched_indications: string[];
};

type AskDrugFormulationFamily =
  | 'oral'
  | 'injection'
  | 'topical'
  | 'ophthalmic'
  | 'nasal'
  | 'otic'
  | 'rectal'
  | 'inhalation';

const hasPromptEntryContent = (entry: AskDrugPromptEntry): boolean =>
  Object.keys(entry.sections).length > 0 ||
  Boolean(
    entry.indications_and_dose_structured &&
      (entry.indications_and_dose_structured.indications.length > 0 ||
        entry.indications_and_dose_structured.notes.length > 0),
  );

const ASK_DRUG_SYSTEM_PROMPT = `You answer drug questions using ONLY the provided dataset context.

Your job is to EXTRACT and PRESENT the information, not to summarize it.

Core rules:
- Do not use outside knowledge.
- Do not shorten, compress, generalize, or simplify if the dataset contains more detail.
- Do not omit points just to make the answer shorter.
- Include ALL relevant information found in the provided sections.
- If the dataset context includes "indications_and_dose_structured", prefer that structured representation over the flat raw text.
- In "indications_and_dose_structured", each item contains:
  - an indication
  - one or more routes
  - dose instructions grouped by age or patient group
  - optional notes stored separately
- If multiple indications, routes, formulations, age groups, or dose schedules are present, include all of them.
- If the question asks for one section, answer from that section only.
- If the question asks for multiple sections, present each section separately.
- If the question is broad, compare only the matched drugs provided in context.
- For broad indication queries, the context may contain only matched indication labels for each drug instead of full dosing paragraphs; use only those labels.
- If something is not present in the dataset context, say "Not found in provided dataset context."
- Never invent doses, contraindications, side-effects, pregnancy advice, renal advice, or safety details.
- If the prompt provides a "Display title", use that exact text as the main drug heading.

Formatting rules:
- Use clear markdown headings and subheadings.
- Use bullet points generously.
- Preserve the structure of the source as much as possible.
- Use markdown headings only for:
  - the drug name
  - the requested section title(s)
- Do not use markdown headings for routes, formulations, or indication labels.
- Route and formulation labels such as "BY MOUTH" or "BY INTRAVENOUS INFUSION" must be plain text, not headings.
- Indication labels such as "Mild to moderate pain | Pyrexia" must be bullet points, bold only, not headings.
- Nest content visually with indentation:
  - top level: bold bullet for the indication label
  - one indentation level inside: plain-text route or formulation label
  - two indentation levels inside: bullet points for dose instructions
- Always keep route lines directly under their indication bullet.
- Always keep dose bullets directly under their route line.
- Do not place dose bullets at the same level as the indication bullet.
- Rewrite route and formulation labels into short display wording in the final answer.
- Do not repeat the raw "BY ..." phrasing if it can be cleanly converted.
- Preferred route label conversions:
  - "BY MOUTH" -> "Oral [Tab/Cap/Syrup]"
  - "BY MOUTH USING IMMEDIATE-RELEASE MEDICINES" -> "Oral immediate-release [Tab/Cap/Syrup]"
  - "BY MOUTH USING MODIFIED-RELEASE MEDICINES" -> "Oral modified-release [Tab/Cap]"
  - "BY RECTUM" -> "Rectal [PR]"
  - "BY INTRAVENOUS INJECTION" -> "Injection [IV Inj]"
  - "BY SLOW INTRAVENOUS INJECTION" -> "Injection [Slow IV Inj]"
  - "BY INTRAVENOUS INFUSION" -> "Infusion [IV Inf]"
  - "BY INTRAMUSCULAR INJECTION" -> "Intramuscular [IM]"
  - "BY SUBCUTANEOUS INJECTION" -> "Subcutaneous [SC]"
  - "BY SUBCUTANEOUS INFUSION" -> "Subcutaneous infusion [SC Inf]"
  - "BY INTRAVENOUS INJECTION, OR BY INTRAVENOUS INFUSION" -> "Injection [IV Inj] / Infusion [IV Inf]"
  - "BY SUBCUTANEOUS INJECTION, OR BY INTRAMUSCULAR INJECTION" -> "Subcutaneous [SC] / Intramuscular [IM]"
  - "BY INTRAMUSCULAR INJECTION, OR BY INTRAVENOUS INJECTION, OR BY INTRAVENOUS INFUSION, OR BY SUBCUTANEOUS INJECTION" -> "Intramuscular [IM] / Injection [IV Inj] / Infusion [IV Inf] / Subcutaneous [SC]"
- If more than one route is listed on the same source line, combine them with " / " in the rewritten route label.
- Keep route labels concise and readable; do not invent routes or dosage forms not supported by the source text.
- For indications and dose, separate by:
  - indication
  - route or formulation
  - age group
  - dose
  - maximum dose
  - important administration details
- If modified-release and immediate-release are both present, list them separately.
- If adult and child dosing are both present, list them separately.
- Do not collapse multiple dosing schedules into one short sentence.
- Do not write "Dose summary" unless the user explicitly asks for a summary.

Preferred output style:
- Main heading: drug name
- Section heading: match the requested section names in user-friendly wording
- Under each section, format like this:
  - bold indication bullet
  - one-level indented plain-text route or formulation line
  - two-level indented bullet points for dose instructions
- Keep as much original detail as possible while making it readable

Formatting example:
## Paracetamol

### Indications and dose

- **Mild to moderate pain | Pyrexia**

  Oral [Tab/Cap/Syrup]
    - Adult: 0.5-1 g every 4-6 hours; maximum 4 g per day

  Infusion [IV Inf]
    - Adult (body-weight up to 50 kg): 15 mg/kg every 4-6 hours, dose to be administered over 15 minutes; maximum 60 mg/kg per day

- **Helicobacter pylori eradication [in combination with other drugs (see Helicobacter pylori infection p. 89)]**

  Oral [Tab/Cap/Syrup]
    - Adult: 20-40 mg twice daily for 7 days for first- and second-line eradication therapy; 10 days for third-line eradication therapy

Example behavior:
- If the context contains 6 different indication and dose patterns, output all 6.
- If the context contains adult and child dosing separately, output both separately.
- If the context contains route-specific instructions, keep them route-specific.
- If the context contains maximum daily dose or administration speed, include it explicitly.

Do not summarize unless the user explicitly asks for a summary.`;

const ASK_DRUG_INDICATIONS_ONLY_FORMAT_PROMPT = `Additional formatting mode:
- If the prompt says "Requested response format: indications_summary_plus_dose", and the dataset section is "Indications and dose", output TWO blocks in this order:
  - first: the drug title as the main heading at the very top
  - first: **✅ Indications**
  - second: **✅ Indications and dose**
- The drug title must appear only once at the top of the answer.
- Do not repeat the drug title again before the second block.
- Do not output a separate plain "Indications and dose" line under the ✅ Indications and dose heading.
- Always render both of these section labels in Markdown bold.
- In the ✅ Indications block, output only the indication labels.
- In the ✅ Indications block, do not include route labels, formulations, age groups, or dose instructions.
- In the ✅ Indications and dose block, keep the full detailed format with routes and doses.
- Example:
  - Tramadol hydrochloride
  - **✅ Indications**
  - Mild to moderate pain | Pyrexia
  - Pain | Pyrexia with discomfort
  - Post-immunisation pyrexia in infants
  - **✅ Indications and dose**
  - then the full detailed route-and-dose breakdown
- If the prompt says "Requested response format: standard", use the normal detailed formatting rules already defined above.`;

const ASK_DRUG_ALL_DETAILS_FORMAT_PROMPT = `Additional formatting mode:
- If the prompt says "Requested response format: all_details_supplemental_sections", format ONLY the provided supplemental monograph sections.
- Do not output the drug title.
- Do not output an "Indications" section.
- Do not output a "Contra-indications" section.
- Do not mention missing sections.
- For each provided section, use a markdown heading in the form "### Section name".
- Under each heading, present the content in clear bullet points.
- For dense semi-structured text such as side-effects, break the content into readable bullets and short sub-bullets where helpful.
- Preserve important qualifiers such as frequency, route, overdose notes, warnings, and administration details.
- Never invent facts or add content not present in the dataset context.
- Keep the answer focused on formatting the supplied text cleanly and completely.`;

const ASK_DRUG_BROAD_INDICATION_SYSTEM_PROMPT = `You answer broad drug-indication questions using ONLY the provided dataset context.

The context for this task contains only:
- drug names
- matched indication labels

It does NOT contain full dosing details, route details, or full monographs.

Strict rules:
- Do not use outside knowledge except for ordering the matched drugs by typical/common real-world clinical use.
- Do not infer, add, or guess any dose, route, formulation, frequency, duration, contraindication, or safety detail.
- Do not provide dosing information.
- Do not provide route information.
- Do not expand beyond the indication labels shown in context.
- If a drug is included in context, use only the indication labels provided for that drug.
- If multiple indications exist for one drug, list them clearly.
- Keep the answer focused on which drugs in the dataset match the user's condition.
- Rank the output from most commonly used / most practical drug first to least commonly used / least practical lower down.
- Use typical clinical commonness and likely first-line use only for ordering, not for inventing new facts.
- Prioritise common, direct treatment drugs over uncommon, incidental, preventive, vaccine, or disease-name-only matches.
- Example: for "drugs for fever", common antipyretics such as paracetamol or ibuprofen should appear above vaccines, prophylaxis drugs, or allergy entries containing the word "fever".
- Prefer general-purpose drugs for the requested indication before narrow, cause-specific, site-specific, combination, or specialist-only drugs.
- Example: for "drugs used for pruritus", place general pruritus drugs first, then cause-specific pruritus drugs, then local "pruritus ani" preparations, and finally specialist-only options.
- If one match is for the general condition and another is for a very specific subtype, body site, disease context, or expert-only setting, rank the general condition higher.
- If some matches are weak, incidental, or disease-name-only matches, place them after the direct matches or omit them if they are not genuinely useful for the user's request.
- If the dataset context is insufficient, say so clearly.

Formatting rules:
- Use a short heading for the condition-based answer.
- Then use bullet points.
- Present the most commonly used and most practical drugs first.
- Each bullet should contain:
  - drug name
  - the indication label(s) provided in context for that drug
- Do not create subheadings for routes or doses.
- Do not rewrite the answer into a monograph.

Preferred format:
## Drugs for fever

- Paracetamol
  - Pyrexia
  - Pyrexia with discomfort
  - Post-immunisation pyrexia in infants

- Ibuprofen
  - Pyrexia with discomfort
  - Post-immunisation pyrexia in infants

Never provide dose or route unless those details are explicitly present in the broad-query context.`;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const normalizeCompact = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();

const canonicalizeTitleCase = (value: string): string =>
  value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');

const normalizeIntentLeadTypos = (value: string): string =>
  value
    .trim()
    .replace(/^\s*w+h+a+t+\b/i, 'what')
    .replace(/^\s*whats\b/i, "what's");

const extractWhatIsQueryTarget = (value: string): string => {
  const normalized = normalizeIntentLeadTypos(value);
  const match = normalized.match(
    /^\s*(?:what|wat|wht)(?:'s|\s+is)?\s+([A-Za-z][A-Za-z0-9\s+'().\-]{1,80})\s*\??\s*$/i,
  )?.[1];
  return sanitizeParsedDrugName(match || '');
};

const ASK_DRUG_NAME_PREFIX_PATTERNS = [
  /^(?:what(?:'s| is)?\s+)?(?:the\s+)?(?:details|detail|full details|full detail|full information|complete details|everything)\s+(?:of|about)\s+/i,
  /^(?:what(?:'s| is)?\s+)?(?:the\s+)?(?:indications?|side[\s-]?effects?|contra[\s-]?indications?|renal(?:\s+dose|\s+impairment)?|hepatic(?:\s+dose|\s+impairment)?|pregnancy|breast[\s-]?feeding|safety(?:\s+information)?)\s+(?:of|for)\s+/i,
  /^(?:tell\s+me\s+about)\s+/i,
];

const sanitizeParsedDrugName = (value: string): string => {
  let cleaned = compactField(value) || '';
  if (!cleaned) return '';

  cleaned = cleaned.replace(/^['"`]+|['"`]+$/g, '').trim();
  for (const pattern of ASK_DRUG_NAME_PREFIX_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  cleaned = cleaned.replace(/[?!.,;:]+$/g, '').trim();

  return cleaned;
};

const inferDrugNameFromRawQuery = (content: string): string => {
  const compact = compactField(normalizeIntentLeadTypos(content)) || '';
  if (!compact) return '';

  const patterns = [
    /(?:^|\b)(?:details|detail|full details|full detail|full information|complete details|everything)\s+(?:of|about)\s+([A-Za-z][A-Za-z0-9\s+'().\-]{1,80})$/i,
    /(?:^|\b)tell\s+me\s+about\s+([A-Za-z][A-Za-z0-9\s+'().\-]{1,80})$/i,
    /(?:^|\b)(?:indications?|side[\s-]?effects?|contra[\s-]?indications?|renal(?:\s+dose|\s+impairment)?|hepatic(?:\s+dose|\s+impairment)?|pregnancy|breast[\s-]?feeding|safety(?:\s+information)?)\s+(?:of|for)\s+([A-Za-z][A-Za-z0-9\s+'().\-]{1,80})$/i,
  ];

  for (const pattern of patterns) {
    const match = compact.match(pattern)?.[1];
    if (match) {
      return sanitizeParsedDrugName(match);
    }
  }

  const whatIsTarget = extractWhatIsQueryTarget(compact);
  if (whatIsTarget) {
    return whatIsTarget;
  }

  return '';
};

const COMMON_DRUG_SALT_WORDS = new Set([
  'sulphate',
  'sulfate',
  'hydrochloride',
  'hcl',
  'sodium',
  'phosphate',
  'acetate',
  'nitrate',
  'tartrate',
  'maleate',
  'mesylate',
  'succinate',
  'citrate',
  'lactate',
  'gluconate',
  'chloride',
  'bromide',
]);

const COMMON_DRUG_SALT_ALIASES: Record<string, string[]> = {
  sulphate: ['sulphate', 'sulfate'],
  sulfate: ['sulfate', 'sulphate'],
  hydrochloride: ['hydrochloride', 'hcl'],
  hcl: ['hcl', 'hydrochloride'],
};

const stripCommonDrugSaltWords = (value: string): string =>
  value
    .trim()
    .split(/\s+/)
    .filter((part) => part && !COMMON_DRUG_SALT_WORDS.has(part.toLowerCase()))
    .join(' ');

const expandDrugSaltAliases = (value: string): string[] => {
  const compact = compactField(value) || '';
  if (!compact) return [];

  const variants = new Set<string>([compact]);
  const parts = compact.split(/\s+/);

  parts.forEach((part, index) => {
    const aliases = COMMON_DRUG_SALT_ALIASES[part.toLowerCase()];
    if (!aliases || aliases.length === 0) return;

    aliases.forEach((alias) => {
      const nextParts = [...parts];
      nextParts[index] = alias;
      const variant = compactField(nextParts.join(' '));
      if (variant) {
        variants.add(variant);
      }
    });
  });

  return Array.from(variants);
};

const buildAskDrugNameCandidates = (...values: Array<string | null | undefined>): string[] => {
  const candidates = new Set<string>();

  values.forEach((value) => {
    const compact = compactField(value) || '';
    if (!compact) return;

    const baseVariants = new Set<string>([
      compact,
      canonicalizeTitleCase(compact),
      stripCommonDrugSaltWords(compact),
      canonicalizeTitleCase(stripCommonDrugSaltWords(compact)),
    ]);

    Array.from(baseVariants)
      .filter(Boolean)
      .forEach((variant) => {
        expandDrugSaltAliases(variant).forEach((aliasVariant) => {
          const canonical = canonicalizeTitleCase(aliasVariant);
          if (canonical) {
            candidates.add(canonical);
          }
        });
      });
  });

  return Array.from(candidates);
};

const toDrugCoreTokens = (value: string): string[] =>
  stripCommonDrugSaltWords(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);

const tokenize = (value: string): string[] =>
  normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length > 1);

const compactField = (value?: string | null): string | undefined => {
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

const inferBrandFormulationFamilies = (
  brandPreparations: ParsedProprietaryPreparation[] = [],
): Set<AskDrugFormulationFamily> => {
  const families = new Set<AskDrugFormulationFamily>();

  for (const brand of brandPreparations) {
    for (const detail of brand.parsed_details || []) {
      const formulation = compactField(
        `${detail.formulation_raw} ${detail.formulation} ${detail.release_type || ''}`,
      ) || '';

      if (/\b(?:tablet|tab|capsule|cap|syrup|suspension|oral|lozenge|granules)\b/i.test(formulation)) {
        families.add('oral');
      }
      if (/\b(?:injection|inj|infusion|iv|im)\b/i.test(formulation)) {
        families.add('injection');
      }
      if (/\b(?:suppository|supp|pessary|enema|rectal)\b/i.test(formulation)) {
        families.add('rectal');
      }
      if (/\b(?:gel|cream|ointment|lotion|liniment|spray|foam|paint|patch)\b/i.test(formulation)) {
        families.add('topical');
      }
      if (/\b(?:eye|ophthalmic|ocular)\b/i.test(formulation)) {
        families.add('ophthalmic');
      }
      if (/\b(?:ear|otic|aural)\b/i.test(formulation)) {
        families.add('otic');
      }
      if (/\b(?:nasal|intranasal)\b/i.test(formulation)) {
        families.add('nasal');
      }
      if (/\b(?:inhalation|inhaler|neb|respule)\b/i.test(formulation)) {
        families.add('inhalation');
      }
    }

    const details = compactField(`${brand.display_name} ${brand.details}`) || '';
    if (!details) continue;

    if (/\b(?:tab(?:let)?s?\.?|cap(?:sule)?s?\.?|syrup|susp(?:ension)?|oral|lozenge|powder for oral|granules)\b/i.test(details)) {
      families.add('oral');
    }
    if (/\b(?:inj(?:ection)?\.?|amp(?:oule)?s?\.?|vials?\.?|prefilled|infusion)\b/i.test(details)) {
      families.add('injection');
    }
    if (/\b(?:supp(?:ository)?\.?|pessary|enema|rectal)\b/i.test(details)) {
      families.add('rectal');
    }
    if (/\b(?:gel|cream|ointment|oint\.?|lotion|liniment|spray|foam|paint|patch)\b/i.test(details)) {
      families.add('topical');
    }
    if (/\b(?:eye|ophth(?:almic)?|ocular)\b/i.test(details)) {
      families.add('ophthalmic');
    }
    if (/\b(?:ear|otic|aural)\b/i.test(details)) {
      families.add('otic');
    }
    if (/\b(?:nasal|intranasal)\b/i.test(details)) {
      families.add('nasal');
    }
    if (/\b(?:inhal(?:ation|er)?|neb(?:uliser|ulized|ulised)?|respules?)\b/i.test(details)) {
      families.add('inhalation');
    }
  }

  return families;
};

const inferAskDrugRouteFamilies = (entry: AskDrugEntry): Set<AskDrugFormulationFamily> => {
  const families = new Set<AskDrugFormulationFamily>();
  const text = compactField(
    [
      entry.indications_and_dose,
      entry.directions_for_administration,
      entry.indications_and_dose_structured?.raw_text,
    ]
      .filter(Boolean)
      .join(' '),
  ) || '';

  if (!text) return families;

  if (/\bBY MOUTH\b/i.test(text)) families.add('oral');
  if (/\b(?:INTRAMUSCULAR|INTRAVENOUS|SUBCUTANEOUS)\b/i.test(text) || /\b(?:INJECTION|INFUSION)\b/i.test(text)) {
    families.add('injection');
  }
  if (/\b(?:BY RECTUM|RECTAL)\b/i.test(text)) families.add('rectal');
  if (/\b(?:TO THE SKIN|TOPICAL(?:LY)?)\b/i.test(text)) families.add('topical');
  if (/\b(?:TO THE EYE|OPHTHALMIC|OCULAR)\b/i.test(text)) families.add('ophthalmic');
  if (/\b(?:TO THE NOSE|INTRANASAL|NASAL)\b/i.test(text)) families.add('nasal');
  if (/\b(?:TO THE EAR|OTIC|AURAL)\b/i.test(text)) families.add('otic');
  if (/\b(?:INHALATION|INHALED|NEBULISED|NEBULIZED)\b/i.test(text)) families.add('inhalation');

  return families;
};

const logAskDrugDebugRawText = (
  title: string,
  pages: number[],
  rawText?: string | null,
): void => {
  const compactRawText = compactField(rawText);
  if (!compactRawText) return;

  console.log(
    `[ASK DRUG CONTEXT] DEBUG RAW TEXT | title=${title} | pages=${pages.join(', ')} | ${compactRawText}`,
  );
};

const uniqueStrings = (values: string[]): string[] =>
  values.filter((value, index, array) => array.indexOf(value) === index);

const getSingularPluralVariants = (term: string): string[] => {
  const normalized = normalizeText(term);
  if (!normalized || normalized.includes(' ')) {
    return normalized ? [normalized] : [];
  }

  const variants = new Set<string>([normalized]);

  if (normalized.endsWith('ies') && normalized.length > 3) {
    variants.add(`${normalized.slice(0, -3)}y`);
  } else if (normalized.endsWith('es') && normalized.length > 3) {
    variants.add(normalized.slice(0, -2));
  } else if (normalized.endsWith('s') && normalized.length > 2) {
    variants.add(normalized.slice(0, -1));
  } else {
    variants.add(`${normalized}s`);
  }

  return Array.from(variants).filter(Boolean);
};

const expandBroadIndicationTerms = (terms: string[]): string[] => {
  const expanded: string[] = [];

  for (const term of terms) {
    const normalized = normalizeText(term);
    if (!normalized) continue;

    const seedTerms = getSingularPluralVariants(normalized);
    expanded.push(...seedTerms);

    for (const seed of seedTerms) {
      const direct = ASK_DRUG_BROAD_TERM_EXPANSIONS[seed];
      if (direct) {
        expanded.push(...direct);
        continue;
      }

      for (const [key, values] of Object.entries(ASK_DRUG_BROAD_TERM_EXPANSIONS)) {
        if (seed.includes(key) || key.includes(seed)) {
          expanded.push(...values);
        }
      }
    }
  }

  return uniqueStrings(expanded.map((term) => normalizeText(term)).filter(Boolean));
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
    throw new Error('Ask drug parser did not return valid JSON');
  }
};

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

const logFullPromptText = (label: string, text: string): void => {
  const chunkCount = Math.max(1, Math.ceil(text.length / ASK_DRUG_PROMPT_LOG_CHUNK_SIZE));
  console.log(`${label}[META]`, {
    length: text.length,
    chunkSize: ASK_DRUG_PROMPT_LOG_CHUNK_SIZE,
    chunkCount,
  });

  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * ASK_DRUG_PROMPT_LOG_CHUNK_SIZE;
    const end = start + ASK_DRUG_PROMPT_LOG_CHUNK_SIZE;
    console.log(`${label}[CHUNK ${index + 1}/${chunkCount}]`, text.slice(start, end));
  }
};

const ASK_DRUG_ROUTE_PATTERNS = [
  /^BY\s+[A-Z]/i,
  /^INITIALLY\s+BY\s+[A-Z]/i,
  /^TO\s+THE\s+[A-Z]/i,
  /^VIA\s+[A-Z]/i,
  /^FOR\s+[A-Z].*\bADMINISTRATION\b/i,
  /^(?:APPLIED|INSTILLED|INSERTED|INHALED)\b/i,
];
const ASK_DRUG_DOSE_GROUP_PATTERN =
  /^(?:Adult|Child|Elderly|Neonate|Infant|Adolescent|Young person|All ages?)(?:\b|[\s(0-9-])/i;
const ASK_DRUG_NOTE_PATTERN =
  /(?:UNLICENSED USE\b|Not licensed\b|In children\s+[A-Z]|In adults?\s+[A-Z]|Cautionary and advisory labels\b)/i;
const ASK_DRUG_SINGLE_WORD_INDICATIONS = new Set([
  'pain',
  'pyrexia',
  'fever',
  'migraine',
  'angina',
  'asthma',
  'anxiety',
  'depression',
  'constipation',
  'diarrhoea',
  'diarrhea',
  'vomiting',
  'nausea',
  'epilepsy',
  'hypertension',
  'hypotension',
  'anaphylaxis',
  'malaria',
  'insomnia',
  'schizophrenia',
]);

const looksLikeRouteSegment = (value: string): boolean =>
  ASK_DRUG_ROUTE_PATTERNS.some((pattern) => pattern.test(compactField(value) || ''));

const looksLikeNoteSegment = (value: string): boolean => {
  const compact = compactField(value) || '';
  if (!compact) return false;
  const cleaned = compact.replace(/^[lg]\s+/i, '');
  return ASK_DRUG_NOTE_PATTERN.test(cleaned);
};

const looksLikeDoseInstructionSegment = (value: string): boolean => {
  const compact = compactField(value) || '';
  if (!compact.includes(':')) return false;
  const label = compactField(compact.slice(0, compact.indexOf(':'))) || '';
  return ASK_DRUG_DOSE_GROUP_PATTERN.test(label);
};

const looksLikeDoseText = (value: string): boolean =>
  /\d/.test(value) ||
  /\b(?:mg|g|micrograms?|mcg|ml|kg|hours?|dose|doses|daily|required|minutes?|day)\b/i.test(value);

const looksLikeIndicationText = (value: string): boolean => {
  const compact = compactField(value) || '';
  if (!compact) return false;
  if (looksLikeRouteSegment(compact) || looksLikeNoteSegment(compact) || looksLikeDoseInstructionSegment(compact)) {
    return false;
  }
  if (compact.includes(':')) return false;
  if (!/[A-Za-z]/.test(compact)) return false;
  const words = compact.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return true;
  if (words.length !== 1) return false;
  return ASK_DRUG_SINGLE_WORD_INDICATIONS.has(normalizeText(compact));
};

const stripParentheticalText = (value: string): string =>
  compactField(value.replace(/\([^)]*\)/g, ' ')) || '';

const getIndicationCandidateScore = (value: string): number => {
  const compact = compactField(value) || '';
  if (!looksLikeIndicationText(compact)) {
    return Number.NEGATIVE_INFINITY;
  }

  const scoreText = stripParentheticalText(compact) || compact;
  const words = scoreText.split(/\s+/).filter(Boolean);
  const internalCapitalizedWords = words
    .slice(1)
    .filter((word) => /^[A-Z][a-z]/.test(word.replace(/^[("']+/, ''))).length;

  let score = 0;
  if (!/\d/.test(scoreText)) score += 5;
  if (words.length >= 2 && words.length <= 12) {
    score += 5;
  } else if (words.length <= 18) {
    score += 2;
  } else {
    score -= Math.min(8, words.length - 18);
  }
  score -= internalCapitalizedWords * 3;

  return score;
};

const normalizeRecoveredIndicationCandidate = (value: string): string => {
  const compact = compactField(value) || '';
  if (!compact) return '';

  const withoutLeadingPageNumber = compact.replace(/^\d{1,4}\s+/, '');
  const candidateStarts = [0];
  const boundaryPattern = /\s+(?=[A-Z])/g;
  let match: RegExpExecArray | null;

  while ((match = boundaryPattern.exec(withoutLeadingPageNumber)) !== null) {
    candidateStarts.push(match.index);
  }

  let bestCandidate = withoutLeadingPageNumber;
  let bestScore = getIndicationCandidateScore(withoutLeadingPageNumber);

  for (const start of candidateStarts) {
    const candidate = compactField(withoutLeadingPageNumber.slice(start)) || '';
    const score = getIndicationCandidateScore(candidate);
    if (score > bestScore) {
      bestCandidate = candidate;
      bestScore = score;
    }
  }

  return compactField(bestCandidate) || '';
};

const cleanStructuredNote = (value: string): string | null => {
  const compact = compactField(value.replace(/^[lg]\s+/i, '').replace(/\s+[lg]$/i, '')) || '';
  return compact || null;
};

const cleanStructuredDoseText = (value: string): string | null => {
  const compact =
    compactField(
      value
        .replace(/\s+[lg]$/i, '')
        .replace(/\s+[lg](?=[,.;:]?$)/i, '')
        .replace(/[|;:,.\s-]+$/g, ''),
    ) || '';
  return compact || null;
};

const splitStructuredNotes = (value: string): { main: string; notes: string[] } => {
  const compact = compactField(value) || '';
  if (!compact) {
    return { main: '', notes: [] };
  }

  const marker = compact.match(
    /\b(?:UNLICENSED USE|Not licensed|In children\s+[A-Z]|In adults?\s+[A-Z])\b/i,
  );
  if (marker?.index === undefined) {
    return { main: compact, notes: [] };
  }

  const noteStart = marker.index;
  const main = cleanStructuredDoseText(compact.slice(0, noteStart)) || '';
  const noteBlock = compact
    .slice(noteStart)
    .replace(
      /\s+[lg]\s+(?=(?:UNLICENSED USE|Not licensed|In children\s+[A-Z]|In adults?\s+[A-Z])\b)/gi,
      '\n',
    );
  const notes = noteBlock
    .split(/\n+|(?<=[.])\s+(?=(?:UNLICENSED USE|Not licensed|In children\s+[A-Z]|In adults?\s+[A-Z])\b)/i)
    .map((note) => cleanStructuredNote(note))
    .filter((note): note is string => Boolean(note));

  for (let index = 0; index < notes.length - 1; index += 1) {
    if (/^In children\b|^In adults?\b/i.test(notes[index]) && /^not licensed\b/.test(notes[index + 1])) {
      notes[index] = `${notes[index]} ${notes[index + 1]}`.trim();
      notes.splice(index + 1, 1);
      index -= 1;
    }
  }

  return { main, notes };
};

const splitTrailingIndication = (
  value: string,
  nextSegmentIsRoute: boolean,
): { main: string; trailingIndication?: string } => {
  const compact = compactField(value) || '';
  if (!compact || !nextSegmentIsRoute) {
    return { main: compact };
  }

  const boundaryPattern = /\s+(?=[A-Z])/g;
  let match: RegExpExecArray | null;
  let bestSplit: { main: string; trailingIndication: string; score: number } | null = null;

  while ((match = boundaryPattern.exec(compact)) !== null) {
    const boundaryIndex = match.index;
    const prefix = compactField(compact.slice(0, boundaryIndex)) || '';
    const suffix = normalizeRecoveredIndicationCandidate(compact.slice(boundaryIndex));
    const suffixWithoutParentheses = stripParentheticalText(suffix);

    if (!prefix || !suffix) continue;
    if (!looksLikeDoseText(prefix)) continue;
    if (!looksLikeIndicationText(suffix)) continue;
    if (
      /\b(?:mg|g|micrograms?|mcg|ml|kg|hours?|dose|doses|daily|required|minutes?|day)\b/i.test(
        suffixWithoutParentheses,
      )
    ) {
      continue;
    }

    const candidateScore = getIndicationCandidateScore(suffix);
    if (!Number.isFinite(candidateScore)) continue;
    if (!bestSplit || candidateScore >= bestSplit.score) {
      bestSplit = {
        main: prefix,
        trailingIndication: suffix,
        score: candidateScore,
      };
    }
  }

  if (bestSplit) {
    return {
      main: bestSplit.main,
      trailingIndication: bestSplit.trailingIndication,
    };
  }

  return { main: compact };
};

const parseDoseInstructionSegment = (
  value: string,
  nextSegment?: string,
): {
  instruction: AskDrugDoseInstruction | null;
  trailingIndication?: string;
  notes: string[];
} => {
  const compact = compactField(value) || '';
  if (!looksLikeDoseInstructionSegment(compact)) {
    return { instruction: null, notes: [] };
  }

  const colonIndex = compact.indexOf(':');
  const group = compactField(compact.slice(0, colonIndex)) || '';
  const afterColon = compactField(compact.slice(colonIndex + 1)) || '';
  const splitNotes = splitStructuredNotes(afterColon);
  const splitIndication = splitTrailingIndication(
    splitNotes.main,
    looksLikeRouteSegment(nextSegment || ''),
  );

  return {
    instruction: cleanStructuredDoseText(splitIndication.main)
      ? {
          group,
          text: cleanStructuredDoseText(splitIndication.main) || splitIndication.main,
        }
      : null,
    trailingIndication: splitIndication.trailingIndication,
    notes: splitNotes.notes,
  };
};

const parseIndicationsAndDoseStructured = (
  value?: string | null,
): AskDrugIndicationsAndDoseStructured | null => {
  const rawText = compactField(value);
  if (!rawText) return null;

  const segments = rawText
    .split(/\s*▶\s*/)
    .map((segment) => compactField(segment))
    .filter((segment): segment is string => Boolean(segment));

  const indications: AskDrugDoseIndication[] = [];
  const notes: string[] = [];
  let currentIndication: AskDrugDoseIndication | null = null;
  let currentRoute: AskDrugDoseRoute | null = null;

  const pushNote = (note: string | null | undefined): void => {
    if (!note) return;
    if (!notes.includes(note)) notes.push(note);
  };

  const startIndication = (text: string): AskDrugDoseIndication | null => {
    const cleaned = compactField(text);
    if (!cleaned || !looksLikeIndicationText(cleaned)) return null;

    currentIndication = {
      indication: cleaned,
      routes: [],
    };
    indications.push(currentIndication);
    currentRoute = null;
    return currentIndication;
  };

  const startRoute = (text: string): AskDrugDoseRoute | null => {
    if (!currentIndication) return null;
    currentRoute = {
      route: compactField(text) || text,
      instructions: [],
    };
    currentIndication.routes.push(currentRoute);
    return currentRoute;
  };

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];

    if (looksLikeRouteSegment(segment)) {
      startRoute(segment);
      continue;
    }

    const parsedInstruction = parseDoseInstructionSegment(segment, nextSegment);
    const activeRoute = currentRoute as AskDrugDoseRoute | null;
    if (parsedInstruction.instruction && activeRoute) {
      activeRoute.instructions.push(parsedInstruction.instruction);
      parsedInstruction.notes.forEach(pushNote);
      if (parsedInstruction.trailingIndication) {
        startIndication(parsedInstruction.trailingIndication);
      }
      continue;
    }

    if (looksLikeNoteSegment(segment)) {
      const splitNotes = splitStructuredNotes(segment);
      pushNote(cleanStructuredNote(splitNotes.main));
      splitNotes.notes.forEach(pushNote);
      currentRoute = null;
      continue;
    }

    if (looksLikeIndicationText(segment)) {
      startIndication(segment);
      continue;
    }

    const splitNotes = splitStructuredNotes(segment);
    const appendRoute = currentRoute as AskDrugDoseRoute | null;
    if (splitNotes.main && appendRoute && appendRoute.instructions.length > 0) {
      const lastInstruction = appendRoute.instructions[appendRoute.instructions.length - 1];
      lastInstruction.text = `${lastInstruction.text} ${splitNotes.main}`.trim();
    } else {
      pushNote(cleanStructuredNote(splitNotes.main));
    }
    splitNotes.notes.forEach(pushNote);
  }

  if (indications.length === 0 && notes.length === 0) {
    return null;
  }

  return {
    indications: indications.filter((item) => item.routes.length > 0),
    notes,
    raw_text: rawText,
  };
};

type AskDrugFallbackUsedSection = {
  requestedSection: string;
  title: string;
  body: string;
};

const normalizeRequestedSection = (
  value: string,
): AskDrugRequestedSection | 'safety_bundle' | null => {
  const normalized = normalizeText(value)
    .replace(/\s+/g, '_')
    .replace(/__+/g, '_');

  switch (normalized) {
    case 'all_details':
    case 'details':
    case 'detail':
    case 'full_details':
    case 'full_detail':
    case 'everything':
    case 'all_information':
    case 'full_information':
    case 'complete_details':
      return 'all_details';
    case 'indications':
    case 'indication':
    case 'dose':
    case 'dosing':
    case 'indications_and_dose':
      return 'indications_and_dose';
    case 'contraindication':
    case 'contraindications':
    case 'contra_indication':
    case 'contra_indications':
      return 'contra_indications';
    case 'side_effect':
    case 'side_effects':
      return 'side_effects';
    case 'renal':
    case 'renal_dose':
    case 'renal_impairment':
      return 'renal_impairment';
    case 'pregnancy':
    case 'pregnancy_dose':
      return 'pregnancy';
    case 'breastfeeding':
    case 'breast_feeding':
    case 'breastfeeding_dose':
      return 'breast_feeding';
    case 'hepatic':
    case 'hepatic_dose':
    case 'hepatic_impairment':
      return 'hepatic_impairment';
    case 'safety':
    case 'safety_information':
      return 'safety_bundle';
    default:
      return ASK_DRUG_ALLOWED_QUERY_SECTIONS.has(normalized as AskDrugSectionKey)
        ? (normalized as AskDrugSectionKey)
        : null;
  }
};

const expandSections = (sections: AskDrugSectionKey[]): AskDrugSectionKey[] => {
  const expanded: AskDrugSectionKey[] = [];
  for (const section of sections) {
    if (section === 'important_safety_information') {
      expanded.push(...ASK_DRUG_SAFETY_BUNDLE);
    } else {
      expanded.push(section);
    }
  }
  return Array.from(new Set(expanded));
};

const expandRequestedSections = (
  sections: AskDrugRequestedSection[],
): AskDrugSectionKey[] => {
  if (sections.includes('all_details')) {
    return ASK_DRUG_ALL_DETAILS_SECTIONS;
  }

  return expandSections(sections as AskDrugSectionKey[]);
};

const sectionLabel = (section: AskDrugSectionKey): string => {
  switch (section) {
    case 'indications_and_dose':
      return 'Indications and dose';
    case 'important_safety_information':
      return 'Important safety information';
    case 'contra_indications':
      return 'Contra-indications';
    case 'cautions':
      return 'Cautions';
    case 'cautions_further_information':
      return 'Cautions, further information';
    case 'interactions':
      return 'Interactions';
    case 'side_effects':
      return 'Side-effects';
    case 'pregnancy':
      return 'Pregnancy';
    case 'breast_feeding':
      return 'Breast feeding';
    case 'hepatic_impairment':
      return 'Hepatic impairment';
    case 'renal_impairment':
      return 'Renal impairment';
    case 'treatment_cessation':
      return 'Treatment cessation';
    case 'directions_for_administration':
      return 'Directions for administration';
    case 'prescribing_and_dispensing_information':
      return 'Prescribing and dispensing information';
    case 'patient_and_carer_advice':
      return 'Patient and carer advice';
    default:
      return section;
  }
};

const formatSimpleSentence = (value: string): string =>
  value
    .replace(/\s+\./g, '.')
    .replace(/\s+/g, ' ')
    .replace(/^[,;:.()\[\]\s-]+/, '')
    .replace(/[,;:.()\[\]\s-]+$/, '')
    .trim()
    .replace(/^([a-z])/, (_, firstLetter: string) => firstLetter.toUpperCase());

const splitSimpleSentenceItems = (value: string): string[] =>
  value
    .split(/\s*(?:\.(?=\s|$)|;(?=\s|$))\s*/)
    .map(formatSimpleSentence)
    .filter(Boolean);

const normalizeAllDetailsSectionBody = (value: string): string =>
  compactField(value.replace(/\s*▶\s*/g, '\n- ').replace(/\s*→\s*/g, '\n- ')) || value;

export class AskDrugModeService {
  private indexedDBServices = getIndexedDBServices();

  private enrichCatalog(catalog: AskDrugCatalog): AskDrugCatalog {
    return {
      ...catalog,
      drugs: catalog.drugs.map((entry) => ({
        ...entry,
        indications_and_dose_structured:
          entry.indications_and_dose_structured ??
          parseIndicationsAndDoseStructured(entry.indications_and_dose),
      })),
    };
  }

  private validateCatalog(data: unknown): AskDrugCatalog {
    if (!data || typeof data !== 'object') {
      throw new Error('Ask drug dataset is missing or invalid');
    }

    const catalog = data as Partial<AskDrugCatalog>;
    if (catalog.format_version !== 'drug-sections-catalog-1.0') {
      throw new Error('Unsupported ask drug dataset format');
    }
    if (!Array.isArray(catalog.drugs)) {
      throw new Error('Ask drug dataset entries are missing');
    }
    return this.enrichCatalog(catalog as AskDrugCatalog);
  }

  private makeRecord(catalog: AskDrugCatalog): DrugDatasetRecord {
    return {
      id: ASK_DRUG_DATASET_CONFIG.id,
      name: ASK_DRUG_DATASET_CONFIG.name,
      filename: ASK_DRUG_DATASET_CONFIG.filename,
      size: ASK_DRUG_DATASET_CONFIG.size,
      downloadedAt: new Date().toISOString(),
      catalog,
    };
  }

  async ensureDatasetReady(forceRefresh = false): Promise<AskDrugCatalog> {
    console.log('[ASK DRUG DOWNLOAD]', 'Checking cached dataset', {
      datasetId: ASK_DRUG_DATASET_CONFIG.id,
      filename: ASK_DRUG_DATASET_CONFIG.filename,
      forceRefresh,
    });

    if (!forceRefresh) {
      const cached = await this.indexedDBServices.drugDatasetService.getDataset(
        ASK_DRUG_DATASET_CONFIG.id,
      );
      if (cached?.catalog) {
        const catalog = this.validateCatalog(cached.catalog);
        console.log('[ASK DRUG DOWNLOAD]', 'Cache hit', {
          datasetId: cached.id,
          downloadedAt: cached.downloadedAt,
          entryCount: catalog.drugs.length,
        });
        return catalog;
      }
    }

    console.log('[ASK DRUG DOWNLOAD]', 'Downloading dataset from Hugging Face', {
      datasetId: ASK_DRUG_DATASET_CONFIG.id,
      filename: ASK_DRUG_DATASET_CONFIG.filename,
    });

    const downloaded = await libraryService.downloadAndParseBook(
      ASK_DRUG_DATASET_CONFIG.filename,
    );
    const catalog = this.validateCatalog(downloaded);

    await this.indexedDBServices.drugDatasetService.saveDataset(this.makeRecord(catalog));

    console.log('[ASK DRUG DOWNLOAD]', 'Dataset cached successfully', {
      datasetId: ASK_DRUG_DATASET_CONFIG.id,
      entryCount: catalog.drugs.length,
    });

    return catalog;
  }

  private async parseQuery(content: string): Promise<AskDrugQueryParseResult> {
    const systemPrompt = `Extract a structured ask-drug query from the user's message.
Return ONLY valid JSON with this exact shape:
{
  "drug_name": "Paracetamol",
  "sections": ["indications_and_dose"],
  "indication_terms": ["pain"],
  "confidence": 0.98
}

Rules:
- If the user clearly names a specific generic drug, preserve that exact generic drug name in drug_name.
- Do not shorten, simplify, or strip qualifiers from a generic drug name the user explicitly typed.
- Do not remove words such as "sodium", "hydrochloride", "tartrate", "phosphate", or similar qualifiers when they are part of the user’s drug name.
- Extract the drug name; do not normalize it to a broader parent name.
- If there is no drug name, return an empty string.
- Allowed section values are only:
  "all_details",
  "indications_and_dose",
  "contra_indications",
  "side_effects",
  "renal_impairment",
  "pregnancy",
  "breast_feeding",
  "hepatic_impairment",
  "important_safety_information"
- "Indications" implies "indications_and_dose".
- "Safety information" implies "important_safety_information".
- Queries like "details about paracetamol", "full details of paracetamol", "everything about paracetamol", or "tell me about paracetamol" should use ["all_details"] when the user wants the full drug entry.
- For broad treatment questions without a named drug, extract indication_terms from the clinical intent.
- Include close clinical synonyms and related medical terms for broad symptom queries when helpful.
- Examples:
  - "details about paracetamol" -> drug_name "Paracetamol", sections ["all_details"], indication_terms []
  - "indications and side effects of paracetamol" -> drug_name "Paracetamol", sections ["indications_and_dose", "side_effects"], indication_terms []
  - "indications of diclofenac sodium" -> drug_name "Diclofenac sodium", sections ["indications_and_dose"], indication_terms []
  - "dose of amiloride hydrochloride" -> drug_name "Amiloride hydrochloride", sections ["indications_and_dose"], indication_terms []
  - "drugs for vomiting" -> ["vomiting", "nausea", "emesis"]
  - "treatment of fever" -> ["fever", "pyrexia", "febrile"]
  - "drugs for itching" -> ["itching", "pruritus"]
  - "drugs for breathlessness" -> ["breathlessness", "dyspnoea", "shortness of breath"]
  - "drugs for cough" -> ["cough"]
- Use only close clinical synonyms, not broad related concepts.
- If the user names a drug but does not name a section, default sections to ["indications_and_dose"].
- Do not include any text outside JSON.`;

    console.log('[ASK DRUG PARSER PROMPT][SYSTEM]', systemPrompt);
    console.log('[ASK DRUG PARSER PROMPT][USER]', content);

    const raw = await groqService.generateResponse(
      content,
      systemPrompt,
      ASK_DRUG_QUERY_PARSER_MODEL,
      {
        temperature: 0,
        maxTokens: 700,
      },
    );

    console.log('[ASK DRUG PARSER]', 'Raw parser output', raw);

    const parsed = extractJsonObject<{
      drug_name?: string;
      sections?: string[];
      indication_terms?: string[];
      confidence?: number;
    }>(raw);

    const mappedSections = Array.from(
      new Set(
        (Array.isArray(parsed.sections) ? parsed.sections : [])
          .map((value) => normalizeRequestedSection(String(value)))
          .flatMap((value) => {
            if (value === 'safety_bundle') return ['important_safety_information'] as AskDrugSectionKey[];
            return value ? [value] : [];
          }),
      ),
    );

    const parserDrugName = sanitizeParsedDrugName(String(parsed.drug_name || '').trim());
    const inferredDrugName = inferDrugNameFromRawQuery(content);
    const resolvedDrugName = parserDrugName || inferredDrugName;
    const normalizedContent = normalizeText(content);
    const wantsAllDetails =
      /(?:^|\b)(details|detail|everything|full details|full detail|full information|complete details)\b/.test(normalizedContent) &&
      Boolean(resolvedDrugName);

    return {
      drug_name: canonicalizeTitleCase(resolvedDrugName),
      sections:
        wantsAllDetails
          ? ['all_details']
          : mappedSections.length > 0
            ? mappedSections
            : ['indications_and_dose'],
      indication_terms: expandBroadIndicationTerms(
        (Array.isArray(parsed.indication_terms) ? parsed.indication_terms : [])
          .map((term) => normalizeText(String(term)))
          .filter(Boolean),
      ),
      confidence:
        typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0,
    };
  }

  private scoreDrugTitle(query: string, candidate: string): number {
    const normalizedQuery = normalizeCompact(query);
    const normalizedCandidate = normalizeCompact(candidate);
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

  private scoreNamedDrugCandidate(
    query: string,
    entry: AskDrugEntry,
    brandPreparations: ParsedProprietaryPreparation[] = [],
  ): number {
    let score = this.scoreDrugTitle(query, entry.title);
    if (!Number.isFinite(score)) return score;

    const brandFamilies = inferBrandFormulationFamilies(brandPreparations);
    const candidateFamilies = inferAskDrugRouteFamilies(entry);

    if (brandFamilies.size > 0 && candidateFamilies.size > 0) {
      const overlapCount = Array.from(brandFamilies).filter((family) => candidateFamilies.has(family)).length;
      const missingBrandFamilyCount = Array.from(brandFamilies).filter(
        (family) => !candidateFamilies.has(family),
      ).length;
      if (overlapCount > 0) {
        score += overlapCount * 220;
        score -= missingBrandFamilyCount * 180;
      } else {
        score -= 260;
      }
    }

    if (hasStructuredIndicationsAndDose(entry.indications_and_dose_structured)) {
      score += 25;
    }

    return score;
  }

  private resolveNamedDrug(
    catalog: AskDrugCatalog,
    parsed: AskDrugQueryParseResult,
    options?: {
      brandPreparations?: ParsedProprietaryPreparation[];
    },
  ): AskDrugEntry | null {
    const query = parsed.drug_name.trim();
    if (!query) return null;

    const exactMatches = catalog.drugs.filter(
      (entry) => normalizeCompact(entry.title) === normalizeCompact(query),
    );
    if (exactMatches.length === 1) return exactMatches[0];
    if (exactMatches.length > 1) {
      const rankedExactMatches = exactMatches
        .map((entry) => ({
          entry,
          score: this.scoreNamedDrugCandidate(query, entry, options?.brandPreparations),
          routeFamilies: Array.from(inferAskDrugRouteFamilies(entry)),
        }))
        .sort((left, right) => right.score - left.score);

      console.log('[ASK DRUG LOOKUP]', 'Resolved duplicate exact-title entries', {
        query,
        brandFormulationFamilies: Array.from(inferBrandFormulationFamilies(options?.brandPreparations)),
        candidates: rankedExactMatches.map((candidate) => ({
          title: candidate.entry.title,
          pages: candidate.entry.pages,
          score: candidate.score,
          routeFamilies: candidate.routeFamilies,
        })),
      });

      return rankedExactMatches[0]?.entry ?? null;
    }

    const ranked = catalog.drugs
      .map((entry) => ({
        entry,
        score: this.scoreNamedDrugCandidate(query, entry, options?.brandPreparations),
      }))
      .filter((candidate) => candidate.score >= 120)
      .sort((left, right) => right.score - left.score);

    return ranked[0]?.entry ?? null;
  }

  private resolveNamedDrugByCandidates(
    catalog: AskDrugCatalog,
    parsed: AskDrugQueryParseResult,
    candidateDrugNames: string[],
    options?: {
      brandPreparations?: ParsedProprietaryPreparation[];
    },
  ): { match: AskDrugEntry | null; matchedDrugName: string | null; matchedScore: number } {
    const queries = uniqueStrings(
      candidateDrugNames
        .map((value) => canonicalizeTitleCase(compactField(value) || ''))
        .filter(Boolean),
    );

    let bestMatch: AskDrugEntry | null = null;
    let bestMatchedDrugName: string | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const query of queries) {
      const match = this.resolveNamedDrug(
        catalog,
        {
          ...parsed,
          drug_name: query,
        },
        options,
      );
      if (match) {
        const score = this.scoreNamedDrugCandidate(query, match, options?.brandPreparations);
        if (score > bestScore) {
          bestMatch = match;
          bestMatchedDrugName = query;
          bestScore = score;
        }
      }
    }

    return {
      match: bestMatch,
      matchedDrugName: bestMatchedDrugName,
      matchedScore: bestScore,
    };
  }

  private resolveNamedDrugConservatively(
    catalog: AskDrugCatalog,
    query: string,
    options?: {
      brandPreparations?: ParsedProprietaryPreparation[];
    },
  ): AskDrugEntry | null {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return null;

    const ranked = catalog.drugs
      .map((entry) => ({
        entry,
        score: this.scoreNamedDrugCandidate(trimmedQuery, entry, options?.brandPreparations),
      }))
      .filter((candidate) => candidate.score >= 120)
      .sort((left, right) => right.score - left.score);

    const top = ranked[0];
    if (!top) return null;

    const next = ranked[1];
    const queryTokens = new Set(toDrugCoreTokens(trimmedQuery));
    const candidateTokens = new Set(toDrugCoreTokens(top.entry.title));
    const overlapCount = Array.from(queryTokens).filter((token) => candidateTokens.has(token)).length;
    const hasPrefixOverlap = Array.from(queryTokens).some((queryToken) =>
      Array.from(candidateTokens).some(
        (candidateToken) =>
          queryToken.startsWith(candidateToken) || candidateToken.startsWith(queryToken),
      ),
    );
    const scoreGap = top.score - (next?.score ?? Number.NEGATIVE_INFINITY);

    if (queryTokens.size === 0 || candidateTokens.size === 0) {
      return null;
    }

    if (overlapCount > 0) {
      return top.entry;
    }

    if (hasPrefixOverlap && top.score >= 220 && scoreGap >= 80) {
      return top.entry;
    }

    return null;
  }

  private findExactNamedDrug(
    catalog: AskDrugCatalog,
    drugName: string,
  ): AskDrugEntry | null {
    const query = normalizeCompact(drugName);
    if (!query) return null;

    const matches = catalog.drugs.filter((entry) => normalizeCompact(entry.title) === query);

    if (matches.length === 0) return null;
    return matches[0] ?? null;
  }

  private buildSuggestions(catalog: AskDrugCatalog, query: string): string[] {
    return catalog.drugs
      .map((entry) => ({
        title: entry.title,
        score: this.scoreDrugTitle(query, entry.title),
      }))
      .filter((candidate) => candidate.score >= 120)
      .sort((left, right) => right.score - left.score)
      .slice(0, ASK_DRUG_SUGGESTION_LIMIT)
      .map((candidate) => candidate.title);
  }

  private async buildFallbackSuggestions(
    catalog: AskDrugCatalog,
    query: string,
  ): Promise<string[]> {
    const seed = query.trim();
    if (!seed) return [];

    const [brandSuggestions, catalogSuggestions] = await Promise.all([
      drugModeService.buildSpellingSuggestions(seed),
      Promise.resolve(this.buildSuggestions(catalog, seed)),
    ]);

    return uniqueStrings([...brandSuggestions, ...catalogSuggestions]).slice(0, ASK_DRUG_SUGGESTION_LIMIT);
  }

  private getSectionText(entry: AskDrugEntry, section: AskDrugSectionKey): string | null {
    const value = entry[section];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private buildNamedContext(entry: AskDrugEntry, sections: AskDrugSectionKey[]): AskDrugPromptEntry {
    const structuredIndicationsAndDose =
      sections.includes('indications_and_dose') &&
      hasStructuredIndicationsAndDose(entry.indications_and_dose_structured)
        ? entry.indications_and_dose_structured
        : undefined;

    if (structuredIndicationsAndDose) {
      logAskDrugDebugRawText(
        entry.title,
        entry.pages,
        structuredIndicationsAndDose.raw_text,
      );
    }

    const relevantSections = sections.reduce<Partial<Record<AskDrugSectionKey, string>>>((acc, section) => {
      if (section === 'indications_and_dose' && structuredIndicationsAndDose) {
        return acc;
      }
      const text = this.getSectionText(entry, section);
      if (text) acc[section] = text;
      return acc;
    }, {});

    return {
      title: entry.title,
      pages: entry.pages,
      sections: relevantSections,
      indications_and_dose_structured: structuredIndicationsAndDose
        ? sanitizeStructuredIndicationsAndDoseForPrompt(structuredIndicationsAndDose)
        : undefined,
    };
  }

  private extractIndicationsOnly(entry: AskDrugEntry): string[] {
    if (hasStructuredIndicationsAndDose(entry.indications_and_dose_structured)) {
      return uniqueStrings(entry.indications_and_dose_structured.indications.map((item) => item.indication));
    }

    const raw = this.getSectionText(entry, 'indications_and_dose');
    return raw ? this.extractIndicationCandidatesFromSection(raw) : [];
  }

  private extractContraindicationBullets(entry: AskDrugEntry): string[] {
    const raw = this.getSectionText(entry, 'contra_indications');
    return raw ? splitSimpleSentenceItems(raw) : [];
  }

  private formatAllDetailsSection(
    entry: AskDrugEntry,
    section: AskDrugSectionKey,
  ): { title: string; body: string } | null {
    if (section === 'indications_and_dose') {
      const indications = this.extractIndicationsOnly(entry);
      if (indications.length === 0) return null;
      return {
        title: '✅ Indications',
        body: indications.map((indication) => `- ${indication}`).join('\n'),
      };
    }

    if (section === 'contra_indications') {
      const items = this.extractContraindicationBullets(entry);
      if (items.length === 0) return null;
      return {
        title: '❌ Contra-indications',
        body: items.map((item) => `- ${item}`).join('\n'),
      };
    }

    const text = this.getSectionText(entry, section);
    if (!text) return null;

    return {
      title: sectionLabel(section),
      body: normalizeAllDetailsSectionBody(text),
    };
  }

  private async formatNamedAllDetailsSupplementalSections(
    entry: AskDrugEntry,
    content: string,
  ): Promise<string> {
    const supplementalSections = ASK_DRUG_ALL_DETAILS_SECTIONS.filter(
      (section) => section !== 'indications_and_dose' && section !== 'contra_indications',
    );
    const promptContext = this.buildNamedContext(entry, supplementalSections);
    if (!hasPromptEntryContent(promptContext)) {
      return '';
    }

    const prompt = `User question:
${content}

Resolved drug:
${entry.title}

Requested sections:
${supplementalSections.map(sectionLabel).join(', ')}

Requested response format:
all_details_supplemental_sections

Dataset context:
${JSON.stringify(promptContext, null, 2)}`;

    const systemPrompt = `${ASK_DRUG_SYSTEM_PROMPT}\n\n${ASK_DRUG_ALL_DETAILS_FORMAT_PROMPT}`;

    logFullPromptText('[ASK DRUG ANSWER PROMPT][SYSTEM]', systemPrompt);
    logFullPromptText('[ASK DRUG ANSWER PROMPT][USER]', prompt);

    let fullResponse = '';
    await groqService.generateStreamingResponse(
      prompt,
      systemPrompt,
      ASK_DRUG_ANSWER_MODEL,
      {
        temperature: 0.1,
        maxTokens: 1600,
        maxFailoverRetries: 2,
        retryBackoffMs: 300,
        onChunk: (chunk) => {
          fullResponse += chunk;
        },
      },
    );

    return fullResponse.trim();
  }

  private async buildNamedAllDetailsAnswer(
    entry: AskDrugEntry,
    displayTitle: string,
    content: string,
    fallbackGenericName?: string | null,
    originalDrugName?: string,
  ): Promise<string> {
    const deterministicSections = ASK_DRUG_ALL_DETAILS_SECTIONS
      .filter((section) => section === 'indications_and_dose' || section === 'contra_indications')
      .map((section) => this.formatAllDetailsSection(entry, section))
      .filter((section): section is { title: string; body: string } => Boolean(section));
    const supplementalSections = await this.formatNamedAllDetailsSupplementalSections(entry, content);

    const lines = [`## ${displayTitle}`];

    if (fallbackGenericName && originalDrugName) {
      lines.push(
        '',
        `Resolved via brand-to-generic fallback:`,
        `${originalDrugName} -> ${fallbackGenericName}`,
      );
    }

    if (deterministicSections.length === 0 && !supplementalSections) {
      lines.push('', 'No detailed drug information was found in this dataset entry.');
      return lines.join('\n').trim();
    }

    for (const section of deterministicSections) {
      lines.push('', `### ${section.title}`, '', section.body);
    }

    if (supplementalSections) {
      lines.push('', supplementalSections);
    }

    return lines.join('\n').trim();
  }

  private buildDrugModeFallbackDisplayTitle(
    entry: DrugEntry,
    originalDrugName: string,
  ): string {
    const resolvedGenericName = drugModeService.getResolvedGenericName(entry);
    return normalizeCompact(originalDrugName) === normalizeCompact(resolvedGenericName)
      ? resolvedGenericName
      : `${resolvedGenericName} (${originalDrugName})`;
  }

  private getDrugModeFallbackSection(
    entry: DrugEntry,
    section: AskDrugSectionKey,
  ): { title: string; body: string } | null {
    switch (section) {
      case 'indications_and_dose': {
        const indications = compactField(entry.indications);
        const dose = compactField(entry.dose);
        if (!indications && !dose) return null;

        const lines: string[] = [];
        if (indications) lines.push(`- Indications: ${indications}`);
        if (dose) lines.push(`- ✨ Dose : ${dose}`);

        return {
          title: sectionLabel(section),
          body: lines.join('\n'),
        };
      }
      case 'contra_indications': {
        const contraindications = compactField(entry.contraindications);
        if (!contraindications) return null;
        return {
          title: sectionLabel(section),
          body: `- ${contraindications}`,
        };
      }
      case 'side_effects': {
        const sideEffects = compactField(entry.side_effects);
        if (!sideEffects) return null;
        return {
          title: sectionLabel(section),
          body: `- ${sideEffects}`,
        };
      }
      default:
        return null;
    }
  }

  private buildDrugModeAllDetailsFallbackSections(
    entry: DrugEntry,
  ): Array<{ title: string; body: string }> {
    const sections: Array<{ title: string; body: string }> = [];

    const indicationsAndDose = this.getDrugModeFallbackSection(entry, 'indications_and_dose');
    if (indicationsAndDose) sections.push(indicationsAndDose);

    const cautions = compactField(entry.cautions);
    if (cautions) {
      sections.push({
        title: 'Cautions',
        body: `- ${cautions}`,
      });
    }

    const contraindications = this.getDrugModeFallbackSection(entry, 'contra_indications');
    if (contraindications) sections.push(contraindications);

    const sideEffects = this.getDrugModeFallbackSection(entry, 'side_effects');
    if (sideEffects) sections.push(sideEffects);

    const interactions = compactField(entry.interactions);
    if (interactions) {
      sections.push({
        title: 'Interactions',
        body: `- ${interactions}`,
      });
    }

    return sections;
  }

  private buildDrugModeFallbackPayload(
    entry: DrugEntry,
    parsed: AskDrugQueryParseResult,
    requestedSections: AskDrugSectionKey[],
    originalDrugName: string,
  ): {
    displayTitle: string;
    warning: string;
    requestedSectionKeys: AskDrugRequestedSection[];
    requestedSectionLabels: string[];
    usedSections: AskDrugFallbackUsedSection[];
    answer: string;
  } | null {
    const displayTitle = this.buildDrugModeFallbackDisplayTitle(entry, originalDrugName);
    const warning =
      '⚠️ British National Pharmacopoeia data not found, using regional information';

    const usedSections: AskDrugFallbackUsedSection[] = [];
    if (parsed.sections.includes('all_details')) {
      this.buildDrugModeAllDetailsFallbackSections(entry).forEach((section) => {
        usedSections.push({
          requestedSection: 'all_details',
          title: section.title,
          body: section.body,
        });
      });
    } else {
      requestedSections.forEach((section) => {
        const fallbackSection = this.getDrugModeFallbackSection(entry, section);
        if (!fallbackSection) return;
        usedSections.push({
          requestedSection: section,
          title: fallbackSection.title,
          body: fallbackSection.body,
        });
      });
    }

    if (usedSections.length === 0) {
      return null;
    }

    const answer = [
      `## ${displayTitle}`,
      '',
      warning,
      '',
      ...usedSections.flatMap((section) => [`### ${section.title}`, '', section.body, '']),
    ]
      .join('\n')
      .trim();

    return {
      displayTitle,
      warning,
      requestedSectionKeys: parsed.sections,
      requestedSectionLabels: parsed.sections.includes('all_details')
        ? ['All available sections']
        : requestedSections.map(sectionLabel),
      usedSections,
      answer,
    };
  }

  private buildDrugModeFallbackAnswer(
    entry: DrugEntry,
    parsed: AskDrugQueryParseResult,
    requestedSections: AskDrugSectionKey[],
    originalDrugName: string,
  ): string | null {
    return (
      this.buildDrugModeFallbackPayload(entry, parsed, requestedSections, originalDrugName)?.answer ||
      null
    );
  }

  async lookupIndicationsAndDoseByDrugName(
    drugName: string,
    options?: {
      catalog?: AskDrugCatalog;
      brandPreparations?: ParsedProprietaryPreparation[];
    },
  ): Promise<{
    title: string;
    pages: number[];
    indications_and_dose: string;
    indications_and_dose_structured?: AskDrugIndicationsAndDoseStructured;
    contra_indications?: string;
  } | null> {
    const query = canonicalizeTitleCase(drugName.trim());
    if (!query) return null;

    const activeCatalog = options?.catalog ?? (await this.ensureDatasetReady());
    const candidateQueries = buildAskDrugNameCandidates(query);

    let bestMatch: AskDrugEntry | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidateQuery of candidateQueries) {
      const exactMatch = this.findExactNamedDrug(activeCatalog, candidateQuery);
      if (exactMatch) {
        const exactScore = this.scoreNamedDrugCandidate(
          candidateQuery,
          exactMatch,
          options?.brandPreparations,
        );
        if (exactScore > bestScore) {
          bestMatch = exactMatch;
          bestScore = exactScore;
        }
      }

      const conservativeMatch = this.resolveNamedDrugConservatively(activeCatalog, candidateQuery, {
        brandPreparations: options?.brandPreparations,
      });
      if (conservativeMatch) {
        const conservativeScore = this.scoreNamedDrugCandidate(
          candidateQuery,
          conservativeMatch,
          options?.brandPreparations,
        );
        if (conservativeScore > bestScore) {
          bestMatch = conservativeMatch;
          bestScore = conservativeScore;
        }
      }
    }

    const match = bestMatch;
    if (!match) return null;

    const indicationsAndDose = this.getSectionText(match, 'indications_and_dose');
    if (!indicationsAndDose) return null;
    const contraIndications = this.getSectionText(match, 'contra_indications');

    return {
      title: match.title,
      pages: match.pages,
      indications_and_dose: indicationsAndDose,
      indications_and_dose_structured: match.indications_and_dose_structured || undefined,
      contra_indications: contraIndications || undefined,
    };
  }

  private shouldRenderIndicationsSummaryPlusDose(
    parsed: AskDrugQueryParseResult,
    requestedSections: AskDrugSectionKey[],
  ): boolean {
    if (parsed.sections.includes('all_details')) return false;
    return requestedSections.length === 1 && requestedSections[0] === 'indications_and_dose';
  }

  private cleanMatchedIndicationLabel(value: string): string | null {
    let cleaned = compactField(value) || '';
    if (!cleaned) return null;

    const trailingFromMax = cleaned.match(/(?:Usual\s+)?maximum\s+\d[^A-Z]*([A-Z].*)$/);
    if (trailingFromMax?.[1]) {
      cleaned = compactField(trailingFromMax[1]) || cleaned;
    }

    cleaned = cleaned
      .replace(/^(?:and|or)\s+/i, '')
      .replace(/^[,;:.()\[\]\s-]+/, '')
      .replace(/[,;:.()\[\]\s-]+$/, '')
      .trim();

    const shouldPreferTrailingTitle =
      /^\d/.test(cleaned) ||
      /^[a-z]/.test(cleaned) ||
      /\b(?:mg|g|micrograms?|mcg|ml|hours?|minutes?|daily|times a day|dose|doses)\b/i.test(cleaned);

    if (shouldPreferTrailingTitle) {
      const trailingTitleMatch = cleaned.match(
        /([A-Z][A-Za-z][A-Za-z0-9()[\],;/'’\- ]*[A-Za-z)])$/,
      );
      if (trailingTitleMatch?.[1]) {
        cleaned = trailingTitleMatch[1].trim();
      }
    }

    if (!cleaned) return null;
    if (/^(Adult|Child|Elderly|Neonate|Infant|Adolescent)\b/i.test(cleaned)) return null;
    if (/^(BY|Oral|Injection|Infusion|Rectal|Subcutaneous|Intramuscular)\b/i.test(cleaned)) return null;
    if (/\b\d+\s*(mg|g|microgram|mcg|ml)\b/i.test(cleaned) && !/[A-Za-z].*\b(pain|pyrexia|cough|infection|ulcer|oedema|disorder|syndrome|disease)\b/i.test(cleaned)) {
      return null;
    }

    return cleaned;
  }

  private extractIndicationCandidatesFromSection(text: string): string[] {
    const compact = compactField(text) || '';
    if (!compact) return [];

    const candidates: string[] = [];
    const pattern =
      /(?:^|▶\s*(?:Adult|Child|Elderly|Neonate|Infant|Adolescent|Young person)[^▶]{0,700}?)([^▶]{1,320}?)(?=\s*▶\s*BY\b)/gi;

    for (const match of compact.matchAll(pattern)) {
      const rawSegment = compactField(match[1] || '');
      if (!rawSegment) continue;

      for (const part of rawSegment.split(/\s+\|\s+/)) {
        const cleaned = this.cleanMatchedIndicationLabel(part);
        if (cleaned) {
          candidates.push(cleaned);
        }
      }
    }

    return uniqueStrings(candidates);
  }

  private extractMatchedIndicationsFromSection(text: string, terms: string[]): string[] {
    if (terms.length === 0) return [];

    const candidates = this.extractIndicationCandidatesFromSection(text);
    const rankedMatches = candidates
      .map((candidate) => ({
        label: candidate,
        score: this.scoreSectionText(candidate, terms),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);

    return uniqueStrings(rankedMatches.map((candidate) => candidate.label));
  }

  private findBroadIndicationMatches(
    catalog: AskDrugCatalog,
    terms: string[],
  ): AskDrugBroadMatch[] {
    if (terms.length === 0) return [];

    return catalog.drugs
      .map((entry) => {
        const indicationText = this.getSectionText(entry, 'indications_and_dose');
        if (!indicationText) {
          return { entry, matchedSections: {}, score: 0 };
        }

        const matchedIndications = this.extractMatchedIndicationsFromSection(
          indicationText,
          terms,
        );

        if (matchedIndications.length === 0) {
          return { entry, matchedSections: {}, score: 0 };
        }

        const matchedSectionText = matchedIndications.join('\n');
        const score =
          this.scoreSectionText(matchedSectionText, terms) + matchedIndications.length * 10;

        return {
          entry,
          matchedSections: {
            indications_and_dose: matchedSectionText,
          },
          score,
        };
      })
      .filter((match) => match.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, ASK_DRUG_MATCH_LIMIT);
  }

  private scoreSectionText(text: string, terms: string[]): number {
    const normalizedText = normalizeText(text);
    if (!normalizedText) return 0;

    const tokens = new Set(tokenize(text));
    let score = 0;

    for (const term of terms) {
      const normalizedTerm = normalizeText(term);
      if (!normalizedTerm) continue;

      if (normalizedText.includes(normalizedTerm)) {
        score += 80;
      }

      for (const token of tokenize(normalizedTerm)) {
        if (tokens.has(token)) {
          score += 20;
        }
      }
    }

    return score;
  }

  private findBroadMatches(
    catalog: AskDrugCatalog,
    sections: AskDrugSectionKey[],
    terms: string[],
  ): AskDrugBroadMatch[] {
    if (terms.length === 0) return [];

    return catalog.drugs
      .map((entry) => {
        const matchedSections: Partial<Record<AskDrugSectionKey, string>> = {};
        let score = 0;

        for (const section of sections) {
          const text = this.getSectionText(entry, section);
          if (!text) continue;

          const sectionScore = this.scoreSectionText(text, terms);
          if (sectionScore > 0) {
            matchedSections[section] = text;
            score += sectionScore;
          }
        }

        return { entry, matchedSections, score };
      })
      .filter((match) => match.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, ASK_DRUG_MATCH_LIMIT);
  }

  private buildBroadContext(matches: AskDrugBroadMatch[]): AskDrugPromptEntry[] {
    return matches.map((match) => {
      const structuredIndicationsAndDose = hasStructuredIndicationsAndDose(
        match.entry.indications_and_dose_structured,
      )
        ? match.entry.indications_and_dose_structured
        : undefined;
      const sections = structuredIndicationsAndDose
        ? Object.fromEntries(
            Object.entries(match.matchedSections).filter(
              ([section]) => section !== 'indications_and_dose',
            ),
          ) as Partial<Record<AskDrugSectionKey, string>>
        : match.matchedSections;

      if (structuredIndicationsAndDose) {
        logAskDrugDebugRawText(
          match.entry.title,
          match.entry.pages,
          structuredIndicationsAndDose.raw_text,
        );
      }

      return {
        title: match.entry.title,
        pages: match.entry.pages,
        sections,
        indications_and_dose_structured: structuredIndicationsAndDose
          ? sanitizeStructuredIndicationsAndDoseForPrompt(structuredIndicationsAndDose)
          : undefined,
      };
    });
  }

  private buildBroadIndicationContext(
    matches: AskDrugBroadMatch[],
  ): AskDrugBroadIndicationPromptEntry[] {
    return matches.map((match) => ({
      title: match.entry.title,
      pages: match.entry.pages,
      matched_indications: uniqueStrings(
        (match.matchedSections.indications_and_dose || '')
          .split(/\n+/)
          .map((value) => value.trim())
          .filter(Boolean) || [],
      ),
    }));
  }

  private buildNoMatchMessage(parsed: AskDrugQueryParseResult, suggestions: string[]): string {
    const unmatched = parsed.drug_name.trim();
    if (!unmatched) {
      return 'I could not find matching drugs in the ask-drug dataset for that request.';
    }
    if (suggestions.length === 0) {
      return `I could not find a matching drug entry for: ${unmatched}. Please check the spelling or use the exact generic name.`;
    }
    return `I could not find a matching drug entry for: ${unmatched}. Did you mean: ${suggestions.join(', ')}?`;
  }

  private async saveAssistantMessage(sessionId: string, content: string): Promise<void> {
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

  async sendMessage(
    sessionId: string,
    content: string,
    onStreamEvent?: (event: ChatStreamEvent) => void,
  ): Promise<void> {
    console.log('[ASK DRUG MODE]', 'Starting ask-drug pipeline', {
      sessionId,
      query: content,
    });

    try {
      onStreamEvent?.({ type: 'status', message: 'Drug Dataset' });
      const catalog = await this.ensureDatasetReady();

      onStreamEvent?.({ type: 'status', message: 'Ask Drug Query Parsing' });
      const parsed = await this.parseQuery(content);
      const requestedSections = expandRequestedSections(parsed.sections);
      const requestedSectionSummary = parsed.sections.includes('all_details')
        ? 'All available sections'
        : requestedSections.map(sectionLabel).join(', ');

      console.log('[ASK DRUG PARSER]', 'Parsed query JSON', parsed);

      if (parsed.drug_name.trim()) {
        onStreamEvent?.({ type: 'status', message: 'Ask Drug Search' });
        const fallbackEntry = await drugModeService.findDrugEntryByName(parsed.drug_name);
        const fallbackGenericName = fallbackEntry
          ? drugModeService.getResolvedGenericName(fallbackEntry)
          : null;
        const fallbackBrandPreparations = fallbackEntry
          ? drugModeService.getFilteredBrandEntries(fallbackEntry, 12)
          : [];
        const candidateDrugNames = buildAskDrugNameCandidates(
          parsed.drug_name,
          fallbackGenericName,
        );
        const { match, matchedDrugName } = this.resolveNamedDrugByCandidates(
          catalog,
          parsed,
          candidateDrugNames,
          {
            brandPreparations: fallbackBrandPreparations,
          },
        );

        if (fallbackGenericName) {
          console.log('[ASK DRUG FALLBACK]', 'Resolved named query through drug mode dataset first', {
            originalDrugName: parsed.drug_name,
            fallbackGenericName,
            brandFormulationFamilies: Array.from(inferBrandFormulationFamilies(fallbackBrandPreparations)),
            attemptedAskDrugNames: candidateDrugNames,
            matchedAskDrugQuery: matchedDrugName,
            matchedAskDrugTitle: match?.title ?? null,
          });
        }

        if (!match && !fallbackEntry) {
          const suggestions = await this.buildFallbackSuggestions(catalog, parsed.drug_name);
          const noMatchMessage = this.buildNoMatchMessage(parsed, suggestions);
          if (suggestions.length > 0) {
            onStreamEvent?.({ type: 'suggestions', suggestions });
          }
          await this.saveAssistantMessage(sessionId, noMatchMessage);
          onStreamEvent?.({ type: 'done', content: noMatchMessage });
          return;
        }

        if (!match && fallbackEntry) {
          const fallbackPayload = this.buildDrugModeFallbackPayload(
            fallbackEntry,
            parsed,
            requestedSections,
            parsed.drug_name,
          );
          if (fallbackPayload) {
            console.log('[ASK DRUG FALLBACK][PAYLOAD]', {
              originalDrugName: parsed.drug_name,
              resolvedGenericName: fallbackGenericName,
              requestedSectionKeys: fallbackPayload.requestedSectionKeys,
              requestedSectionLabels: fallbackPayload.requestedSectionLabels,
              usedSections: fallbackPayload.usedSections,
              fullFallbackAnswer: fallbackPayload.answer,
            });
          } else {
            console.log('[ASK DRUG FALLBACK][PAYLOAD]', {
              originalDrugName: parsed.drug_name,
              resolvedGenericName: fallbackGenericName,
              requestedSectionKeys: parsed.sections,
              requestedSectionLabels: requestedSectionSummary,
              usedSections: [],
              fullFallbackAnswer: null,
            });
          }
          const fallbackAnswer = fallbackPayload?.answer || null;
          const noDataMessage =
            fallbackAnswer ||
            'Sorry, the drug information is not in our database, please search online.';
          await this.saveAssistantMessage(sessionId, noDataMessage);
          onStreamEvent?.({ type: 'done', content: noDataMessage });
          return;
        }

        const promptContext = this.buildNamedContext(match!, requestedSections);
        if (!hasPromptEntryContent(promptContext)) {
          if (fallbackEntry) {
            const fallbackPayload = this.buildDrugModeFallbackPayload(
              fallbackEntry,
              parsed,
              requestedSections,
              parsed.drug_name,
            );
            if (fallbackPayload) {
              console.log('[ASK DRUG FALLBACK][PAYLOAD]', {
                originalDrugName: parsed.drug_name,
                resolvedGenericName: fallbackGenericName,
                requestedSectionKeys: fallbackPayload.requestedSectionKeys,
                requestedSectionLabels: fallbackPayload.requestedSectionLabels,
                usedSections: fallbackPayload.usedSections,
                fullFallbackAnswer: fallbackPayload.answer,
              });
            } else {
              console.log('[ASK DRUG FALLBACK][PAYLOAD]', {
                originalDrugName: parsed.drug_name,
                resolvedGenericName: fallbackGenericName,
                requestedSectionKeys: parsed.sections,
                requestedSectionLabels: requestedSectionSummary,
                usedSections: [],
                fullFallbackAnswer: null,
              });
            }
            const fallbackAnswer = fallbackPayload?.answer || null;
            const noDataMessage =
              fallbackAnswer ||
              'Sorry, the drug information is not in our database, please search online.';
            await this.saveAssistantMessage(sessionId, noDataMessage);
            onStreamEvent?.({ type: 'done', content: noDataMessage });
            return;
          }

          const noDataMessage = `I found ${match!.title}, but the requested section is not present in this dataset entry.`;
          await this.saveAssistantMessage(sessionId, noDataMessage);
          onStreamEvent?.({ type: 'done', content: noDataMessage });
          return;
        }

        if (parsed.sections.includes('all_details')) {
          onStreamEvent?.({ type: 'status', message: 'Ask Drug Answer Generation' });

          const deterministicAllDetails = await this.buildNamedAllDetailsAnswer(
            match!,
            fallbackGenericName ? `${match!.title} (${parsed.drug_name})` : match!.title,
            content,
            fallbackGenericName,
            parsed.drug_name,
          );
          const decoratedAllDetails = deterministicAllDetails;
          await this.saveAssistantMessage(sessionId, decoratedAllDetails);
          onStreamEvent?.({ type: 'done', content: decoratedAllDetails });
          return;
        }

        const requestedResponseFormat = this.shouldRenderIndicationsSummaryPlusDose(parsed, requestedSections)
          ? 'indications_summary_plus_dose'
          : 'standard';
        const displayTitle = fallbackGenericName
          ? `${match!.title} (${parsed.drug_name})`
          : match!.title;

        const prompt = `User question:
${content}

Resolved drug:
${match!.title}

Display title:
${displayTitle}

${fallbackGenericName ? `Resolved via brand-to-generic fallback:\n${parsed.drug_name} -> ${fallbackGenericName}\n` : ''}

Requested sections:
${requestedSectionSummary}

Requested response format:
${requestedResponseFormat}

Dataset context:
${JSON.stringify(promptContext, null, 2)}`;

        const namedSystemPrompt = `${ASK_DRUG_SYSTEM_PROMPT}\n\n${ASK_DRUG_INDICATIONS_ONLY_FORMAT_PROMPT}`;

        logFullPromptText('[ASK DRUG ANSWER PROMPT][SYSTEM]', namedSystemPrompt);
        logFullPromptText('[ASK DRUG ANSWER PROMPT][USER]', prompt);

        onStreamEvent?.({ type: 'status', message: 'Ask Drug Answer Generation' });

        let fullResponse = '';
        await groqService.generateStreamingResponse(
          prompt,
          namedSystemPrompt,
          ASK_DRUG_ANSWER_MODEL,
          {
            temperature: 0.1,
            maxTokens: 1600,
            maxFailoverRetries: 2,
            retryBackoffMs: 300,
            onChunk: (chunk) => {
              fullResponse += chunk;
            },
          },
        );

        const decoratedResponse = shouldDecorateIndicationLinksForQuery(content)
          ? decorateIndicationLinks(fullResponse, parsed.drug_name)
          : fullResponse;
        await this.saveAssistantMessage(sessionId, decoratedResponse);
        onStreamEvent?.({ type: 'done', content: decoratedResponse });
        return;
      }

      if (parsed.indication_terms.length === 0) {
        const whatIsTarget = extractWhatIsQueryTarget(content);
        if (!parsed.drug_name.trim() && whatIsTarget) {
          console.log('[ASK DRUG FALLBACK]', 'Redirecting unparsed what-is style query to drug mode', {
            originalQuery: content,
            extractedTarget: whatIsTarget,
          });
          await drugModeService.sendMessage(sessionId, content, onStreamEvent);
          return;
        }

        const noIntentMessage =
          'Please mention what you want to know, for example indications, side-effects, renal dose, pregnancy advice, or a condition such as pain or cough.';
        await this.saveAssistantMessage(sessionId, noIntentMessage);
        onStreamEvent?.({ type: 'done', content: noIntentMessage });
        return;
      }

      const broadSections = requestedSections.filter((section) =>
        ASK_DRUG_ALL_SEARCHABLE_SECTIONS.includes(section),
      );

      onStreamEvent?.({ type: 'status', message: 'Ask Drug Search' });
      const shouldUseIndicationOnlyBroadSearch =
        broadSections.length === 1 && broadSections[0] === 'indications_and_dose';
      const matches = shouldUseIndicationOnlyBroadSearch
        ? this.findBroadIndicationMatches(catalog, parsed.indication_terms)
        : this.findBroadMatches(catalog, broadSections, parsed.indication_terms);

      if (matches.length === 0) {
        const suggestionSeed = parsed.drug_name.trim() || parsed.indication_terms.join(' ') || content;
        const suggestions = await this.buildFallbackSuggestions(catalog, suggestionSeed);
        const noBroadMatchMessage =
          'I could not find matching drugs in this dataset for that condition or section request.';
        if (suggestions.length > 0) {
          onStreamEvent?.({ type: 'suggestions', suggestions });
        }
        await this.saveAssistantMessage(sessionId, noBroadMatchMessage);
        onStreamEvent?.({ type: 'done', content: noBroadMatchMessage });
        return;
      }

      const prompt = `User question:
${content}

Requested sections:
${broadSections.map(sectionLabel).join(', ')}

Indication terms:
${parsed.indication_terms.join(', ')}

Matched dataset context:
${JSON.stringify(
  shouldUseIndicationOnlyBroadSearch
    ? this.buildBroadIndicationContext(matches)
    : this.buildBroadContext(matches),
  null,
  2,
)}`;

      const broadSystemPrompt = shouldUseIndicationOnlyBroadSearch
        ? ASK_DRUG_BROAD_INDICATION_SYSTEM_PROMPT
        : ASK_DRUG_SYSTEM_PROMPT;

      logFullPromptText('[ASK DRUG ANSWER PROMPT][SYSTEM]', broadSystemPrompt);
      logFullPromptText('[ASK DRUG ANSWER PROMPT][USER]', prompt);

      onStreamEvent?.({ type: 'status', message: 'Ask Drug Answer Generation' });

      let fullResponse = '';
      await groqService.generateStreamingResponse(
        prompt,
        broadSystemPrompt,
        ASK_DRUG_ANSWER_MODEL,
        {
          temperature: 0.1,
          maxTokens: 1600,
          maxFailoverRetries: 2,
          retryBackoffMs: 300,
          onChunk: (chunk) => {
            fullResponse += chunk;
          },
        },
      );

      const decoratedResponse = shouldDecorateIndicationLinksForQuery(content)
        ? decorateIndicationLinks(fullResponse, parsed.drug_name)
        : fullResponse;
      await this.saveAssistantMessage(sessionId, decoratedResponse);
      onStreamEvent?.({ type: 'done', content: decoratedResponse });
    } catch (error) {
      console.error('[ASK DRUG ERROR]', error);
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Ask drug mode failed to process the request';

      onStreamEvent?.({
        type: 'error',
        message: errorMessage,
      });

      throw error instanceof Error ? error : new Error(errorMessage);
    }
  }
}

export const askDrugModeService = new AskDrugModeService();
