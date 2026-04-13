const PLACEHOLDER_TEXT = 'not found in provided sources.';

const headingPattern = /^(\s*)(#{1,6})\s+(.+?)\s*$/;

const isPlaceholderLine = (line: string): boolean => {
  const normalized = line
    .trim()
    .replace(/^[-*•]\s*/, '')
    .replace(/^>\s*/, '')
    .replace(/\s*\[\d+(?:,\s*\d+)*\]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

  return normalized === PLACEHOLDER_TEXT || normalized === PLACEHOLDER_TEXT.slice(0, -1);
};

const isEmptyOrPlaceholder = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.length === 0 || isPlaceholderLine(trimmed);
};

/**
 * Remove markdown sections that only contain the "Not found in provided sources." placeholder.
 * This keeps the answer clean without changing how the model is asked to respond.
 */
export function removePlaceholderOnlySections(markdown: string): string {
  if (!markdown || markdown.trim().length === 0) {
    return markdown;
  }

  const lines = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const output: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const headingMatch = lines[i].match(headingPattern);

    if (!headingMatch) {
      output.push(lines[i]);
      i += 1;
      continue;
    }

    const level = headingMatch[2].length;
    const blockStart = i;
    i += 1;

    while (i < lines.length) {
      const nextHeadingMatch = lines[i].match(headingPattern);
      if (nextHeadingMatch && nextHeadingMatch[2].length <= level) {
        break;
      }
      i += 1;
    }

    const blockLines = lines.slice(blockStart, i);
    const bodyLines = blockLines.slice(1).filter((line) => line.trim().length > 0);
    const isPlaceholderOnly = bodyLines.length > 0 && bodyLines.every(isEmptyOrPlaceholder);

    if (!isPlaceholderOnly) {
      output.push(...blockLines);
    } else {
      while (output.length > 0 && output[output.length - 1].trim().length === 0) {
        output.pop();
      }
    }
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
