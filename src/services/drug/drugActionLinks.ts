const DRUG_ACTION_LINK_PROTOCOL = 'drug-action:';
const DRUG_ACTION_LINK_HOST = 'dose';

const compactField = (value?: string | null): string | undefined => {
  if (!value) return undefined;
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact || undefined;
};

const stripMarkdownDecorators = (value: string): string =>
  value.replace(/^\s*#{1,6}\s*/, '').replace(/^\*\*(.*)\*\*$/, '$1').trim();

const isIndicationsHeading = (line: string): boolean => {
  const stripped = stripMarkdownDecorators(line);
  return /^✅\s*Indications\b/i.test(stripped) || /^Indications\b/i.test(stripped);
};

const isIndicationsBoundary = (line: string): boolean => {
  const stripped = stripMarkdownDecorators(line);
  return (
    /^#{1,6}\s+/i.test(line) ||
    /^\*\*.+\*\*$/.test(line) ||
    (/^(?:✅|❌|⚠️)\s+/i.test(stripped) && !isIndicationsHeading(line))
  );
};

const buildDrugIndicationActionHref = (drugName: string, indication: string): string | null => {
  const drug = compactField(drugName);
  const target = compactField(indication);
  if (!drug || !target) return null;

  const params = new URLSearchParams({
    drug,
    indication: target,
  });

  return `${DRUG_ACTION_LINK_PROTOCOL}//${DRUG_ACTION_LINK_HOST}?${params.toString()}`;
};

export const buildDrugIndicationFollowUpQuery = (drugName: string, indication: string): string => {
  const drug = compactField(drugName);
  const target = compactField(indication);
  if (!drug || !target) return compactField(drugName) || '';
  return `dose of ${drug} for ${target}`;
};

export const parseDrugActionHref = (
  href: string,
): { drugName: string; indication: string } | null => {
  try {
    const normalized = href.trim();
    const legacyMatch = normalized.match(/^drug-action:(?:\/\/)?dose(?:\?(.*))?$/i);
    if (!legacyMatch) {
      const url = new URL(href);
      if (url.protocol !== DRUG_ACTION_LINK_PROTOCOL || url.hostname !== DRUG_ACTION_LINK_HOST) {
        return null;
      }

      const drugName = compactField(url.searchParams.get('drug') || '');
      const indication = compactField(url.searchParams.get('indication') || '');
      if (!drugName || !indication) return null;

      return { drugName, indication };
    }

    const params = new URLSearchParams(legacyMatch[1] || '');
    const drugName = compactField(params.get('drug') || '');
    const indication = compactField(params.get('indication') || '');
    if (!drugName || !indication) return null;

    return { drugName, indication };
  } catch {
    return null;
  }
};

export const isDrugActionHref = (href?: string | null): boolean => {
  if (!href) return false;
  return /^drug-action:(?:\/\/)?dose(?:\?|$)/i.test(href.trim());
};

const linkifyIndicationLine = (line: string, drugName: string): string => {
  const trimmed = line.trim();
  if (!trimmed) return line;

  const bulletMatch = trimmed.match(/^([-*•])\s+(.*)$/);
  const bullet = bulletMatch?.[1] || '';
  const content = bulletMatch?.[2] || trimmed;
  const segments = content
    .split(/\s*\|\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) return line;

  const linkedSegments = segments.map((segment) => {
    const href = buildDrugIndicationActionHref(drugName, segment);
    if (!href) return segment;
    return `[${segment}](${href})`;
  });

  const rebuilt = linkedSegments.join(' | ');
  return bullet ? `${bullet} ${rebuilt}` : rebuilt;
};

export const decorateIndicationLinks = (content: string, drugName: string): string => {
  const seedDrugName = compactField(drugName);
  if (!seedDrugName) return content;

  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const output: string[] = [];
  let inIndicationsSection = false;
  let didDecorate = false;

  for (const line of lines) {
    if (isIndicationsHeading(line)) {
      inIndicationsSection = true;
      output.push(line);
      continue;
    }

    if (inIndicationsSection && isIndicationsBoundary(line)) {
      inIndicationsSection = false;
      output.push(line);
      continue;
    }

    if (inIndicationsSection && line.trim()) {
      const decoratedLine = linkifyIndicationLine(line, seedDrugName);
      if (decoratedLine !== line) {
        didDecorate = true;
        console.log('[DRUG ACTION LINKS][DECORATE]', {
          drugName: seedDrugName,
          sourceLine: line,
          decoratedLine,
        });
      }
      output.push(decoratedLine);
      continue;
    }

    output.push(line);
  }

  return didDecorate ? output.join('\n') : content;
};
