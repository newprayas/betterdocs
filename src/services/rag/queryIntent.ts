export type QueryIntent =
  | 'definition'
  | 'causes'
  | 'classification_types'
  | 'position_location'
  | 'risk_factors'
  | 'difference_between'
  | 'investigations'
  | 'treatment_rx'
  | 'complications'
  | 'prognosis'
  | 'clinical_features_history_exam'
  | 'how_to_procedure'
  | 'generic_fallback';

interface IntentRule {
  intent: QueryIntent;
  patterns: RegExp[];
}

const INTENT_RULES: IntentRule[] = [
  {
    intent: 'difference_between',
    patterns: [
      /\bdifference\s+between\b/i,
      /\bdifferentiate\b/i,
      /\bdistinguish\b/i,
      /\bcompare\b/i,
      /\bvs\.?\b/i,
      /\bversus\b/i,
    ],
  },
  {
    intent: 'how_to_procedure',
    patterns: [
      /\bstep[-\s]?by[-\s]?step\b/i,
      /\bprocedure\b/i,
      /\boperative\s+steps?\b/i,
      /\bhow\s+to\b/i,
      /\bperform(?:ing)?\b/i,
      /\btechnique\b/i,
    ],
  },
  {
    intent: 'risk_factors',
    patterns: [
      /\brisk\s+factors?\b/i,
      /\brisk\b/i,
      /\bpredisposing\s+factors?\b/i,
    ],
  },
  {
    intent: 'investigations',
    patterns: [
      /\binvestigations?\b/i,
      /\bworkup\b/i,
      /\bdiagnostic\s+tests?\b/i,
      /\bevaluation\b/i,
      /\binv\b/i,
    ],
  },
  {
    intent: 'treatment_rx',
    patterns: [
      /\btreat(?:ment)?\b/i,
      /\bmanagement\b/i,
      /\btherapy\b/i,
      /\brx\b/i,
      /\btx\b/i,
      /\btherapeutic\b/i,
    ],
  },
  {
    intent: 'complications',
    patterns: [
      /\bcomplications?\b/i,
      /\bsequelae\b/i,
      /\bconsequences?\b/i,
      /\badverse\s+outcomes?\b/i,
    ],
  },
  {
    intent: 'prognosis',
    patterns: [
      /\bprognosis\b/i,
      /\boutcomes?\b/i,
      /\boutlook\b/i,
      /\bcourse\b/i,
    ],
  },
  {
    intent: 'classification_types',
    patterns: [
      /\bclassification\b/i,
      /\bclassasfiation\b/i,
      /\btypes?\s+of\b/i,
      /\btypes?\b/i,
      /\bsubtypes?\b/i,
    ],
  },
  {
    intent: 'position_location',
    patterns: [
      /\bpositions?\s+of\b/i,
      /\blocations?\s+of\b/i,
      /\banatomical\s+positions?\b/i,
      /\bwhere\s+(?:is|are)\b/i,
      /\bwhere\s+does\b/i,
      /\blocated\b/i,
      /\bsituated\b/i,
      /\bsite\s+of\b/i,
      /\bsites\s+of\b/i,
      /\banatomical\s+location\b/i,
      /\banatomical\s+locations\b/i,
    ],
  },
  {
    intent: 'causes',
    patterns: [
      /\bcauses?\s+of\b/i,
      /\bcauses?\b/i,
      /\betiology\b/i,
      /\baetiology\b/i,
      /\betiopathogenesis\b/i,
    ],
  },
  {
    intent: 'clinical_features_history_exam',
    patterns: [
      /\bclinical\s+features?\b/i,
      /\bhistory\s+and\s+exam(?:ination)?\b/i,
      /\bhistory\s+and\s+examination\s+findings?\b/i,
      /\bsigns?\s+and\s+symptoms?\b/i,
      /\bexamination\s+findings?\b/i,
      /\bfeatures?\b/i,
    ],
  },
  {
    intent: 'definition',
    patterns: [
      /\bdefine\b/i,
      /\bdefinition\b/i,
      /\bdeinfitn\b/i,
      /\bwhat\s+is\b/i,
      /\bmeaning\s+of\b/i,
    ],
  },
];

export function classifyQueryIntent(query: string): QueryIntent {
  const normalized = (query || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'generic_fallback';
  }

  for (const rule of INTENT_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalized))) {
      return rule.intent;
    }
  }

  return 'generic_fallback';
}
