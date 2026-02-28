import type { QueryIntent } from './queryIntent';

export interface AnswerSection {
  title: string;
  guidance: string;
}

export interface AnswerContract {
  intent: QueryIntent;
  label: string;
  sections: AnswerSection[];
}

export interface ContractValidationResult {
  content: string;
  passBeforeFix: boolean;
  passAfterFix: boolean;
  hadNumberingFix: boolean;
  hadMissingSectionFill: boolean;
  removedHorizontalRules: number;
  removedEmptyFragments: number;
  missingSections: string[];
}

interface ContractCheck {
  hasHorizontalRules: boolean;
  hasSkippedNumbering: boolean;
  hasEmptyHeading: boolean;
  missingSections: string[];
}

const DEFAULT_PLACEHOLDER = '- Not found in provided sources.';

export function getAnswerContract(intent: QueryIntent): AnswerContract {
  switch (intent) {
    case 'definition':
      return {
        intent,
        label: 'Definition',
        sections: [
          { title: 'Definition', guidance: 'Give a direct definition first.' },
          { title: 'Key Points', guidance: 'Add essential characteristics and context.' },
          { title: 'Subtype Note', guidance: 'Mention relevant subtypes if present in sources.' },
        ],
      };
    case 'causes':
      return {
        intent,
        label: 'Causes',
        sections: [
          { title: 'Primary Causes', guidance: 'List main causes clearly.' },
          { title: 'Secondary Causes', guidance: 'List additional or less common causes.' },
          { title: 'Important Notes', guidance: 'Add source-backed caveats or context.' },
        ],
      };
    case 'classification_types':
      return {
        intent,
        label: 'Classification',
        sections: [
          { title: 'Classification', guidance: 'Provide complete classification/types from sources.' },
          { title: 'Key Distinctions', guidance: 'State how groups differ where available.' },
        ],
      };
    case 'risk_factors':
      return {
        intent,
        label: 'Risk Factors',
        sections: [
          { title: 'Major Risk Factors', guidance: 'List major factors first.' },
          { title: 'Additional Risk Factors', guidance: 'Include secondary factors from context.' },
          { title: 'Important Notes', guidance: 'Highlight source-backed cautions.' },
        ],
      };
    case 'difference_between':
      return {
        intent,
        label: 'Difference Between',
        sections: [
          { title: 'Key Differences', guidance: 'Compare entities point-by-point.' },
          { title: 'Practical Distinction', guidance: 'Include clinically useful distinction if available.' },
        ],
      };
    case 'investigations':
      return {
        intent,
        label: 'Investigations',
        sections: [
          { title: 'Initial Investigations', guidance: 'List first-line tests.' },
          { title: 'Confirmatory Investigations', guidance: 'List confirmatory tests.' },
          { title: 'Special/Advanced Investigations', guidance: 'List advanced options when present.' },
        ],
      };
    case 'treatment_rx':
      return {
        intent,
        label: 'Treatment',
        sections: [
          { title: 'Conservative/Medical Treatment', guidance: 'List non-procedural treatment options.' },
          { title: 'Procedural/Surgical Treatment', guidance: 'List procedural interventions if present.' },
          { title: 'Follow-up and Monitoring', guidance: 'Include follow-up points from sources.' },
        ],
      };
    case 'clinical_features_history_exam':
      return {
        intent,
        label: 'Clinical Features',
        sections: [
          { title: 'History Findings', guidance: 'Symptoms and history points only.' },
          { title: 'Examination Findings', guidance: 'Exam signs only.' },
        ],
      };
    case 'how_to_procedure':
      return {
        intent,
        label: 'Procedure',
        sections: [
          { title: 'Pre-Procedure Setup', guidance: 'Preparation, positioning, and setup steps.' },
          { title: 'Step-by-Step Procedure', guidance: 'Use ordered steps with continuous numbering.' },
          { title: 'Safety Checks', guidance: 'Critical safety checks and decision points.' },
          { title: 'Bailout/Alternatives', guidance: 'Safer alternatives when standard path is not possible.' },
        ],
      };
    default:
      return {
        intent: 'generic_fallback',
        label: 'Structured Answer',
        sections: [
          { title: 'Direct Answer', guidance: 'Answer the question directly.' },
          { title: 'Key Points', guidance: 'Provide source-backed key details.' },
          { title: 'Source Gaps', guidance: 'Explicitly mention what is not available in sources.' },
        ],
      };
  }
}

export function buildContractPromptInstructions(contract: AnswerContract): string {
  const sectionLines = contract.sections
    .map((section, index) => `${index + 1}) ${section.title}: ${section.guidance}`)
    .join('\n');

  return `
Required output contract (${contract.label}):
- Use section headers and bullet points / numbered lists only.
- Do NOT use horizontal separators like ---.
- Do NOT skip numbering in ordered lists.
- Do NOT leave empty section headers.
- If a required section is missing from sources, include that section and write: "${DEFAULT_PLACEHOLDER}".
- Keep language simple and direct.

Required sections:
${sectionLines}
`.trim();
}

export function applyAnswerContract(
  input: string,
  contract: AnswerContract
): ContractValidationResult {
  const initial = normalizeLineBreaks(input);
  const before = runContractChecks(initial, contract);

  let working = initial;
  const horizontalRuleMatch = working.match(/^\s*([-_*])\1{2,}\s*$/gm);
  const removedHorizontalRules = horizontalRuleMatch ? horizontalRuleMatch.length : 0;
  working = working.replace(/^\s*([-_*])\1{2,}\s*$/gm, '');

  const emptyFragmentsMatch = working.match(/^\s*(?:[-*•]|\d+\.)\s*$/gm);
  const removedEmptyFragments = emptyFragmentsMatch ? emptyFragmentsMatch.length : 0;
  working = working.replace(/^\s*(?:[-*•]|\d+\.)\s*$/gm, '');

  working = normalizeHeadings(working);
  const numbering = renumberOrderedLists(working);
  working = numbering.content;

  let hadMissingSectionFill = false;
  const missingAfterFix = getMissingSections(working, contract);
  if (missingAfterFix.length > 0) {
    hadMissingSectionFill = true;
    for (const section of missingAfterFix) {
      working = `${working.trim()}\n\n## ${section}\n${DEFAULT_PLACEHOLDER}`;
    }
  }

  const emptyHeadingFix = fillEmptyHeadings(working);
  if (emptyHeadingFix.didFill) {
    hadMissingSectionFill = true;
    working = emptyHeadingFix.content;
  }

  working = cleanupSpacing(working);
  const after = runContractChecks(working, contract);

  if (!afterPasses(after)) {
    working = buildContractFallbackResponse(contract, 'Unable to fully validate structure from source-backed response.');
  }

  const finalCheck = runContractChecks(working, contract);

  return {
    content: working,
    passBeforeFix: afterPasses(before),
    passAfterFix: afterPasses(finalCheck),
    hadNumberingFix: numbering.hadFix,
    hadMissingSectionFill,
    removedHorizontalRules,
    removedEmptyFragments,
    missingSections: finalCheck.missingSections,
  };
}

export function buildContractFallbackResponse(contract: AnswerContract, reason?: string): string {
  const reasonLine = reason ? `- ${reason}` : '- Source detail is limited for this query.';
  const sections = contract.sections
    .map((section) => `## ${section.title}\n${DEFAULT_PLACEHOLDER}`)
    .join('\n\n');

  return `## Source Status\n${reasonLine}\n\n${sections}`.trim();
}

function normalizeLineBreaks(text: string): string {
  return (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function cleanupSpacing(text: string): string {
  return text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  return /^#{1,6}\s+/.test(trimmed);
}

function normalizeHeadings(text: string): string {
  const lines = text.split('\n');
  const normalized = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return '';

    const boldHeading = trimmed.match(/^\*\*([^*][^*]+)\*\*:?\s*$/);
    if (boldHeading) {
      return `## ${boldHeading[1].trim()}`;
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      return `## ${trimmed.replace(/^#{1,6}\s+/, '').trim()}`;
    }

    if (
      /:$/.test(trimmed) &&
      !/^[-*•]/.test(trimmed) &&
      !/^\d+\./.test(trimmed) &&
      trimmed.length <= 80 &&
      trimmed.split(/\s+/).length <= 8
    ) {
      return `## ${trimmed.slice(0, -1).trim()}`;
    }

    return line;
  });

  return normalized.join('\n');
}

function renumberOrderedLists(text: string): { content: string; hadFix: boolean } {
  const lines = text.split('\n');
  let inBlock = false;
  let counter = 0;
  let hadFix = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ordered = line.match(/^(\s*)(\d+)\.\s+(.+)$/);

    if (ordered) {
      const indent = ordered[1];
      const existing = parseInt(ordered[2], 10);
      const body = ordered[3];
      counter = inBlock ? counter + 1 : 1;
      if (existing !== counter) {
        hadFix = true;
      }
      lines[i] = `${indent}${counter}. ${body}`;
      inBlock = true;
      continue;
    }

    if (isHeadingLine(line) || /^[-*•]\s+/.test(line.trim())) {
      inBlock = false;
      counter = 0;
      continue;
    }

    if (!line.trim()) {
      continue;
    }

    inBlock = false;
    counter = 0;
  }

  return { content: lines.join('\n'), hadFix };
}

function fillEmptyHeadings(text: string): { content: string; didFill: boolean } {
  const lines = text.split('\n');
  let didFill = false;

  for (let i = 0; i < lines.length; i++) {
    if (!isHeadingLine(lines[i])) continue;

    let j = i + 1;
    let hasBody = false;

    while (j < lines.length) {
      const candidate = lines[j].trim();
      if (!candidate) {
        j++;
        continue;
      }
      if (isHeadingLine(lines[j])) break;
      hasBody = true;
      break;
    }

    if (!hasBody) {
      lines.splice(i + 1, 0, DEFAULT_PLACEHOLDER);
      didFill = true;
      i++;
    }
  }

  return { content: lines.join('\n'), didFill };
}

function getMissingSections(text: string, contract: AnswerContract): string[] {
  const missing: string[] = [];
  for (const section of contract.sections) {
    const escaped = escapeRegex(section.title);
    const headingPattern = new RegExp(`^#{1,6}\\s*${escaped}\\s*$`, 'im');
    const boldPattern = new RegExp(`^\\*\\*\\s*${escaped}\\s*\\*\\*:?\\s*$`, 'im');
    const plainPattern = new RegExp(`^${escaped}:\\s*$`, 'im');
    if (!headingPattern.test(text) && !boldPattern.test(text) && !plainPattern.test(text)) {
      missing.push(section.title);
    }
  }
  return missing;
}

function hasSkippedNumbering(text: string): boolean {
  const lines = text.split('\n');
  let inBlock = false;
  let expected = 1;

  for (const line of lines) {
    const ordered = line.match(/^\s*(\d+)\.\s+.+$/);
    if (ordered) {
      const value = parseInt(ordered[1], 10);
      if (!inBlock) {
        expected = 1;
        inBlock = true;
      }
      if (value !== expected) return true;
      expected += 1;
      continue;
    }

    if (isHeadingLine(line) || /^[-*•]\s+/.test(line.trim())) {
      inBlock = false;
      expected = 1;
      continue;
    }

    if (!line.trim()) continue;

    inBlock = false;
    expected = 1;
  }

  return false;
}

function hasEmptyHeadings(text: string): boolean {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!isHeadingLine(lines[i])) continue;
    let j = i + 1;
    let hasBody = false;
    while (j < lines.length) {
      const candidate = lines[j].trim();
      if (!candidate) {
        j++;
        continue;
      }
      if (isHeadingLine(lines[j])) break;
      hasBody = true;
      break;
    }
    if (!hasBody) return true;
  }
  return false;
}

function runContractChecks(text: string, contract: AnswerContract): ContractCheck {
  return {
    hasHorizontalRules: /^\s*([-_*])\1{2,}\s*$/m.test(text),
    hasSkippedNumbering: hasSkippedNumbering(text),
    hasEmptyHeading: hasEmptyHeadings(text),
    missingSections: getMissingSections(text, contract),
  };
}

function afterPasses(check: ContractCheck): boolean {
  return !check.hasHorizontalRules && !check.hasSkippedNumbering && !check.hasEmptyHeading && check.missingSections.length === 0;
}
