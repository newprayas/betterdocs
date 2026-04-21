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

const buildDrugIndicationActionHref = (
  drugName: string,
  indication: string,
  audience?: 'adult' | 'child',
): string | null => {
  const drug = compactField(drugName);
  const target = compactField(indication);
  if (!drug || !target) return null;

  const params = new URLSearchParams({
    drug,
    indication: target,
  });
  if (audience) {
    params.set('audience', audience);
  }

  return `${DRUG_ACTION_LINK_PROTOCOL}//${DRUG_ACTION_LINK_HOST}?${params.toString()}`;
};

const buildDrugAudienceActionHref = (
  drugName: string,
  audience: 'adult' | 'child',
): string | null => {
  const drug = compactField(drugName);
  if (!drug) return null;

  const params = new URLSearchParams({
    drug,
    audience,
  });

  return `${DRUG_ACTION_LINK_PROTOCOL}//${DRUG_ACTION_LINK_HOST}?${params.toString()}`;
};

const escapeMarkdownLinkText = (value: string): string =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');

const DRUG_DOSE_STYLE_QUERY_PATTERN =
  /\b(dose|doses|dosage|dosing|schedule|regimen|how much|how many)\b/i;

export const shouldDecorateIndicationLinksForQuery = (query: string): boolean => {
  const compact = query.trim();
  if (!compact) return false;
  return DRUG_DOSE_STYLE_QUERY_PATTERN.test(compact);
};

export const buildDrugIndicationFollowUpQuery = (
  drugName: string,
  indication: string,
  audience?: 'adult' | 'child',
): string => {
  const drug = compactField(drugName);
  const target = compactField(indication);
  if (!drug || !target) return compactField(drugName) || '';
  return audience ? `dose of ${drug} for ${target} for ${audience}` : `dose of ${drug} for ${target}`;
};

export const buildDrugAudienceFollowUpQuery = (
  drugName: string,
  audience: 'adult' | 'child',
): string => {
  const drug = compactField(drugName);
  if (!drug) return compactField(drugName) || '';
  return `dose of ${drug} for ${audience}`;
};

export const parseDrugActionHref = (
  href: string,
): { drugName: string; indication?: string; audience?: 'adult' | 'child'; action?: 'dose' | 'brands' } | null => {
  try {
    const normalized = href.trim();
    const legacyMatch = normalized.match(/^drug-action:(?:\/\/)?([a-z-]+)(?:\?(.*))?$/i);
    if (!legacyMatch) {
      const url = new URL(href);
      if (url.protocol !== DRUG_ACTION_LINK_PROTOCOL || url.hostname !== DRUG_ACTION_LINK_HOST) {
        return null;
      }

      const drugName = compactField(url.searchParams.get('drug') || '');
      const indication = compactField(url.searchParams.get('indication') || '');
      const audience = compactField(url.searchParams.get('audience') || '') as 'adult' | 'child' | undefined;
      const action = compactField(url.searchParams.get('action') || '') as 'dose' | 'brands' | undefined;
      if (!drugName || (!indication && !audience && action !== 'brands')) return null;

      return {
        drugName,
        indication: indication || undefined,
        audience,
        action: action || 'dose',
      };
    }

    const params = new URLSearchParams(legacyMatch[2] || '');
    const drugName = compactField(params.get('drug') || '');
    const indication = compactField(params.get('indication') || '');
    const audience = compactField(params.get('audience') || '') as 'adult' | 'child' | undefined;
    const action = compactField(params.get('action') || '') as 'dose' | 'brands' | undefined;
    const pathAction = compactField(legacyMatch[1] || '') as 'dose' | 'brands' | undefined;
    if (!drugName || (!indication && !audience && action !== 'brands' && pathAction !== 'brands')) return null;

    return {
      drugName,
      indication: indication || undefined,
      audience,
      action: action || pathAction || 'dose',
    };
  } catch {
    return null;
  }
};

export const isDrugActionHref = (href?: string | null): boolean => {
  if (!href) return false;
  return /^drug-action:(?:\/\/)?[a-z-]+(?:\?|$)/i.test(href.trim());
};

const linkifyIndicationLine = (
  line: string,
  drugName: string,
  audience?: 'adult' | 'child',
): string => {
  const trimmed = line.trim();
  if (!trimmed) return line;

  const bulletMatch = trimmed.match(/^([-*•])\s+(.*)$/);
  const bullet = bulletMatch?.[1] || '';
  const content = bulletMatch?.[2] || trimmed;
  const href = buildDrugIndicationActionHref(drugName, content, audience);
  if (!href) return line;

  const rebuilt = `[${escapeMarkdownLinkText(content)}](${href})`;
  return bullet ? `${bullet} ${rebuilt}` : rebuilt;
};

export const buildDrugAudienceLinkLabel = (audience: 'adult' | 'child'): string =>
  audience === 'child' ? 'CHILD DOSE' : 'ADULT DOSE';

export const buildDrugAudienceActionLink = (
  drugName: string,
  audience: 'adult' | 'child',
): string | null => buildDrugAudienceActionHref(drugName, audience);

export const decorateIndicationLinks = (
  content: string,
  drugName: string,
  audience?: 'adult' | 'child',
): string => {
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
      const decoratedLine = linkifyIndicationLine(line, seedDrugName, audience);
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
