import type {
  AskDrugDoseIndication,
  AskDrugDoseInstruction,
  AskDrugDoseRoute,
  ParsedBrandDetail,
} from '@/types';

type DrugDoseAudience = 'adult' | 'child';

type DeterministicPromptBrand = {
  brand_name: string;
  company_name: string;
  display_name: string;
  parsed_details: ParsedBrandDetail[];
};

type DeterministicDoseContext = {
  genericName: string;
  indications: AskDrugDoseIndication[];
  brands: DeterministicPromptBrand[];
};

type DeterministicSelectedIndication = {
  indication: AskDrugDoseIndication;
  score: number;
  reason: 'query_match' | 'default_general';
};

type DeterministicBrandBlock = {
  heading: string;
  sortOrder: number;
  intraGroupOrder: number;
  priority: 0 | 1 | 2;
  queryPriority: 0 | 1;
  content: string;
};

type DetectedRouteFamily =
  | 'oral'
  | 'oral_immediate_release'
  | 'oral_modified_release'
  | 'rectal'
  | 'injection'
  | 'infusion'
  | 'topical'
  | 'unknown';

type RouteMapping = {
  route: AskDrugDoseRoute;
  family: DetectedRouteFamily;
  headings: string[];
  order: number;
};

type StructuredIndicationLogItem = {
  indication: string;
  routes: Array<{
    route: string;
    family: DetectedRouteFamily;
    instruction_groups: string[];
    instruction_count: number;
  }>;
};

const DETERMINISTIC_LOG_CHUNK_SIZE = 4000;

const compactField = (value?: string | null): string | undefined => {
  if (!value) return undefined;
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact || undefined;
};

const normalizeText = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const normalizeCompact = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '').trim();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const uniqueStrings = (values: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const compact = compactField(value);
    if (!compact) continue;
    const key = normalizeCompact(compact);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(compact);
  }

  return result;
};

const tokenize = (value: string): string[] =>
  normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length > 1);

const buildTokenSet = (value: string): Set<string> => new Set(tokenize(value));

const buildBigrams = (value: string): Set<string> => {
  const tokens = tokenize(value);
  const result = new Set<string>();

  for (let index = 0; index < tokens.length - 1; index += 1) {
    result.add(`${tokens[index]} ${tokens[index + 1]}`);
  }

  return result;
};

const countOverlap = <T>(left: Set<T>, right: Set<T>): number => {
  let total = 0;
  for (const item of left) {
    if (right.has(item)) total += 1;
  }
  return total;
};

const renderDrugDoseBlock = (block: string): string => {
  const normalized = block
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();

  return normalized;
};

const renderPriceLine = (detail: ParsedBrandDetail): string =>
  `Price: ${detail.price || 'Not specified'}${detail.price_unit ? ` tk/${detail.price_unit}` : ''}`;

const isAdultDoseGroup = (group: string): boolean =>
  /^(?:Adult|Elderly)\b/i.test(group.trim());

const isChildDoseGroup = (group: string): boolean =>
  /^(?:Child|Paediatric|Pediatric|Infant|Neonate|Toddler|Baby|Adolescent|Young person)\b/i.test(
    group.trim(),
  );

const logDeterministicText = (label: string, text: string): void => {
  const chunkCount = Math.max(1, Math.ceil(text.length / DETERMINISTIC_LOG_CHUNK_SIZE));
  console.log(`${label}[META]`, {
    length: text.length,
    chunkSize: DETERMINISTIC_LOG_CHUNK_SIZE,
    chunkCount,
  });

  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * DETERMINISTIC_LOG_CHUNK_SIZE;
    const end = start + DETERMINISTIC_LOG_CHUNK_SIZE;
    console.log(`${label}[CHUNK ${index + 1}/${chunkCount}]`, text.slice(start, end));
  }
};

const summarizePromptBrandsForLog = (
  brands: DeterministicPromptBrand[],
): Array<{
  brand_name: string;
  company_name: string;
  parsed_detail_count: number;
  details: Array<{
    formulation: string;
    formulation_raw: string;
    strength: string;
    release_type?: 'SR' | 'XR';
    is_paediatric: boolean;
  }>;
}> =>
  brands.map((brand) => ({
    brand_name: brand.brand_name,
    company_name: brand.company_name,
    parsed_detail_count: brand.parsed_details.length,
    details: brand.parsed_details.map((detail) => ({
      formulation: detail.formulation,
      formulation_raw: detail.formulation_raw,
      strength: detail.strength,
      release_type: detail.release_type,
      is_paediatric: detail.is_paediatric,
    })),
  }));

const isLikelyMalformedParsedDetail = (detail: ParsedBrandDetail): boolean => {
  const sourceText = `${detail.formulation_raw} ${detail.raw_text} ${detail.price_unit || ''}`.toLowerCase();

  if (detail.formulation === 'TABLET' || detail.formulation === 'CAPSULE') {
    if (/\bsupp|suppo|suppository\b/.test(sourceText)) return true;
  }

  if (detail.formulation === 'SUPPOSITORY') {
    if (/\btab|tablet|cap|capsule\b/.test(sourceText)) return true;
  }

  if (detail.formulation === 'SYRUP' || detail.formulation === 'SUSPENSION' || detail.formulation === 'DROPS') {
    if (/\bsupp|suppo|suppository\b/.test(sourceText)) return true;
  }

  if (detail.formulation === 'TABLET' && /\b(?:syrup|suspn|suspension|drops)\b/.test(sourceText)) {
    return true;
  }

  return false;
};

const extractStructuredIndications = (value: unknown): AskDrugDoseIndication[] => {
  if (!isRecord(value) || !Array.isArray(value.indications)) {
    return [];
  }

  return value.indications
    .map((item): AskDrugDoseIndication | null => {
      if (!isRecord(item)) return null;
      const indication = compactField(String(item.indication || ''));
      if (!indication || !Array.isArray(item.routes)) return null;

      const routes = item.routes
        .map((routeItem): AskDrugDoseRoute | null => {
          if (!isRecord(routeItem)) return null;
          const route = compactField(String(routeItem.route || ''));
          if (!route || !Array.isArray(routeItem.instructions)) return null;

          const instructions = routeItem.instructions
            .map((instructionItem): AskDrugDoseInstruction | null => {
              if (!isRecord(instructionItem)) return null;
              const group = compactField(String(instructionItem.group || ''));
              const text = compactField(String(instructionItem.text || ''));
              if (!group || !text) return null;
              return { group, text };
            })
            .filter((instruction): instruction is AskDrugDoseInstruction => Boolean(instruction));

          if (instructions.length === 0) return null;
          return { route, instructions };
        })
        .filter((route): route is AskDrugDoseRoute => Boolean(route));

      if (routes.length === 0) return null;
      return { indication, routes };
    })
    .filter((item): item is AskDrugDoseIndication => Boolean(item));
};

const extractPromptBrands = (value: unknown): DeterministicPromptBrand[] => {
  if (!Array.isArray(value)) return [];

  return value
    .map((item): DeterministicPromptBrand | null => {
      if (!isRecord(item) || !Array.isArray(item.parsed_details)) return null;
      const brand_name = compactField(String(item.brand_name || ''));
      const company_name = compactField(String(item.company_name || ''));
      const display_name = compactField(String(item.display_name || ''));
      if (!brand_name || !company_name || !display_name) return null;

      const parsed_details = item.parsed_details
        .map((detailItem): ParsedBrandDetail | null => {
          if (!isRecord(detailItem)) return null;
          const formulation_raw = compactField(String(detailItem.formulation_raw || ''));
          const formulation = compactField(String(detailItem.formulation || ''));
          const strength = compactField(String(detailItem.strength || ''));
          const price = compactField(String(detailItem.price || ''));
          if (!formulation_raw || !formulation || !strength || !price) return null;

          return {
            raw_text: compactField(String(detailItem.raw_text || '')) || '',
            formulation_raw,
            formulation,
            release_type:
              detailItem.release_type === 'SR' || detailItem.release_type === 'XR'
                ? detailItem.release_type
                : undefined,
            strength,
            price,
            price_unit:
              typeof detailItem.price_unit === 'string'
                ? compactField(detailItem.price_unit)
                : undefined,
            is_modified_release: Boolean(detailItem.is_modified_release),
            is_paediatric: Boolean(detailItem.is_paediatric),
          };
        })
        .filter((detail): detail is ParsedBrandDetail => Boolean(detail))
        .filter((detail) => !isLikelyMalformedParsedDetail(detail));

      if (parsed_details.length === 0) return null;
      return { brand_name, company_name, display_name, parsed_details };
    })
    .filter((brand): brand is DeterministicPromptBrand => Boolean(brand));
};

const filterIndicationsForAudience = (
  indications: AskDrugDoseIndication[],
  requestedDoseAudience: DrugDoseAudience,
): AskDrugDoseIndication[] =>
  indications
    .map((indication) => ({
      ...indication,
      routes: indication.routes
        .map((route) => ({
          ...route,
          instructions: route.instructions.filter((instruction) =>
            requestedDoseAudience === 'child'
              ? isChildDoseGroup(instruction.group)
              : isAdultDoseGroup(instruction.group),
          ),
        }))
        .filter((route) => route.instructions.length > 0),
    }))
    .filter((indication) => indication.routes.length > 0);

const toDeterministicDoseContext = (
  promptContext: Record<string, unknown>,
  requestedDoseAudience: DrugDoseAudience,
): DeterministicDoseContext | null => {
  const genericName = compactField(String(promptContext.generic_name || '')) || '';
  const clinicalContext = isRecord(promptContext.clinical_context)
    ? promptContext.clinical_context
    : null;
  const indications = filterIndicationsForAudience(
    extractStructuredIndications(clinicalContext?.indications_and_dose_structured),
    requestedDoseAudience,
  );
  const brands = extractPromptBrands(promptContext.filtered_proprietary_preparations);

  if (!genericName || indications.length === 0 || brands.length === 0) {
    return null;
  }

  return {
    genericName,
    indications,
    brands,
  };
};

const scoreIndicationMatch = (
  indicationLabel: string,
  requestedIndicationQuery?: string,
): number => {
  const labelCompact = normalizeCompact(indicationLabel);
  if (!requestedIndicationQuery) {
    const normalized = normalizeText(indicationLabel);
    let score = 100;
    score -= Math.min(35, normalized.split(/\s+/).length * 2);
    score -= (indicationLabel.match(/[([].+?[)\]]/g) || []).length * 8;
    score -= /\b(?:postoperative|perioperative|anaesthesia|consult|product literature|specialist|specialist use)\b/i.test(
      indicationLabel,
    )
      ? 18
      : 0;
    score -= /\b(?:prophylaxis|prevention)\b/i.test(indicationLabel) ? 8 : 0;
    return score;
  }

  const queryCompact = normalizeCompact(requestedIndicationQuery);
  const queryText = normalizeText(requestedIndicationQuery);
  const labelText = normalizeText(indicationLabel);

  if (!queryCompact || !labelCompact) return Number.NEGATIVE_INFINITY;
  if (labelCompact === queryCompact) return 1000;
  if (labelText === queryText) return 980;

  let score = 0;
  if (labelCompact.includes(queryCompact) || queryCompact.includes(labelCompact)) score += 320;

  const queryTokens = buildTokenSet(requestedIndicationQuery);
  const labelTokens = buildTokenSet(indicationLabel);
  score += countOverlap(queryTokens, labelTokens) * 40;

  const queryBigrams = buildBigrams(requestedIndicationQuery);
  const labelBigrams = buildBigrams(indicationLabel);
  score += countOverlap(queryBigrams, labelBigrams) * 65;

  score -= Math.abs(labelTokens.size - queryTokens.size) * 5;
  score -= /\b(?:postoperative|perioperative|anaesthesia)\b/i.test(indicationLabel) &&
    !/\b(?:postoperative|perioperative|anaesthesia)\b/i.test(requestedIndicationQuery)
      ? 20
      : 0;

  return score;
};

const detectRouteFamily = (routeText: string): DetectedRouteFamily => {
  const normalized = normalizeText(routeText);

  if (/\brectum\b/.test(normalized)) return 'rectal';
  if (/\bmodified release\b/.test(normalized)) return 'oral_modified_release';
  if (/\bimmediate release\b/.test(normalized)) return 'oral_immediate_release';
  if (/\bmouth\b/.test(normalized)) return 'oral';
  if (/\binfusion\b/.test(normalized)) return /\binjection\b/.test(normalized) ? 'infusion' : 'infusion';
  if (/\bintravenous\b|\bintramuscular\b|\bsubcutaneous\b|\binjection\b/.test(normalized)) {
    return 'injection';
  }
  if (/\bskin\b|\btopical\b/.test(normalized)) return 'topical';

  return 'unknown';
};

const routeHeadingsForFamily = (family: DetectedRouteFamily): string[] => {
  switch (family) {
    case 'oral':
    case 'oral_immediate_release':
      return ['TABLET', 'CAPSULE', 'SYRUP', 'SUSPENSION', 'DROPS', 'SACHET'];
    case 'oral_modified_release':
      return ['TABLET', 'CAPSULE'];
    case 'rectal':
      return ['SUPPOSITORY'];
    case 'injection':
      return ['INJECTION'];
    case 'infusion':
      return ['INJECTION', 'INFUSION'];
    case 'topical':
      return ['GEL'];
    default:
      return [];
  }
};

const missingBrandHeadingsForRoute = (routeMapping: RouteMapping): string[] => {
  switch (routeMapping.family) {
    case 'rectal':
      return ['SUPPOSITORY'];
    case 'injection':
      return ['INJECTION'];
    case 'infusion':
      return routeMapping.headings;
    default:
      return [];
  }
};

const buildRouteMappings = (indication: AskDrugDoseIndication): RouteMapping[] =>
  indication.routes.map((route, index) => {
    const family = detectRouteFamily(route.route);
    return {
      route,
      family,
      headings: routeHeadingsForFamily(family),
      order: index,
    };
  });

const summarizeStructuredIndicationsForLog = (
  indications: AskDrugDoseIndication[],
): StructuredIndicationLogItem[] =>
  indications.map((indication) => ({
    indication: indication.indication,
    routes: buildRouteMappings(indication).map((routeMapping) => ({
      route: routeMapping.route.route,
      family: routeMapping.family,
      instruction_groups: uniqueStrings(
        routeMapping.route.instructions.map((instruction) => instruction.group),
      ),
      instruction_count: routeMapping.route.instructions.length,
    })),
  }));

const detailMatchesRoute = (
  detail: ParsedBrandDetail,
  routeMapping: RouteMapping,
): boolean => {
  if (!routeMapping.headings.includes(detail.formulation)) {
    return false;
  }

  if (routeMapping.family === 'oral_modified_release') {
    return detail.is_modified_release;
  }

  if (routeMapping.family === 'oral_immediate_release') {
    return !detail.is_modified_release;
  }

  if (routeMapping.family === 'oral' && detail.is_modified_release) {
    return false;
  }

  if (routeMapping.family === 'rectal') {
    return detail.formulation === 'SUPPOSITORY';
  }

  if (routeMapping.family === 'infusion') {
    return detail.formulation === 'INJECTION' || detail.formulation === 'INFUSION';
  }

  return true;
};

const collectRouteMappingsForDetail = (
  detail: ParsedBrandDetail,
  routeMappings: RouteMapping[],
): RouteMapping[] =>
  routeMappings
    .filter((routeMapping) => detailMatchesRoute(detail, routeMapping))
    .sort((left, right) => {
      const familyPriority = (mapping: RouteMapping): number => {
        if (mapping.family === 'oral_modified_release' && detail.is_modified_release) return 0;
        if (mapping.family === 'oral_immediate_release' && !detail.is_modified_release) return 0;
        if (mapping.family === 'infusion' && detail.formulation === 'INFUSION') return 0;
        return 1;
      };

      const priorityDiff = familyPriority(left) - familyPriority(right);
      if (priorityDiff !== 0) return priorityDiff;
      return left.order - right.order;
    });

const collectInstructionsForRouteMappings = (
  routeMappings: RouteMapping[],
): AskDrugDoseInstruction[] => {
  const seen = new Set<string>();
  const instructions: AskDrugDoseInstruction[] = [];

  for (const routeMapping of routeMappings) {
    for (const instruction of routeMapping.route.instructions) {
      const key = `${normalizeCompact(instruction.group)}|${normalizeCompact(instruction.text)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      instructions.push(instruction);
    }
  }

  return instructions;
};

const detailCountsForRequestedAudience = (
  detail: ParsedBrandDetail,
  requestedDoseAudience: DrugDoseAudience,
): boolean => {
  if (requestedDoseAudience === 'adult') {
    return !detail.is_paediatric;
  }

  return true;
};

const scoreDefaultIndicationCoverage = (
  indication: AskDrugDoseIndication,
  brands: DeterministicPromptBrand[],
  requestedDoseAudience: DrugDoseAudience,
): number => {
  const routeMappings = buildRouteMappings(indication);
  const uniqueMatchedFormulations = new Set<string>();
  const routeCoverage = new Set<number>();
  const nonPaediatricRouteCoverage = new Set<number>();
  const nonPaediatricFormulations = new Set<string>();

  for (const brand of brands) {
    for (const detail of brand.parsed_details) {
      const matchedRouteMappings = collectRouteMappingsForDetail(detail, routeMappings);
      if (matchedRouteMappings.length === 0) continue;
      uniqueMatchedFormulations.add(detail.formulation);
      matchedRouteMappings.forEach((routeMapping) => routeCoverage.add(routeMapping.order));

      if (detailCountsForRequestedAudience(detail, requestedDoseAudience)) {
        nonPaediatricFormulations.add(detail.formulation);
        matchedRouteMappings.forEach((routeMapping) => nonPaediatricRouteCoverage.add(routeMapping.order));
      }
    }
  }

  return (
    nonPaediatricFormulations.size * 70 +
    nonPaediatricRouteCoverage.size * 45 +
    uniqueMatchedFormulations.size * 20 +
    routeCoverage.size * 10
  );
};

const selectIndication = (
  indications: AskDrugDoseIndication[],
  brands: DeterministicPromptBrand[],
  requestedDoseAudience: DrugDoseAudience,
  requestedIndicationQuery?: string,
): DeterministicSelectedIndication | null => {
  if (indications.length === 0) return null;

  const scored = indications.map((indication, index) => {
    const baseScore = scoreIndicationMatch(indication.indication, requestedIndicationQuery);
    const coverageScore = requestedIndicationQuery
      ? 0
      : scoreDefaultIndicationCoverage(indication, brands, requestedDoseAudience);

    return {
      indication,
      score: baseScore + coverageScore,
      index,
    };
  });

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.index - right.index;
  });

  const best = scored[0];
  if (!best || !Number.isFinite(best.score)) return null;

  return {
    indication: best.indication,
    score: best.score,
    reason: requestedIndicationQuery ? 'query_match' : 'default_general',
  };
};

const scorePerDetailIndicationCoverage = (
  indication: AskDrugDoseIndication,
  detail: ParsedBrandDetail,
  requestedDoseAudience: DrugDoseAudience,
  requestedIndicationQuery?: string,
): number => {
  const routeMappings = collectRouteMappingsForDetail(detail, buildRouteMappings(indication));
  const instructions = collectInstructionsForRouteMappings(routeMappings);
  if (instructions.length === 0) return Number.NEGATIVE_INFINITY;

  let score = scoreIndicationMatch(indication.indication, requestedIndicationQuery);
  score += routeMappings.length * 80;
  score += instructions.length * 30;

  if (detailCountsForRequestedAudience(detail, requestedDoseAudience)) {
    score += 40;
  }

  return score;
};

const selectIndicationForDetail = (
  indications: AskDrugDoseIndication[],
  preferredIndication: AskDrugDoseIndication,
  detail: ParsedBrandDetail,
  requestedDoseAudience: DrugDoseAudience,
  requestedIndicationQuery?: string,
): { indication: AskDrugDoseIndication; routeMappings: RouteMapping[] } | null => {
  const preferredRouteMappings = collectRouteMappingsForDetail(
    detail,
    buildRouteMappings(preferredIndication),
  );
  if (collectInstructionsForRouteMappings(preferredRouteMappings).length > 0) {
    return {
      indication: preferredIndication,
      routeMappings: preferredRouteMappings,
    };
  }

  const fallbackCandidates = indications
    .filter((indication) => indication !== preferredIndication)
    .map((indication, index) => {
      const routeMappings = collectRouteMappingsForDetail(detail, buildRouteMappings(indication));
      return {
        indication,
        routeMappings,
        score: scorePerDetailIndicationCoverage(
          indication,
          detail,
          requestedDoseAudience,
          requestedIndicationQuery,
        ),
        index,
      };
    })
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.index - right.index;
    });

  const bestFallback = fallbackCandidates[0];
  if (!bestFallback) {
    return {
      indication: preferredIndication,
      routeMappings: preferredRouteMappings,
    };
  }

  return {
    indication: bestFallback.indication,
    routeMappings: bestFallback.routeMappings,
  };
};

const formatIndicationAndInstructions = (
  indicationLabel: string,
  instructions: AskDrugDoseInstruction[],
): string[] => {
  const lines: string[] = [`🎯 ${indicationLabel}`];

  for (const instruction of instructions) {
    lines.push(`**${instruction.group}:**`);
    lines.push(`✨ Dose : ${instruction.text}`);
  }

  return lines;
};

const renderBrandBlock = (
  brand: DeterministicPromptBrand,
  detail: ParsedBrandDetail,
  indicationLabel: string,
  routeMappings: RouteMapping[],
  requestedDoseAudience: DrugDoseAudience,
  referenceOnly: boolean,
): string => {
  const lines: string[] = [
    `🎉 **${detail.formulation_raw} ${brand.brand_name} ${detail.strength} - ${brand.company_name}**`,
    renderPriceLine(detail),
  ];

  if (referenceOnly) {
    lines.push('[same strength dosing already listed above]');
    return renderDrugDoseBlock(lines.join('\n'));
  }

  if (requestedDoseAudience === 'adult' && detail.is_paediatric) {
    lines.push('🔴 No adult dosing — paediatric formulation');
    return renderDrugDoseBlock(lines.join('\n'));
  }

  const instructions = collectInstructionsForRouteMappings(routeMappings);
  if (instructions.length === 0) {
    lines.push('🔴 No dosing information was present in dose and indications');
    return renderDrugDoseBlock(lines.join('\n'));
  }

  lines.push(...formatIndicationAndInstructions(indicationLabel, instructions));
  return renderDrugDoseBlock(lines.join('\n'));
};

const brandBlockHasRenderableDose = (
  detail: ParsedBrandDetail,
  routeMappings: RouteMapping[],
  requestedDoseAudience: DrugDoseAudience,
): boolean => {
  if (requestedDoseAudience === 'adult' && detail.is_paediatric) {
    return false;
  }

  return collectInstructionsForRouteMappings(routeMappings).length > 0;
};

const renderNoBrandRouteBlock = (
  indicationLabel: string,
  routeMappings: RouteMapping[],
): string => {
  const instructions = collectInstructionsForRouteMappings(routeMappings);
  const lines = [
    `🎯 ${indicationLabel}`,
    ...instructions.flatMap((instruction) => [
      `**${instruction.group}:**`,
      `✨ Dose : ${instruction.text}`,
    ]),
    '🔴 No brands could be found for this formulation',
  ];

  return renderDrugDoseBlock(lines.join('\n'));
};

const classifyRenderedBrandBlockPriority = (content: string): 0 | 1 | 2 => {
  if (/\[same strength dosing already listed above\]/i.test(content)) {
    return 1;
  }

  if (/(?:^|\n)🔴\s/m.test(content)) {
    return 2;
  }

  return 0;
};

const groupBlocksByHeading = (
  indications: AskDrugDoseIndication[],
  selectedIndication: AskDrugDoseIndication,
  brands: DeterministicPromptBrand[],
  requestedDoseAudience: DrugDoseAudience,
  requestedIndicationQuery?: string,
): DeterministicBrandBlock[] => {
  const routeMappings = buildRouteMappings(selectedIndication);
  const brandBlocks: DeterministicBrandBlock[] = [];
  const seenHeadingOrders = new Map<string, number>();
  const seenHeadingCoverage = new Set<string>();
  const seenRouteCoverage = new Set<number>();
  const duplicateKeySeen = new Set<string>();
  const duplicateKeyHasDose = new Map<string, boolean>();
  let duplicateCollapseCount = 0;
  let sequence = 0;

  for (const brand of brands) {
    for (const detail of brand.parsed_details) {
      const heading = detail.formulation;
      const matchedIndicationSelection = selectIndicationForDetail(
        indications,
        selectedIndication,
        detail,
        requestedDoseAudience,
        requestedIndicationQuery,
      );
      const matchedRouteMappings = matchedIndicationSelection?.routeMappings || [];
      const matchedIndicationLabel =
        matchedIndicationSelection?.indication.indication || selectedIndication.indication;
      const headingOrder = matchedRouteMappings[0]?.order ?? Number.MAX_SAFE_INTEGER;
      if (!seenHeadingOrders.has(heading)) {
        seenHeadingOrders.set(heading, headingOrder);
      } else {
        seenHeadingOrders.set(heading, Math.min(seenHeadingOrders.get(heading) || headingOrder, headingOrder));
      }

      if (matchedRouteMappings.length > 0) {
        seenHeadingCoverage.add(heading);
        matchedRouteMappings.forEach((routeMapping) => seenRouteCoverage.add(routeMapping.order));
      }

      const duplicateKey = [
        heading,
        normalizeCompact(detail.strength),
        detail.release_type || '',
        detail.is_paediatric ? 'paed' : 'general',
      ].join('|');
      const hasDoseForBlock = brandBlockHasRenderableDose(
        detail,
        matchedRouteMappings,
        requestedDoseAudience,
      );
      const referenceOnly = duplicateKeySeen.has(duplicateKey) && duplicateKeyHasDose.get(duplicateKey) === true;
      if (!referenceOnly) {
        duplicateKeySeen.add(duplicateKey);
        if (!duplicateKeyHasDose.has(duplicateKey)) {
          duplicateKeyHasDose.set(duplicateKey, hasDoseForBlock);
        }
      } else {
        duplicateCollapseCount += 1;
      }

      const content = renderBrandBlock(
        brand,
        detail,
        matchedIndicationLabel,
        matchedRouteMappings,
        requestedDoseAudience,
        referenceOnly,
      );
      const queryPriority: 0 | 1 =
        requestedIndicationQuery &&
        scoreIndicationMatch(matchedIndicationLabel, requestedIndicationQuery) >= 300
          ? 0
          : 1;

      brandBlocks.push({
        heading,
        sortOrder: seenHeadingOrders.get(heading) || headingOrder,
        intraGroupOrder: sequence,
        priority: classifyRenderedBrandBlockPriority(content),
        queryPriority,
        content,
      });
      sequence += 1;
    }
  }

  const noBrandBlocks: DeterministicBrandBlock[] = [];
  const missingRouteMappingsByHeading = new Map<string, RouteMapping[]>();
  for (const routeMapping of routeMappings) {
    if (seenRouteCoverage.has(routeMapping.order)) continue;
    for (const heading of missingBrandHeadingsForRoute(routeMapping)) {
      if (seenHeadingCoverage.has(heading)) continue;
      const existing = missingRouteMappingsByHeading.get(heading) || [];
      existing.push(routeMapping);
      missingRouteMappingsByHeading.set(heading, existing);
    }
  }

  for (const [heading, headingRouteMappings] of missingRouteMappingsByHeading.entries()) {
    noBrandBlocks.push({
      heading,
      sortOrder: Math.min(...headingRouteMappings.map((routeMapping) => routeMapping.order)),
      intraGroupOrder: sequence,
      priority: 2,
      // Keep no-dose fallback blocks after real dosing blocks, even for a matching indication.
      queryPriority: 1,
      content: renderNoBrandRouteBlock(selectedIndication.indication, headingRouteMappings),
    });
    sequence += 1;
  }

  console.log('[DRUG DETERMINISTIC]', 'Grouped deterministic dose blocks', {
    selectedIndication: selectedIndication.indication,
    duplicateCollapseCount,
    skippedFormulations: uniqueStrings(
      brandBlocks
        .filter((block) => /No dosing information was present in dose and indications/.test(block.content))
        .map((block) => block.heading),
    ),
    noBrandFormulations: uniqueStrings(noBrandBlocks.map((block) => block.heading)),
  });

  return [...brandBlocks, ...noBrandBlocks];
};

const renderGroupedBlocks = (blocks: DeterministicBrandBlock[]): string => {
  if (blocks.length === 0) return '';

  const grouped = new Map<string, { sortOrder: number; blocks: DeterministicBrandBlock[] }>();
  for (const block of blocks) {
    const existing = grouped.get(block.heading);
    if (existing) {
      existing.sortOrder = Math.min(existing.sortOrder, block.sortOrder);
      existing.blocks.push(block);
    } else {
      grouped.set(block.heading, {
        sortOrder: block.sortOrder,
        blocks: [block],
      });
    }
  }

  return Array.from(grouped.entries())
    .sort((left, right) => {
      const leftMinQueryPriority = Math.min(...left[1].blocks.map((block) => block.queryPriority));
      const rightMinQueryPriority = Math.min(...right[1].blocks.map((block) => block.queryPriority));

      if (leftMinQueryPriority !== rightMinQueryPriority) {
        return leftMinQueryPriority - rightMinQueryPriority;
      }

      const leftMinPriority = Math.min(...left[1].blocks.map((block) => block.priority));
      const rightMinPriority = Math.min(...right[1].blocks.map((block) => block.priority));

      if (leftMinPriority !== rightMinPriority) {
        return leftMinPriority - rightMinPriority;
      }

      const leftWarningCount = left[1].blocks.filter((block) => block.priority === 2).length;
      const rightWarningCount = right[1].blocks.filter((block) => block.priority === 2).length;

      if (leftWarningCount !== rightWarningCount) {
        return leftWarningCount - rightWarningCount;
      }

      if (left[1].sortOrder !== right[1].sortOrder) {
        return left[1].sortOrder - right[1].sortOrder;
      }

      return left[0].localeCompare(right[0]);
    })
    .map(
      ([heading, group]) =>
        [
          `**✅ ${heading}**`,
          ...group.blocks
            .slice()
            .sort((left, right) => {
              if (left.queryPriority !== right.queryPriority) {
                return left.queryPriority - right.queryPriority;
              }
              if (left.priority !== right.priority) {
                return left.priority - right.priority;
              }
              return left.intraGroupOrder - right.intraGroupOrder;
            })
            .map((block) => block.content),
        ]
          .filter(Boolean)
          .join('\n\n'),
    )
    .join('\n\n')
    .trim();
};

export const buildDeterministicDoseWithBrandsBody = (
  promptContext: Record<string, unknown>,
  requestedIndicationQuery?: string | null,
  requestedDoseAudience: DrugDoseAudience = 'adult',
): string | null => {
  const clinicalContextSource = compactField(String(promptContext.clinical_context_source || '')) || '';
  if (clinicalContextSource !== 'ask_drug_indications_and_dose') {
    console.log('[DRUG DETERMINISTIC]', 'Ineligible deterministic dose formatting', {
      reason: 'non_structured_context',
      clinicalContextSource,
    });
    return null;
  }

  const context = toDeterministicDoseContext(promptContext, requestedDoseAudience);
  if (!context) {
    console.log('[DRUG DETERMINISTIC]', 'Ineligible deterministic dose formatting', {
      reason: 'missing_structured_context_or_brands',
      requestedDoseAudience,
    });
    return null;
  }

  const selected = selectIndication(
    context.indications,
    context.brands,
    requestedDoseAudience,
    compactField(requestedIndicationQuery || undefined),
  );
  if (!selected) {
    console.log('[DRUG DETERMINISTIC]', 'Ineligible deterministic dose formatting', {
      reason: 'no_selected_indication',
      indicationCount: context.indications.length,
    });
    return null;
  }

  const normalizedRequestedIndicationQuery = compactField(requestedIndicationQuery || undefined);
  const prioritizedIndications = normalizedRequestedIndicationQuery
    ? [...context.indications].sort((left, right) => {
        const leftLabel = normalizeCompact(left.indication);
        const rightLabel = normalizeCompact(right.indication);
        const queryLabel = normalizeCompact(normalizedRequestedIndicationQuery);

        const score = (label: string): number => {
          if (!label || !queryLabel) return 0;
          if (label === queryLabel) return 4;
          if (label.includes(queryLabel) || queryLabel.includes(label)) return 3;
          return 1;
        };

        const leftScore = score(leftLabel);
        const rightScore = score(rightLabel);
        if (leftScore !== rightScore) return rightScore - leftScore;
        return 0;
      })
    : context.indications;

  logDeterministicText(
    '[DRUG DETERMINISTIC PARSED INDICATIONS]',
    `Parsed indications and dose:\n${JSON.stringify(
      {
        generic_name: context.genericName,
        indication_count: prioritizedIndications.length,
        indications: summarizeStructuredIndicationsForLog(prioritizedIndications),
      },
      null,
      2,
    )}`,
  );

  logDeterministicText(
    '[DRUG DETERMINISTIC DRUG LIST]',
    `Matched drug entry or entries:\n${JSON.stringify(
      {
        generic_name: context.genericName,
        brand_count: context.brands.length,
        filtered_proprietary_preparations: summarizePromptBrandsForLog(context.brands),
      },
      null,
      2,
    )}`,
  );

  if (selected.indication.routes.length === 0) {
    console.log('[DRUG DETERMINISTIC]', 'Ineligible deterministic dose formatting', {
      reason: 'selected_indication_has_no_routes',
      selectedIndication: selected.indication.indication,
    });
    return null;
  }

  console.log('[DRUG DETERMINISTIC]', 'Selected deterministic indication', {
    requestedIndicationQuery: compactField(requestedIndicationQuery || undefined) || null,
    selectedIndication: selected.indication.indication,
    score: selected.score,
    reason: selected.reason,
    requestedDoseAudience,
  });

  const groupedBlocks = groupBlocksByHeading(
    prioritizedIndications,
    selected.indication,
    context.brands,
    requestedDoseAudience,
    compactField(requestedIndicationQuery || undefined),
  );
  const rendered = renderGroupedBlocks(groupedBlocks);

  if (!rendered) {
    console.log('[DRUG DETERMINISTIC]', 'Ineligible deterministic dose formatting', {
      reason: 'no_renderable_blocks',
      selectedIndication: selected.indication.indication,
    });
    return null;
  }

  return rendered;
};
