import { groqService } from '@/services/groq/groqService';
import { getIndexedDBServices } from '@/services/indexedDB';
import { libraryService } from '@/services/libraryService';
import type {
  DrugCatalog,
  DrugDatasetConfig,
  DrugDatasetRecord,
  DrugEntry,
  DrugQueryParseResult,
  MessageCreate,
} from '@/types';
import { MessageSender } from '@/types/message';
import type { ChatStreamEvent } from '@/services/rag';

const DRUG_QUERY_PARSER_MODEL = 'llama-3.3-70b-versatile';
const DRUG_ANSWER_MODEL = 'moonshotai/kimi-k2-instruct-0905';
const DRUG_PROMPT_LOG_CHUNK_SIZE = 4000;
const DRUG_NAME_DENYLIST = new Set(['ACE', 'FDA', 'KN.VDN', 'CNS']);
const VERIFIED_DRUG_NAMES_URL = '/drug/verified-drug-names.txt';
const DRUG_SUGGESTION_LIMIT = 5;

export const DRUG_DATASET_CONFIG: DrugDatasetConfig = {
  id: 'newdoc_voyage',
  name: 'BD prescription',
  filename: 'shard_4g1.bin',
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

const isPlausibleDrugName = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^\d+$/.test(trimmed)) return false;
  return /[A-Za-z]/.test(trimmed);
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

const stringifyEntryForPrompt = (entry: DrugEntry): string =>
  JSON.stringify(
    {
      drug_name: entry.drug_name,
      aliases: entry.aliases,
      pages: entry.pages,
      indications: compactField(entry.indications),
      cautions: compactField(entry.cautions),
      contraindications: compactField(entry.contraindications),
      side_effects: compactField(entry.side_effects),
      dose: compactField(entry.dose),
      notes: compactField(entry.notes),
      proprietary_preparations: compactField(entry.proprietary_preparations),
    },
    null,
    2,
  );

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

const DRUG_MODE_SYSTEM_PROMPT_TEMPLATE = `For this question :
All the brand names (this and alternate) with dosing schedule for the drug for each indication separately according to drug formulation, and indication with price data for the DRUG : {{DRUG_NAME}} (which is taken from the output of query parser)

[ie; all brands of the generic drug in the context]
[prioritize these brand names, Square, Incepta, Healthcare, Opsosin, Beximco, Aristopharma]
[Avoid duplication - if dosing is calculated for same form, and same strength ot one brand, NO need to give dosing for another brands of same dose and strength]

[IMPORTANT : Dosing information is usually given in this format : 🔴 You have to CALULATE the DOSING SCHDULE form the dosing Information below like this BASED on the DRUG dose and form (tab, or injfeciton or syrp etc) - YOU have to calculate it)
Example :
Dose:by mouth in benign gastric ulcer or
gastroesophageal reflux disease, 40 mg
daily in the morning for 4 weeks,
followed by further 4 weeks if not fully
healed.
Duodenal ulcer or gastritis associated
with H. pylori, 40 mg twice daily (with
clarithromycin 250mg twice daily and
metronidazole 400mg twice daily) for 7
days.CHILD not recommended



Formatting rule :
Your output should look like this

{{DRUG_NAME}} - Generic : Pantoprazole (header)
Brands and dose (header)

TABLET

Tab. Pantonix 20 mg - Incepta
1 + 0 + 1 -  [1/2 hour before meals] - For gastric ulcer
1 + 1 + 1  -  [1/2 hour before meals] - For GERD
Price : 20 tk / tab

Tab. Pantonix 40 mg - Incepta
1 + 0 + 0 -  [1/2 hour before meals] - For gastric ulcer
1 + 0 + 0  -  [1/2 hour before meals] - For GERD
Price : 40 tk / tab

Tab. Esonix 20 mg  - Square [NO dosing info reqruied because same strengh drug dosing 20 mg tab already given above]
Price : 33 tk / tab

Tab Genova 40 mg - Opsonin
Price : 20 tk / tab

INJECTION (be mindful of IV or IM Or SC)


Inj. Pantonix 40 mg - Inception
1 vial IV 12 hourly - For gastric ulcer
1 vial IV 8 hourly - For PUD
Price : 120 tk / vial

And so on ..

Similarly all other formulation and brand names

[ALL answers should be in bullet point and neatly formatted]`;

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
        console.log('[DRUG DOWNLOAD]', 'Cache hit', {
          datasetId: cached.id,
          downloadedAt: cached.downloadedAt,
          entryCount: cached.catalog.entries.length,
        });
        return cached.catalog;
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
                .filter((line) => isPlausibleDrugName(line)),
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

  private entryHasExactCaseSensitiveMatch(entry: DrugEntry, query: string): boolean {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return false;

    if (entry.drug_name.trim() === trimmedQuery) return true;
    if (entry.aliases.some((alias) => alias.trim() === trimmedQuery)) return true;
    if (hasExactPhraseMatch(entry.proprietary_preparations || '', trimmedQuery)) return true;

    return false;
  }

  private entryHasExactNormalizedMatch(entry: DrugEntry, query: string): boolean {
    const normalizedQuery = normalizeDrugLookupText(query);
    if (!normalizedQuery) return false;

    if (normalizeDrugLookupText(entry.drug_name) === normalizedQuery) return true;
    if (entry.aliases.some((alias) => normalizeDrugLookupText(alias) === normalizedQuery)) {
      return true;
    }
    if (normalizeDrugLookupText(entry.proprietary_preparations || '').includes(normalizedQuery)) {
      return true;
    }

    return false;
  }

  private findTopExactMatch(
    catalog: DrugCatalog,
    parsed: DrugQueryParseResult,
  ): DrugEntry | null {
    const query = parsed.drug_name.trim();
    if (!query) return null;

    const searchableEntries = catalog.entries.filter((entry) => {
      return !DRUG_NAME_DENYLIST.has(entry.drug_name.trim().toUpperCase());
    });

    const strictMatches = searchableEntries.filter((entry) =>
      this.entryHasExactCaseSensitiveMatch(entry, query),
    );

    const preferredStrictMatches = strictMatches.filter((entry) => entry.pages.length <= 2);
    const normalizedMatches =
      strictMatches.length > 0
        ? []
        : searchableEntries.filter((entry) => this.entryHasExactNormalizedMatch(entry, query));
    const preferredNormalizedMatches = normalizedMatches.filter(
      (entry) => entry.pages.length <= 2,
    );
    const finalMatch =
      preferredStrictMatches[0] ??
      strictMatches[0] ??
      preferredNormalizedMatches[0] ??
      normalizedMatches[0] ??
      null;

    console.log('[DRUG SEARCH]', 'Direct case-sensitive lookup', {
      query,
      confidence: parsed.confidence,
      strictCandidateCount: strictMatches.length,
      preferredStrictCandidateCount: preferredStrictMatches.length,
      normalizedCandidateCount: normalizedMatches.length,
      preferredNormalizedCandidateCount: preferredNormalizedMatches.length,
      selectedMatch: finalMatch
        ? {
            drug_name: finalMatch.drug_name,
            aliases: finalMatch.aliases,
            pages: finalMatch.pages,
          }
        : null,
      topCandidates: [...preferredStrictMatches, ...strictMatches, ...preferredNormalizedMatches, ...normalizedMatches]
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

  private buildDrugAnswerSystemPrompt(drugName: string): string {
    return DRUG_MODE_SYSTEM_PROMPT_TEMPLATE.split('{{DRUG_NAME}}').join(drugName);
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

      onStreamEvent?.({
        type: 'status',
        message: 'Drug Search',
      });
      const match = this.findTopExactMatch(catalog, parsed);

      console.log('[DRUG SEARCH]', 'Final matched entries', {
        requestedDrug: parsed.drug_name,
        matchedEntry: match?.drug_name ?? null,
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

      onStreamEvent?.({
        type: 'status',
        message: 'Drug Answer Generation',
      });

      const prompt = `User question:
${content}

Extracted drug name:
${parsed.drug_name}

Matched drug entry:
${stringifyEntryForPrompt(match)}`;

      const systemPrompt = this.buildDrugAnswerSystemPrompt(parsed.drug_name.trim());

      logFullPromptText('[DRUG ANSWER PROMPT][SYSTEM]', systemPrompt);
      logFullPromptText('[DRUG ANSWER PROMPT][USER]', prompt);

      let fullResponse = '';
      await groqService.generateStreamingResponse(
        prompt,
        systemPrompt,
        DRUG_ANSWER_MODEL,
        {
          temperature: 0.2,
          maxTokens: 1800,
          maxFailoverRetries: 2,
          retryBackoffMs: 300,
          onChunk: (chunk) => {
            fullResponse += chunk;
          },
        },
      );

      console.log('[DRUG ANSWER]', 'Answer generation complete', {
        matchedEntryCount: 1,
        responseLength: fullResponse.length,
      });

      await this.saveAssistantMessage(sessionId, fullResponse);
      onStreamEvent?.({
        type: 'done',
        content: fullResponse,
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
