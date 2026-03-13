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
const DRUG_TOTAL_MATCH_LIMIT = 3;
const DRUG_SECOND_PASS_LIMIT = 1;
const DRUG_PROMPT_LOG_CHUNK_SIZE = 4000;
const DRUG_NAME_DENYLIST = new Set(['ACE', 'FDA']);
const PREFERRED_DRUG_COMPANIES = [
  'Biopharma',
  'Opsonin',
  'Radiant',
  'Beximco',
  'Square',
  'Incepta',
  'Healthcare',
];

export const DRUG_DATASET_CONFIG: DrugDatasetConfig = {
  id: 'newdoc_voyage',
  name: 'BD prescription',
  filename: 'shard_4g1.bin',
  size: '2.9 MB',
};

const normalizeText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

export class DrugModeService {
  private indexedDBServices = getIndexedDBServices();

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

  private async parseDrugQuery(content: string): Promise<DrugQueryParseResult> {
    const systemPrompt = `You extract drug lookup intents from user questions.
Return ONLY valid JSON with this exact shape:
{
  "intent": "drug_lookup",
  "drugs": [
    {
      "input_name": "original mention from the user",
      "normalized_name": "drug or brand name exactly as written by the user",
      "requested_fields": ["dose", "brand_names"],
      "confidence": 0.98
    }
  ],
  "unmatched_terms": []
}

Rules:
- Do not correct, rewrite, normalize, expand, or autocorrect any drug name or brand name.
- Preserve the drug or brand name exactly as written by the user in normalized_name.
- You may correct obvious spelling mistakes only in the non-drug parts of the query when deciding requested_fields.
- Keep requested_fields short and practical, such as dose, brand_names, indications, cautions, contraindications, side_effects, notes, proprietary_preparations.
- If no drug can be identified, return intent drug_lookup with an empty drugs array.
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
      intent: parsed.intent || 'drug_lookup',
      drugs: Array.isArray(parsed.drugs)
        ? parsed.drugs
          .filter((drug) => drug && typeof drug.normalized_name === 'string')
          .map((drug) => ({
            input_name: String(drug.input_name || drug.normalized_name || ''),
            normalized_name: String(drug.normalized_name || '').trim(),
            requested_fields: Array.isArray(drug.requested_fields)
              ? drug.requested_fields.map((field) => String(field).trim()).filter(Boolean)
              : [],
            confidence:
              typeof drug.confidence === 'number'
                ? Math.max(0, Math.min(1, drug.confidence))
                : 0.5,
          }))
        : [],
      unmatched_terms: Array.isArray(parsed.unmatched_terms)
        ? parsed.unmatched_terms.map((term) => String(term))
        : [],
    };

    console.log('[DRUG PARSER]', 'Parsed query JSON', safeParsed);
    return safeParsed;
  }

  private scoreEntry(
    entry: DrugEntry,
    rawQuery: string,
    normalizedQuery: string,
  ): number {
    const trimmedRawQuery = rawQuery.trim();
    const normalizedName = normalizeText(entry.drug_name);
    const aliases = entry.aliases.map((alias) => normalizeText(alias));
    const rawAliases = entry.aliases.map((alias) => alias.trim());
    const rawDrugName = entry.drug_name.trim();
    const rawProprietary = entry.proprietary_preparations || '';
    const proprietary = normalizeText(entry.proprietary_preparations || '');
    const searchText = normalizeText(entry.search_text || entry.raw_text || '');

    if (trimmedRawQuery && rawDrugName === trimmedRawQuery) return 500;
    if (trimmedRawQuery && rawAliases.includes(trimmedRawQuery)) return 475;
    if (trimmedRawQuery && hasExactPhraseMatch(rawProprietary, trimmedRawQuery)) return 450;
    if (normalizedName === normalizedQuery) return 400;
    if (aliases.includes(normalizedQuery)) return 350;
    if (proprietary && hasExactPhraseMatch(proprietary, normalizedQuery)) return 325;
    if (proprietary && proprietary.includes(normalizedQuery)) return 300;
    if (normalizedName.includes(normalizedQuery)) return 250;
    if (aliases.some((alias) => alias.includes(normalizedQuery))) return 225;

    const queryTokens = normalizedQuery.split(' ').filter(Boolean);
    if (
      queryTokens.length > 0 &&
      queryTokens.every((token) => searchText.includes(token))
    ) {
      return 150 - Math.max(0, normalizedName.length - normalizedQuery.length);
    }

    return -1;
  }

  private getScoredCandidates(
    catalog: DrugCatalog,
    rawQuery: string,
    normalizedQuery: string,
  ): Array<{ entry: DrugEntry; score: number }> {
    return catalog.entries
      .map((entry) => ({
        entry,
        score: this.scoreEntry(entry, rawQuery, normalizedQuery),
      }))
      .filter((candidate) =>
        candidate.score >= 0 &&
        !DRUG_NAME_DENYLIST.has(candidate.entry.drug_name.trim().toUpperCase()),
      )
      .sort((left, right) => right.score - left.score);
  }

  private selectUniqueEntries(
    scored: Array<{ entry: DrugEntry; score: number }>,
    seenIds: Set<string>,
    limit: number,
  ): DrugEntry[] {
    const selected: DrugEntry[] = [];

    for (const candidate of scored) {
      if (seenIds.has(candidate.entry.id)) continue;
      selected.push(candidate.entry);
      if (selected.length >= limit) break;
    }

    return selected;
  }

  private findMatches(catalog: DrugCatalog, parsed: DrugQueryParseResult): DrugEntry[] {
    const matches: DrugEntry[] = [];
    const firstRoundMatches: DrugEntry[] = [];
    const seenIds = new Set<string>();
    const reservedSecondPassSlots = parsed.drugs.length > 0 ? DRUG_SECOND_PASS_LIMIT : 0;
    const firstPassLimit = Math.max(1, DRUG_TOTAL_MATCH_LIMIT - reservedSecondPassSlots);

    for (const drug of parsed.drugs) {
      if (matches.length >= firstPassLimit) break;

      const rawDrugName = drug.normalized_name.trim() || drug.input_name.trim();
      const normalizedDrugName = normalizeText(rawDrugName);
      if (!rawDrugName || !normalizedDrugName) continue;

      const scored = this.getScoredCandidates(
        catalog,
        rawDrugName,
        normalizedDrugName,
      );

      console.log('[DRUG SEARCH]', 'Lookup results for parsed drug', {
        requested: drug.input_name,
        exact_query: rawDrugName,
        normalized: normalizedDrugName,
        confidence: drug.confidence,
        candidates: scored.slice(0, 5).map((candidate) => ({
          drug_name: candidate.entry.drug_name,
          score: candidate.score,
        })),
      });

      const selected = this.selectUniqueEntries(
        scored,
        seenIds,
        firstPassLimit - matches.length,
      );

      for (const entry of selected) {
        seenIds.add(entry.id);
        matches.push(entry);
        firstRoundMatches.push(entry);
      }
    }

    const topFirstRoundMatch = firstRoundMatches[0];
    if (topFirstRoundMatch && matches.length < DRUG_TOTAL_MATCH_LIMIT) {
      const titleQuery = topFirstRoundMatch.drug_name.trim();
      const normalizedTitleQuery = normalizeText(titleQuery);

      if (titleQuery && normalizedTitleQuery) {
        const scored = this.getScoredCandidates(
          catalog,
          titleQuery,
          normalizedTitleQuery,
        );

        console.log('[DRUG SEARCH]', 'Second pass title lookup', {
          seed_entry: topFirstRoundMatch.drug_name,
          title_query: titleQuery,
          normalized: normalizedTitleQuery,
          candidates: scored.slice(0, 5).map((candidate) => ({
            drug_name: candidate.entry.drug_name,
            score: candidate.score,
          })),
        });

        const selected = this.selectUniqueEntries(
          scored,
          seenIds,
          Math.min(
            DRUG_SECOND_PASS_LIMIT,
            DRUG_TOTAL_MATCH_LIMIT - matches.length,
          ),
        );

        for (const entry of selected) {
          seenIds.add(entry.id);
          matches.push(entry);
        }
      }
    }

    return matches;
  }

  private buildNoMatchMessage(
    content: string,
    parsed: DrugQueryParseResult,
  ): string {
    const requestedNames = parsed.drugs.map((drug) => drug.input_name).filter(Boolean);
    const unmatched = requestedNames.length > 0 ? requestedNames.join(', ') : content;

    return `I could not find a matching drug entry for: ${unmatched}. Please check the spelling or ask with the exact generic or brand name.`;
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
      const matches = this.findMatches(catalog, parsed);

      console.log('[DRUG SEARCH]', 'Final matched entries', {
        requestedDrugs: parsed.drugs.map((drug) => drug.normalized_name),
        matchedEntries: matches.map((entry) => entry.drug_name),
        unmatched_terms: parsed.unmatched_terms,
      });

      if (matches.length === 0) {
        const noMatchMessage = this.buildNoMatchMessage(content, parsed);
        console.warn('[DRUG SEARCH]', 'No matching drug entries found', {
          query: content,
          parsed,
        });
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

Parsed query:
${JSON.stringify(parsed, null, 2)}

Matched drug entries:
${matches.map((entry) => stringifyEntryForPrompt(entry)).join('\n\n---\n\n')}`;

      const systemPrompt = `You are answering questions only from structured drug records.

Use only the provided matched drug entries. Do not use outside knowledge. If a requested field is missing, clearly say it is not present in the dataset.

Formatting rules:
- Always use markdown headings and bullet points.
- If multiple drugs are requested, answer each drug separately under its own heading.
- Use short, clear subheadings such as Indications, Dose, Side Effects, Cautions, Contraindications, Notes, and Brand Names where relevant.
- Keep the answer practical and easy to scan.

Brand name rules:
- Always give the generic name at the top of your answer even if the user asked for Brand name 'Example - Pantoprazole if user asked for pantonix (brand name)
- Always include a Brand Names section for each matched drug, even if the user asked about something else.
- Group brand names by dosage form whenever the source provides dosage forms, such as Capsule, Tablet, Injection, Syrup, Suspension, Suppository, Infusion, or other clear forms.
- Prefer these companies first when selecting brand names: ${PREFERRED_DRUG_COMPANIES.join(', ')}, and Healthcare pharmaceuticals. If you cannot find these companies, only then use other available companies from the source.
- For each dosage form, provide only 4 to 5 brand names total.
- Fill the 4 to 5 slots with preferred companies first. If there are not enough from the preferred list, use other available brands from the source.
- For each brand, include brand name, company, strength if present, dosage form, and price exactly from the source when available.

Dosing schedule rules:
- At the top of the answer, clearly state these dosing assumptions when providing calculated schedules: adult dosing assumes a 70 kg adult, and child dosing assumes a 25 kg child.
- When giving brand names, also include a dosing schedule line if it can be derived from the dose information in the record.
- Base the dosing schedule only on the provided dose text.
- Convert dose guidance into practical prescription-style schedules such as 1 + 0 + 1, 1 + 0 + 0, 5 ml every 8 hours, or 1 vial IV 12 hourly whenever the source supports that conversion.
- When dose conversion requires a body-weight assumption, use 70 kg for adults and 25 kg for children.
- Give separate dosing schedules for separate indications when the source provides them.
- If the schedule is not clearly supported by the source, say that the exact schedule is not clearly specified in the dataset.
- Do not invent brand-specific schedules or clinical details that are not supported by the source.
- Do not present dose information in narrative paragraph form when it can be converted into prescription format.
- Always prefer prescription-style lines over prose explanations.
- For each brand and indication, present the dose in this structure:
- Tab./Cap./Inj./Susp. BrandName (strength) - Company
- prescription-style dosing line
- Price: exact price from source
- If multiple indications have different schedules, write separate prescription lines for each indication.

Example format to follow:
- ORAL
- Tab. Pantonix (20 mg) - Incepta
- 1 + 0 + 1 (1/2 hour before meal) - For benign gastric ulcer
- 1 + 0 + 0 (1/2 hour before meal) - For PUD
- Price: 7 tk / tab
- INJECTION
- Inj. Pantonix (40 mg) - Incepta
- 1 vial IV - 12 hourly
- Price: 90 tk / vial

Answering rules:
- If the user asked for clinical information such as indications, side effects, cautions, contraindications, or dose, answer that first.
- Then include the Brand Names section.
- Keep the answer faithful to the source text.
- Do not include anything that is not given in the source text.`;

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
        matchedEntryCount: matches.length,
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
