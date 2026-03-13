import { groqService } from '@/services/groq/groqService';
import { getIndexedDBServices } from '@/services/indexedDB';
import { libraryService } from '@/services/libraryService';
import type {
  AskDrugBroadMatch,
  AskDrugCatalog,
  AskDrugEntry,
  AskDrugQueryParseResult,
  AskDrugSectionKey,
  DrugDatasetConfig,
  DrugDatasetRecord,
  MessageCreate,
} from '@/types';
import { MessageSender } from '@/types/message';
import type { ChatStreamEvent } from '@/services/rag';

const ASK_DRUG_QUERY_PARSER_MODEL = 'llama-3.3-70b-versatile';
const ASK_DRUG_ANSWER_MODEL = 'moonshotai/kimi-k2-instruct-0905';
const ASK_DRUG_PROMPT_LOG_CHUNK_SIZE = 4000;
const ASK_DRUG_MATCH_LIMIT = 15;
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
};

const ASK_DRUG_SYSTEM_PROMPT = `You answer drug questions using ONLY the provided dataset context.

Rules:
- Do not use outside knowledge.
- If the context is missing or insufficient, say that clearly.
- If the question is about one named drug, answer only from that drug entry.
- If the question is broad, compare only the matched drugs provided in context.
- Prefer short headings and bullet points.
- Preserve important safety wording when summarising.
- Never invent doses, contraindications, pregnancy advice, renal advice, or side-effects that are not in context.`;

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

const tokenize = (value: string): string[] =>
  normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length > 1);

const compactField = (value?: string | null): string | undefined => {
  if (!value) return undefined;
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact || undefined;
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

const normalizeRequestedSection = (value: string): AskDrugSectionKey | 'safety_bundle' | null => {
  const normalized = normalizeText(value)
    .replace(/\s+/g, '_')
    .replace(/__+/g, '_');

  switch (normalized) {
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

export class AskDrugModeService {
  private indexedDBServices = getIndexedDBServices();

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
    return catalog as AskDrugCatalog;
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
- drug_name should be generic if the user clearly asks about a specific generic drug.
- If there is no drug name, return an empty string.
- Allowed section values are only:
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
- For broad treatment questions without a named drug, extract indication_terms from the clinical intent, such as "pain", "pyrexia", "cough".
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

    return {
      drug_name: canonicalizeTitleCase(String(parsed.drug_name || '').trim()),
      sections: mappedSections.length > 0 ? mappedSections : ['indications_and_dose'],
      indication_terms: Array.from(
        new Set(
          (Array.isArray(parsed.indication_terms) ? parsed.indication_terms : [])
            .map((term) => normalizeText(String(term)))
            .filter(Boolean),
        ),
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

  private resolveNamedDrug(
    catalog: AskDrugCatalog,
    parsed: AskDrugQueryParseResult,
  ): AskDrugEntry | null {
    const query = parsed.drug_name.trim();
    if (!query) return null;

    const exact = catalog.drugs.find(
      (entry) => normalizeCompact(entry.title) === normalizeCompact(query),
    );
    if (exact) return exact;

    const ranked = catalog.drugs
      .map((entry) => ({
        entry,
        score: this.scoreDrugTitle(query, entry.title),
      }))
      .filter((candidate) => candidate.score >= 120)
      .sort((left, right) => right.score - left.score);

    return ranked[0]?.entry ?? null;
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

  private getSectionText(entry: AskDrugEntry, section: AskDrugSectionKey): string | null {
    const value = entry[section];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private buildNamedContext(entry: AskDrugEntry, sections: AskDrugSectionKey[]): AskDrugPromptEntry {
    const relevantSections = sections.reduce<Partial<Record<AskDrugSectionKey, string>>>((acc, section) => {
      const text = this.getSectionText(entry, section);
      if (text) acc[section] = text;
      return acc;
    }, {});

    return {
      title: entry.title,
      pages: entry.pages,
      sections: relevantSections,
    };
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
    return matches.map((match) => ({
      title: match.entry.title,
      pages: match.entry.pages,
      sections: match.matchedSections,
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
      const requestedSections = expandSections(parsed.sections);

      console.log('[ASK DRUG PARSER]', 'Parsed query JSON', parsed);

      if (parsed.drug_name.trim()) {
        onStreamEvent?.({ type: 'status', message: 'Ask Drug Search' });
        const match = this.resolveNamedDrug(catalog, parsed);

        if (!match) {
          const suggestions = this.buildSuggestions(catalog, parsed.drug_name);
          const noMatchMessage = this.buildNoMatchMessage(parsed, suggestions);
          if (suggestions.length > 0) {
            onStreamEvent?.({ type: 'suggestions', suggestions });
          }
          await this.saveAssistantMessage(sessionId, noMatchMessage);
          onStreamEvent?.({ type: 'done', content: noMatchMessage });
          return;
        }

        const promptContext = this.buildNamedContext(match, requestedSections);
        if (Object.keys(promptContext.sections).length === 0) {
          const noDataMessage = `I found ${match.title}, but the requested section is not present in this dataset entry.`;
          await this.saveAssistantMessage(sessionId, noDataMessage);
          onStreamEvent?.({ type: 'done', content: noDataMessage });
          return;
        }

        const prompt = `User question:
${content}

Resolved drug:
${match.title}

Requested sections:
${requestedSections.map(sectionLabel).join(', ')}

Dataset context:
${JSON.stringify(promptContext, null, 2)}`;

        logFullPromptText('[ASK DRUG ANSWER PROMPT][SYSTEM]', ASK_DRUG_SYSTEM_PROMPT);
        logFullPromptText('[ASK DRUG ANSWER PROMPT][USER]', prompt);

        onStreamEvent?.({ type: 'status', message: 'Ask Drug Answer Generation' });

        let fullResponse = '';
        await groqService.generateStreamingResponse(
          prompt,
          ASK_DRUG_SYSTEM_PROMPT,
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

        await this.saveAssistantMessage(sessionId, fullResponse);
        onStreamEvent?.({ type: 'done', content: fullResponse });
        return;
      }

      if (parsed.indication_terms.length === 0) {
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
      const matches = this.findBroadMatches(catalog, broadSections, parsed.indication_terms);

      if (matches.length === 0) {
        const noBroadMatchMessage =
          'I could not find matching drugs in this dataset for that condition or section request.';
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
${JSON.stringify(this.buildBroadContext(matches), null, 2)}`;

      logFullPromptText('[ASK DRUG ANSWER PROMPT][SYSTEM]', ASK_DRUG_SYSTEM_PROMPT);
      logFullPromptText('[ASK DRUG ANSWER PROMPT][USER]', prompt);

      onStreamEvent?.({ type: 'status', message: 'Ask Drug Answer Generation' });

      let fullResponse = '';
      await groqService.generateStreamingResponse(
        prompt,
        ASK_DRUG_SYSTEM_PROMPT,
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

      await this.saveAssistantMessage(sessionId, fullResponse);
      onStreamEvent?.({ type: 'done', content: fullResponse });
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
