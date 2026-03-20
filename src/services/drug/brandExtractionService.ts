import { groqService } from '@/services/groq/groqService';
import { getIndexedDBServices } from '@/services/indexedDB';
import type {
  BrandExtractionParseResult,
  BrandLookupRequest,
  MessageCreate,
} from '@/types';
import { MessageSender } from '@/types/message';
import type { ChatStreamEvent } from '@/services/rag';
import { drugModeService } from './drugModeService';
import type { DrugBrandLookupResult } from './drugModeService';

const BRAND_EXTRACTION_PARSER_MODEL = 'llama-3.3-70b-versatile';
const BRAND_EXTRACTION_ANSWER_MODEL = 'moonshotai/kimi-k2-instruct-0905';
const BRAND_EXTRACTION_PROMPT_LOG_CHUNK_SIZE = 4000;
const MAX_GENERICS = 5;
const MAX_BRANDS_PER_GENERIC = 5;

const ASK_DRUG_PARSER_PROMPT = `Extract up to 5 generic drug names from the assistant answer.
Return ONLY valid JSON with this exact shape:
{
  "drug_names": ["Paracetamol", "Ibuprofen", "Aspirin"]
}

Rules:
- Extract only generic single-ingredient drug names explicitly present in the answer.
- Keep the order of first appearance in the answer.
- Deduplicate names.
- Maximum 5 drug names.
- Do not include brand names.
- Do not include fixed-dose combinations such as "Aspirin with codeine".
- Do not infer or add drugs that are not explicitly written in the answer.
- Do not include any text outside JSON.`;

const CHAT_MODE_PARSER_PROMPT = `Extract up to 5 generic drug names from the assistant answer.
Return ONLY valid JSON with this exact shape:
{
  "drug_names": ["Ceftriaxone", "Cefixime", "Flucloxacillin"]
}

Rules:
- Extract explicit generic drug names already present in the answer.
- Also resolve class-like treatment mentions into actual generic drugs when helpful.
- For a class-like mention, choose up to 3 common and widely used generic drugs.
- Keep the order of first appearance in the answer.
- Deduplicate names.
- Maximum 5 drug names in total.
- Prefer common practical generics.
- Do not include brand names.
- Do not include fixed-dose combinations unless the answer itself only provides combinations.
- Examples:
  - "3rd generation cephalosporin" -> "Ceftriaxone", "Cefixime"
  - "good antistaphylococcal beta lactamase resistant penicillin" -> "Flucloxacillin", "Cloxacillin"
- Do not include any text outside JSON.`;

const BRAND_EXTRACTION_ANSWER_SYSTEM_PROMPT = `You answer brand-name lookup requests using ONLY the structured dataset context provided.

Your job is to produce a Drug Mode style answer for each generic:
- brand names
- dosing schedule
- formulation grouping
- price

Core rules:
- Use only the provided context.
- Do not invent brands, companies, prices, doses, strengths, or formulations.
- If a brand entry includes parsed_details, use parsed_details first and treat details as raw fallback text only.
- For each generic, list at most 5 brands from the already filtered proprietary list.
- Preferred companies are already ordered first in the provided context.
- Use the generic indications and generic dose context to CALCULATE the dosing schedule for each relevant brand formulation when possible.
- If multiple brands share the same formulation and same strength pattern, explain the dosing fully for the first one and then mark the later ones as "same ... dosing already covered".
- Do not invent routes, frequencies, strengths, or age groups not supported by the context.
- If a generic has no matched dataset entry, explicitly say: "No matching brand entry found in BD prescription dataset."
- Do not output more than 5 generics total.

Important dosing behavior:
- Dosing information is usually given at the generic level.
- You must map that generic dose information onto the listed brand formulations.
- If the context supports it, convert the generic dose into a practical schedule for that formulation.
- Prefer the same style as Drug Mode answers:
  - tablet/capsule counts when practical
  - oral timing when stated
  - IV / injection schedules when stated
  - separate schedule lines by indication when the indication text supports it
- If exact brand-specific dosing cannot be derived safely, still show the brand and price details, but do not invent a schedule.

Formatting rules:
- Start each generic with a heading in this style:
  - **✅ PANTOPRAZOLE**
  - Generic : Pantoprazole
- Then write:
  - Brands and dose
- You must include every formulation that is present in the provided filtered proprietary brand data for that generic.
- Do not stop after one formulation if tablets, capsules, injections, syrup, suspension, drops, suppositories, gels, or other forms are present in the context.
- Group all brands under their correct formulation headings.
- Formulation headers must be bold and uppercase, for example:
  - **TABLET**
  - **SYRUP**
  - **SUPPOSITORY**
  - **INJECTION (IV)**
- Under each formulation, use bullet points for brands.
- Brand bullet format should look like:
  - • Tab. Pantonix 20 mg - Incepta
  - - 1 + 0 + 1 (1/2 h before meals) - gastric ulcer
  - - 1 + 0 + 0 (1/2 h before meals) - GERD
  - Price : Tk 5.00/tab
- If same formulation/strength dosing was already explained for an earlier brand, write:
  - (same 20 mg tab dosing already covered)
- Keep the answer neat and compact, but do not skip useful dosing lines when they can be derived from the context.

Reference style example:
**✅ PANTOPRAZOLE**
Generic : Pantoprazole

Brands and dose

**TABLET**

• Tab. Pantonix 20 mg - Incepta
- 1 + 0 + 1 (1/2 h before meals) - gastric ulcer
- 1 + 0 + 0 (1/2 h before meals) - GERD
Price : Tk 5.00/tab

• Tab. Trupan 20 mg - Square (same 20 mg tab dosing already covered)
Price : Tk 5.02/tab

**INJECTION (IV)**

• Inj. Pantonix 40 mg - Incepta
- 1 vial IV 12 hourly - gastric ulcer
- 1 vial IV 8 hourly - reflux oesophagitis / PUD
Price : Tk 90.00/vial`;

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

const uniqueOrdered = (values: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const compact = value.replace(/\s+/g, ' ').trim();
    if (!compact) continue;
    const normalized = compact.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(compact);
  }

  return result;
};

const removeCombinationNames = (values: string[]): string[] =>
  values.filter((value) => !/\bwith\b|\+|\//i.test(value));

const formatDrugNameList = (drugNames: string[]): string => {
  if (drugNames.length === 0) return '';
  if (drugNames.length === 1) return drugNames[0];
  if (drugNames.length === 2) return `${drugNames[0]} and ${drugNames[1]}`;

  return `${drugNames.slice(0, -1).join(', ')} and ${drugNames[drugNames.length - 1]}`;
};

const buildBrandSearchQuery = (drugNames: string[]): string =>
  `Search for brands and dose of ${formatDrugNameList(drugNames)}`;

const logFullPromptText = (label: string, text: string): void => {
  const chunkCount = Math.max(1, Math.ceil(text.length / BRAND_EXTRACTION_PROMPT_LOG_CHUNK_SIZE));
  console.log(`${label}[META]`, {
    length: text.length,
    chunkSize: BRAND_EXTRACTION_PROMPT_LOG_CHUNK_SIZE,
    chunkCount,
  });

  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * BRAND_EXTRACTION_PROMPT_LOG_CHUNK_SIZE;
    const end = start + BRAND_EXTRACTION_PROMPT_LOG_CHUNK_SIZE;
    console.log(`${label}[CHUNK ${index + 1}/${chunkCount}]`, text.slice(start, end));
  }
};

const buildNoBrandLookupSections = (
  foundWithoutBrands: DrugBrandLookupResult[],
  missing: string[],
): string[] => {
  const lines: string[] = [];

  for (const result of foundWithoutBrands) {
    lines.push(
      '',
      `**✅ ${result.resolved_generic_name}**`,
      `Generic : ${result.resolved_generic_name}`,
      'No matching brand entry found in BD prescription dataset.',
    );

    if (result.indications) {
      lines.push('', `Indications: ${result.indications}`);
    }

    if (result.dose) {
      lines.push('', `Dose: ${result.dose}`);
    }
  }

  for (const drugName of missing) {
    lines.push(
      '',
      `**✅ ${drugName}**`,
      `Generic : ${drugName}`,
      'No matching brand entry found in BD prescription dataset.',
    );
  }

  return lines;
};

export class BrandExtractionService {
  private indexedDBServices = getIndexedDBServices();

  private async saveMessage(
    sessionId: string,
    role: MessageSender,
    content: string,
  ): Promise<void> {
    const session = await this.indexedDBServices.sessionService.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const message: MessageCreate = {
      sessionId,
      content,
      role,
    };

    await this.indexedDBServices.messageService.createMessage(
      message,
      session.userId,
    );
  }

  private async saveAssistantMessage(sessionId: string, content: string): Promise<void> {
    await this.saveMessage(sessionId, MessageSender.ASSISTANT, content);
  }

  private async saveUserMessage(sessionId: string, content: string): Promise<void> {
    await this.saveMessage(sessionId, MessageSender.USER, content);
  }

  private async parseDrugNames(request: BrandLookupRequest): Promise<string[]> {
    const systemPrompt =
      request.sourceMode === 'ask-drug'
        ? ASK_DRUG_PARSER_PROMPT
        : CHAT_MODE_PARSER_PROMPT;

    console.log('[BRAND EXTRACTION PARSER][SYSTEM]', systemPrompt);
    console.log('[BRAND EXTRACTION PARSER][USER]', request.answerText);

    const raw = await groqService.generateResponseWithGroq(
      request.answerText,
      systemPrompt,
      BRAND_EXTRACTION_PARSER_MODEL,
      {
        temperature: 0,
        maxTokens: 700,
      },
    );

    console.log('[BRAND EXTRACTION PARSER] Raw parser output', raw);

    const parsed = extractJsonObject<BrandExtractionParseResult>(raw);
    const ordered = uniqueOrdered(parsed.drug_names || []);
    const filtered =
      request.sourceMode === 'ask-drug'
        ? removeCombinationNames(ordered)
        : ordered;

    return filtered.slice(0, MAX_GENERICS);
  }

  async extractBrandsFromAnswer(
    sessionId: string,
    request: BrandLookupRequest,
    onStreamEvent?: (event: ChatStreamEvent) => void,
  ): Promise<void> {
    console.log('[BRAND EXTRACTION]', 'Starting brand extraction pipeline', {
      sessionId,
      sourceMode: request.sourceMode,
    });

    onStreamEvent?.({
      type: 'status',
      message: 'Brand Parsing',
    });

    const drugNames = await this.parseDrugNames(request);
    console.log('[BRAND EXTRACTION]', 'Parsed drug names', { drugNames });

    if (drugNames.length === 0) {
      const noDrugMessage =
        'I could not identify any drug names in the last answer to fetch brands for.';
      await this.saveAssistantMessage(sessionId, noDrugMessage);
      onStreamEvent?.({ type: 'done', content: noDrugMessage });
      return;
    }

    const syntheticUserQuery = buildBrandSearchQuery(drugNames);
    await this.saveUserMessage(sessionId, syntheticUserQuery);
    onStreamEvent?.({
      type: 'userMessage',
      content: syntheticUserQuery,
    });

    onStreamEvent?.({
      type: 'status',
      message: 'Brand Lookup',
    });

    const catalog = await drugModeService.ensureDatasetReady();
    const found: DrugBrandLookupResult[] = [];
    const missing: string[] = [];

    for (const drugName of drugNames) {
      const entry = await drugModeService.findDrugEntryByName(drugName, catalog);
      if (!entry) {
        missing.push(drugName);
        continue;
      }

      found.push(drugModeService.buildBrandLookupResult(drugName, entry, MAX_BRANDS_PER_GENERIC));
    }

    const foundWithBrands = found.filter(
      (result) => result.filtered_proprietary_preparations.length > 0,
    );
    const foundWithoutBrands = found.filter(
      (result) => result.filtered_proprietary_preparations.length === 0,
    );

    if (foundWithBrands.length === 0) {
      const deterministicResponse = ['## Brand names', ...buildNoBrandLookupSections(foundWithoutBrands, missing)]
        .join('\n');
      await this.saveAssistantMessage(sessionId, deterministicResponse);
      onStreamEvent?.({
        type: 'done',
        content: deterministicResponse,
      });
      return;
    }

    const prompt = `Source mode:
${request.sourceMode}

Original answer:
${request.answerText}

Extracted generic names:
${JSON.stringify(drugNames, null, 2)}

Matched brand lookup context:
${JSON.stringify(foundWithBrands, null, 2)}

Matched generics with no filtered brands:
${JSON.stringify(
  foundWithoutBrands.map((result) => ({
    resolved_generic_name: result.resolved_generic_name,
    indications: result.indications,
    dose: result.dose,
  })),
  null,
  2,
)}

Missing generic names:
${JSON.stringify(missing, null, 2)}`;

    onStreamEvent?.({
      type: 'status',
      message: 'Brand Answer Generation',
    });

    logFullPromptText('[BRAND EXTRACTION ANSWER PROMPT][SYSTEM]', BRAND_EXTRACTION_ANSWER_SYSTEM_PROMPT);
    logFullPromptText('[BRAND EXTRACTION ANSWER PROMPT][USER]', prompt);

    let fullResponse = '';
    await groqService.generateStreamingResponse(
      prompt,
      BRAND_EXTRACTION_ANSWER_SYSTEM_PROMPT,
      BRAND_EXTRACTION_ANSWER_MODEL,
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

    const noBrandSections = buildNoBrandLookupSections(foundWithoutBrands, missing);
    if (noBrandSections.length > 0) {
      fullResponse = `${fullResponse.trim()}\n${noBrandSections.join('\n')}`;
    }

    await this.saveAssistantMessage(sessionId, fullResponse);
    onStreamEvent?.({
      type: 'done',
      content: fullResponse,
    });
  }
}

export const brandExtractionService = new BrandExtractionService();
