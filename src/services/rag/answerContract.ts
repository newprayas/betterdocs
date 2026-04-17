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
const THOROUGHNESS_INSTRUCTION = '- Be thorough and complete. If the source contains multiple relevant points, include all of them rather than stopping early.';
const HIGH_SENSITIVITY_INSTRUCTION = '- Read each chunk carefully and include all relevant information from every chunk that supports the answer. Be sensitive to small but important details.';
const RELATED_DETAIL_INSTRUCTION = '- If a retrieved chunk contains extra relevant detail beyond the exact question, include that detail too under a suitable heading or subheading, as long as it is explicitly present in the source.';
const STRUCTURED_EXTRACTION_INSTRUCTION = '- If a chunk contains a table, figure, summary box, scoring system, list, or criteria set, unpack all relevant rows, items, components, and thresholds from it instead of only naming the heading or headline.';

export function getAnswerContract(intent: QueryIntent): AnswerContract {
  switch (intent) {
    case 'definition':
      return {
        intent,
        label: 'Definition',
        sections: [
          { title: 'Definition', guidance: 'Give a direct definition first. Do not include features or causes here.' },
          { title: 'Key Points', guidance: 'Add essential characteristics and context. Do not include treatment or investigations.' },
        ],
      };
    case 'causes':
      return {
        intent,
        label: 'Causes',
        sections: [
          { title: 'Primary Causes', guidance: 'List main, direct causes clearly. Do not list predisposing risk factors here.' },
          { title: 'Secondary/Other Causes', guidance: 'List additional or less common causes. Keep distinct from primary causes.' },
        ],
      };
    case 'classification_types':
      return {
        intent,
        label: 'Classification',
        sections: [
          { title: 'Classification', guidance: 'Provide every distinct classification system, diagnostic criteria set, severity grading rule, type, subtype, and distinguishing detail found in the source. Keep each system separate. For tables or criteria sets, include all rows, grades, thresholds, suspected/definite criteria, and definitions. Do not skip intermediate grades or later items.' },
        ],
      };
    case 'risk_factors':
      return {
        intent,
        label: 'Risk Factors',
        sections: [
          { title: 'Major Risk Factors', guidance: 'List major factors first. Only include factors that increase risk, not direct causes.' },
          { title: 'Minor/Predisposing Factors', guidance: 'Include secondary or predisposing factors from context. Maintain distinction from major factors.' },
        ],
      };
    case 'difference_between':
      return {
        intent,
        label: 'Difference Between',
        sections: [
          { title: 'Key Differences', guidance: 'Compare entities point-by-point. Focus strictly on contrasting features.' },
          { title: 'Practical Distinction', guidance: 'Include clinically useful distinction if available. Do not repeat the key differences.' },
        ],
      };
    case 'investigations':
      return {
        intent,
        label: 'Investigations',
        sections: [
          { title: 'Initial Investigations', guidance: 'List first-line or bedside tests. Do not include definitive diagnostics here.' },
          { title: 'Confirmatory Investigations', guidance: 'List definitive, confirmatory, or second-line imaging/tests. Keep strictly separate from initial tests.' },
        ],
      };
    case 'treatment_rx':
      return {
        intent,
        label: 'Treatment',
        sections: [
          { title: 'Conservative/Medical Treatment', guidance: 'List non-procedural lifestyle and medical options. Do not include surgical steps.' },
          { title: 'Procedural/Surgical Treatment', guidance: 'List procedural interventions if present. Keep separate from medical management.' },
        ],
      };
    case 'complications':
      return {
        intent,
        label: 'Complications',
        sections: [
          { title: 'Disease Complications', guidance: 'List complications of the natural disease process itself. Use flat bullet points under this heading, do not use nested ### sub-headings.' },
          { title: 'Post-operative Complications', guidance: 'List complications occurring only after treatment/surgery. Group as flat bullet points, do not use nested ### sub-headings.' },
        ],
      };
    case 'prognosis':
      return {
        intent,
        label: 'Prognosis',
        sections: [
          { title: 'Prognosis/Outcome', guidance: 'State the expected course or overall outcome from sources. Do not list complications here.' },
          { title: 'Factors Affecting Outcome', guidance: 'List specific factors that worsen or improve the outcome if available.' },
        ],
      };
    case 'clinical_features_history_exam':
      return {
        intent,
        label: 'Clinical Features',
        sections: [
          { title: 'History Findings', guidance: 'Symptoms and history points only. What the patient reports.' },
          { title: 'Examination Findings', guidance: 'Exam signs only. What the clinician observes. Do not mix with history.' },
        ],
      };
    case 'how_to_procedure':
      return {
        intent,
        label: 'Procedure',
        sections: [
          { title: 'Pre-Procedure Setup', guidance: 'Preparation, positioning, and setup steps. Do not include actual surgical steps.' },
          { title: 'Step-by-Step Procedure', guidance: 'Use ordered steps with continuous numbering. Start from incision/entry.' },
        ],
      };
    default:
      return {
        intent: 'generic_fallback',
        label: 'Structured Answer',
        sections: [
          { title: 'Key Points', guidance: 'Answer the question directly and include the source-backed details in the same section. Break the answer into short subheadings when the retrieved chunks form different related groups. Do not repeat the same facts in a separate direct-answer block.' },
        ],
      };
  }
}

export function buildContractPromptInstructions(contract: AnswerContract): string {
  const sectionLines = contract.sections
    .map((section, index) => `${index + 1}) ${section.title}: ${section.guidance}`)
    .join('\n');

  return `Strict markdown. Structure: ## Section title, ### Subheading, - bullet claim.

Rules:
- Use ONLY provided context. No external knowledge.
- No citation markers, code fences, or commentary.
- Use contract section titles below as top-level headings.
- Add ### subsections when source has natural groups or subtypes.
- Only output claims explicitly present in retrieved text.
- Unpack tables, criteria sets, and scoring systems fully.
- Write full descriptive bullets, not single words.
- If a section is missing from sources: "${DEFAULT_PLACEHOLDER}"
- Keep section titles exactly as listed.

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
  working = ensureClassificationWrapper(working, contract);
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

  working = expandInlineBulletLists(working);
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

function ensureClassificationWrapper(text: string, contract: AnswerContract): string {
  if (contract.intent !== 'classification_types') {
    return text;
  }

  if (/^\s*##\s+Classification\b/im.test(text)) {
    return text;
  }

  const hasClassificationSubsections =
    /^\s*##\s+(?:Diagnostic criteria|Severity grading|Grade I|Grade II|Grade III)\b/im.test(text) ||
    /^\s*###\s+(?:Diagnostic criteria|Severity grading|Grade I|Grade II|Grade III)\b/im.test(text);

  if (!hasClassificationSubsections) {
    return text;
  }

  return `## Classification\n${text.trim()}`;
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

function expandInlineBulletLists(text: string): string {
  const lines = text.split('\n');
  const expanded: string[] = [];

  for (const line of lines) {
    if (!line.includes('•')) {
      expanded.push(line);
      continue;
    }

    const orderedMatch = line.match(/^(\s*)(\d+\.)\s+(.+)$/);
    const bulletMatch = line.match(/^(\s*)([-*])\s+(.+)$/);

    if (orderedMatch) {
      expanded.push(...expandCompositeLine(orderedMatch[1], `${orderedMatch[2]} `, orderedMatch[3]));
      continue;
    }

    if (bulletMatch) {
      expanded.push(...expandCompositeLine(bulletMatch[1], `${bulletMatch[2]} `, bulletMatch[3]));
      continue;
    }

    expanded.push(...expandCompositeLine('', '', line.trim()));
  }

  return expanded.join('\n');
}

function expandCompositeLine(indent: string, prefix: string, content: string): string[] {
  const bulletParts = content
    .split(/\s*•\s*/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (bulletParts.length <= 1) {
    return [`${indent}${prefix}${content}`.trimEnd()];
  }

  const leaderCandidate = bulletParts[0].replace(/[-–—:]\s*$/, '').trim();
  const hasLeader = bulletParts[0] !== leaderCandidate;
  const lines: string[] = [];
  const childIndent = `${indent}   `;
  const grandchildIndent = `${childIndent}  `;

  if (hasLeader && leaderCandidate) {
    lines.push(`${indent}${prefix}${leaderCandidate}`.trimEnd());
  } else if (prefix) {
    lines.push(`${indent}${prefix}${bulletParts.shift()!}`.trimEnd());
  }

  const partsToRender = hasLeader ? bulletParts.slice(1) : bulletParts;

  for (const part of partsToRender) {
    const split = splitLabelAndDetail(part);
    if (split) {
      lines.push(`${childIndent}- ${split.label}`);
      lines.push(`${grandchildIndent}- ${split.detail}`);
    } else {
      lines.push(`${childIndent}- ${part}`);
    }
  }

  return lines.length > 0 ? lines : [`${indent}${prefix}${content}`.trimEnd()];
}

function splitLabelAndDetail(text: string): { label: string; detail: string } | null {
  const colonIndex = text.indexOf(':');
  if (colonIndex <= 0 || colonIndex >= text.length - 1) {
    return null;
  }

  const label = text.slice(0, colonIndex).trim();
  const detail = text.slice(colonIndex + 1).trim();
  const labelWordCount = label.split(/\s+/).filter(Boolean).length;

  if (!label || !detail || labelWordCount > 8) {
    return null;
  }

  return { label, detail };
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
      const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        // Strip trailing colon so getMissingSections can match reliably.
        const headingText = headingMatch[2].trim().replace(/:$/, '');
        return `${headingMatch[1]} ${headingText}`;
      }
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
    const headingPattern = new RegExp(`^#{1,6}\\s*${escaped}\\s*:?\\s*$`, 'im');
    const boldPattern = new RegExp(`^\\*\\*\\s*${escaped}\\s*\\*\\*:?\\s*$`, 'im');
    const plainPattern = new RegExp(`^${escaped}:?\\s*$`, 'im');
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
