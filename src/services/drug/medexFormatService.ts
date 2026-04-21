import type {
  AskDrugRequestedSection,
  MedexAlternateBrandRow,
  MedexBrandCard,
  MedexPackageInfo,
  MedexResolvedPayload,
  MedexSummaryBlock,
} from '@/types';
import { buildDrugAudienceActionLink, buildDrugAudienceLinkLabel } from './drugActionLinks';

const PREFERRED_BRAND_COMPANIES = [
  'square',
  'incepta',
  'healthcare',
  'opsonin',
  'beximco',
  'aristopharma',
  'novartis',
  'acme',
  'ziska',
  'renata',
  'radiant',
];

const FORMULATION_ORDER = [
  'tablet',
  'capsule',
  'oral suspension',
  'syrup',
  'suspension',
  'injection',
  'infusion',
  'suppository',
  'pediatric drop',
  'drops',
  'gel',
];

const compact = (value?: string | null): string =>
  value
    ?.replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || '';

const normalizeText = (value?: string | null): string =>
  compact(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const titleCase = (value: string): string =>
  value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const capitalizeFirst = (value?: string | null): string => {
  const trimmed = compact(value);
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
};

const buildDrugActionLink = (
  drugName: string,
  action: 'brands',
): string => `drug-action://dose?drug=${encodeURIComponent(drugName)}&action=${encodeURIComponent(action)}`;

const sectionHeading = (label: string): string => `✅ ${label}`;

const block = (title: string, lines: string[]): string => {
  const cleanLines = lines.map((line) => line.replace(/\s+$/g, ''));
  while (cleanLines.length > 0 && cleanLines[0] === '') {
    cleanLines.shift();
  }
  while (cleanLines.length > 0 && cleanLines[cleanLines.length - 1] === '') {
    cleanLines.pop();
  }
  if (cleanLines.length === 0) return '';
  return [title, '', ...cleanLines].join('\n');
};

const splitLines = (value?: string | null): string[] =>
  (value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const uniqueLines = (lines: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const key = normalizeText(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(line);
  }

  return result;
};

const formatBulletList = (lines: string[]): string[] => uniqueLines(lines).map((line) => `- ${line}`);

const companyPriority = (company?: string | null): number => {
  const normalized = normalizeText(company);
  if (!normalized) return PREFERRED_BRAND_COMPANIES.length + 1;
  const matched = PREFERRED_BRAND_COMPANIES.findIndex((item) => normalized.includes(item));
  return matched === -1 ? PREFERRED_BRAND_COMPANIES.length : matched;
};

const formulationPriority = (value?: string | null): number => {
  const normalized = normalizeText(value);
  if (!normalized) return FORMULATION_ORDER.length + 1;
  const matched = FORMULATION_ORDER.findIndex((item) => normalized.includes(item));
  return matched === -1 ? FORMULATION_ORDER.length : matched;
};

const cleanupLeadSentence = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';

  return trimmed
    .replace(/\s*\.\.\.\s*read more.*$/i, '')
    .replace(/^[^.:\n]+?\bis indicated(?: where)?(?: suppression of acid secretion has therapeutic benefit)?\s*[:\-]?\s*/i, '')
    .replace(/^[^.:\n]+?\bis indicated in(?: the short-term treatment of)?\s*[:\-]?\s*/i, '')
    .replace(/^[^.:\n]+?\bis indicated for\s*/i, '')
    .replace(/^[^.:\n]+?\bused in\s*[:\-]?\s*/i, '')
    .replace(/^[^.:\n]+?\bfor\s+/i, '')
    .trim();
};

const simplifyPriceText = (value?: string | null): string => {
  const text = compact(value);
  if (!text) return '';
  if (/^Unit Price:/i.test(text)) {
    const match = text.match(/Unit Price:\s*৳\s*[\d.]+/i);
    return compact(match?.[0] || text.replace(/\s*\([^)]*\)\s*$/g, ''));
  }
  return text;
};

const formatPriceSummary = (summary?: MedexSummaryBlock | null): string => {
  if (!summary) return '';
  const unit = compact(summary.unit_price_bdt || summary.pricing?.unit_price_bdt);
  const packageInfo = summary.pricing?.packages?.[0];

  if (unit) return `Unit price: ${unit}`;
  if (packageInfo?.label && packageInfo?.price_text) {
    return simplifyPriceText(`${compact(packageInfo.label)}: ${compact(packageInfo.price_text)}`);
  }
  if (packageInfo?.price_text) return simplifyPriceText(packageInfo.price_text);
  return '';
};

const stripTrailingFormulation = (value: string): string =>
  compact(value)
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\s+\d.*$/g, '')
    .trim();

const extractIndicationLines = (payload: MedexResolvedPayload): string[] => {
  const rawLines = splitLines(payload.sections.indications);
  if (rawLines.length === 0) return [];

  const cleaned = rawLines
    .map((line, index) => {
      const trimmed = line.replace(/\.\.\.\s*Read more.*$/i, '').trim();
      return index === 0 ? cleanupLeadSentence(trimmed) : trimmed;
    })
    .filter(Boolean);

  if (cleaned.length === 1) {
    return [cleaned[0].replace(/^[a-z]/, (char) => char.toUpperCase())];
  }

  return uniqueLines(cleaned);
};

type DoseEntry = {
  label: string;
  text: string;
};

type DoseSection = {
  heading: string;
  intro: string[];
  entries: DoseEntry[];
};

const FORMULATION_HEADING_PATTERN =
  /(?:tablet|capsule|syrup|suspension|suppository|drop|drops|infusion|injection|oral|iv|extended release|pediatric|paediatric)/i;

const ADULT_LINE_PATTERN =
  /^(adult|adults|elderly|adults?\s*&\s*children over|adults?\s+and\s+children over|adults?\s+and\s+adolescents|adolescents?\s+weighing|adults?\s+and\s+adolescents|life-threatening infections|urinary tract infections|impaired renal function)/i;

const CHILD_LINE_PATTERN =
  /^(child|children|neonate|neonates|premature children|infant|infants|paediatric|pediatric|children under|[0-9].*(month|months|year|years)|upto [0-9]|up to [0-9])/i;

const isFormulationHeading = (line: string): boolean => {
  const trimmed = compact(line).replace(/:$/, '');
  if (!trimmed) return false;
  if (ADULT_LINE_PATTERN.test(trimmed) || CHILD_LINE_PATTERN.test(trimmed)) return false;
  if (!FORMULATION_HEADING_PATTERN.test(trimmed)) return false;
  return trimmed.length <= 70;
};

const parseDoseSections = (payload: MedexResolvedPayload): DoseSection[] => {
  const rawLines = (payload.sections.dosage_and_administration || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => compact(line))
    .filter(Boolean);
  if (rawLines.length === 0) {
    return [];
  }

  const sections: DoseSection[] = [];
  let current: DoseSection | null = null;

  const pushCurrent = () => {
    if (!current) return;
    if (current.intro.length === 0 && current.entries.length === 0) return;
    sections.push({
      heading: current.heading,
      intro: [...current.intro],
      entries: [...current.entries],
    });
  };

  for (const rawLine of rawLines) {
    const line = compact(rawLine);
    if (!line) continue;

    const headingMatch = line.match(/^([^:\n]{2,120}?):\s*(.*)$/);
    if (headingMatch && isFormulationHeading(headingMatch[1])) {
      pushCurrent();
      current = {
        heading: compact(headingMatch[1]),
        intro: [],
        entries: [],
      };
      const remainder = capitalizeFirst(headingMatch[2]);
      if (remainder) {
        current.intro.push(remainder);
      }
      continue;
    }

    if (!current) {
      current = {
        heading: 'General',
        intro: [],
        entries: [],
      };
    }

    const entryMatch = line.match(/^([^:\n]{1,140}?):\s*(.+)$/);
    if (entryMatch) {
      current.entries.push({
        label: capitalizeFirst(entryMatch[1]),
        text: capitalizeFirst(entryMatch[2]),
      });
      continue;
    }

    if (current.entries.length > 0) {
      const lastEntry = current.entries[current.entries.length - 1];
      lastEntry.text = `${lastEntry.text} ${capitalizeFirst(line)}`.trim();
      continue;
    }

    current.intro.push(capitalizeFirst(line));
  }

  pushCurrent();
  return sections;
};

const isAdultRelevantLine = (line: string): boolean => {
  const trimmed = compact(line);
  if (!trimmed) return false;
  if (ADULT_LINE_PATTERN.test(trimmed)) return true;
  if (CHILD_LINE_PATTERN.test(trimmed)) return false;
  return !/children|child|months?|years?|paediatric|pediatric/i.test(trimmed);
};

const isChildRelevantLine = (line: string): boolean => {
  const trimmed = compact(line);
  if (!trimmed) return false;
  if (CHILD_LINE_PATTERN.test(trimmed)) return true;
  if (ADULT_LINE_PATTERN.test(trimmed)) return false;
  return /children|child|months?|years?|paediatric|pediatric/i.test(trimmed);
};

const filterDoseSectionsByAudience = (
  sections: DoseSection[],
  audience?: 'adult' | 'child',
): DoseSection[] => {
  if (!audience) return sections;

  return sections
    .map((section) => {
      const keptEntries = section.entries.filter((entry) =>
        audience === 'adult' ? isAdultRelevantLine(entry.label) : isChildRelevantLine(entry.label),
      );
      return {
        heading: section.heading,
        intro: keptEntries.length > 0 ? [...section.intro] : [],
        entries: keptEntries,
      };
    })
    .filter((section) => section.intro.length > 0 || section.entries.length > 0);
};

const normalizeDoseFormBucket = (value?: string | null): string => {
  const normalized = normalizeText(value);
  if (!normalized) return 'other';
  if (normalized.includes('actizorb')) return 'actizorb';
  if (normalized.includes('extended release')) return 'extended_release_tablet';
  if (normalized.includes('iv infusion')) return 'iv_infusion';
  if (normalized.includes('suppository')) return 'suppository';
  if (normalized.includes('pediatric drop') || normalized.includes('paediatric drop')) return 'pediatric_drop';
  if (normalized.includes('syrup') || normalized.includes('oral suspension') || normalized.includes('suspension')) {
    return 'syrup_suspension';
  }
  if (normalized.includes('tablet')) return 'tablet';
  if (normalized.includes('capsule')) return 'capsule';
  if (normalized.includes('injection')) return 'injection';
  return normalized;
};

const buildSameCompanyAlternateRows = (payload: MedexResolvedPayload): MedexAlternateBrandRow[] => {
  const manufacturer = normalizeText(payload.summary_above_indications?.manufacturer);
  if (!manufacturer) return [];

  return [...(payload.alternate_brands?.rows || [])]
    .filter((row) => normalizeText(row.company) === manufacturer)
    .sort((left, right) => {
      const formDelta = formulationPriority(left.dosage_form) - formulationPriority(right.dosage_form);
      if (formDelta !== 0) return formDelta;
      return compact(left.brand_name).localeCompare(compact(right.brand_name));
    });
};

const buildFormulationLinesForHeading = (
  payload: MedexResolvedPayload,
  heading: string,
): string[] => {
  if (payload.selected_kind !== 'brand') return [];

  const headingBucket = normalizeDoseFormBucket(heading);
  if (headingBucket === 'actizorb') return [];

  const rows = buildSameCompanyAlternateRows(payload).filter((row) => {
    const rowBucket = normalizeDoseFormBucket(row.dosage_form);
    if (headingBucket === 'tablet') {
      return rowBucket === 'tablet';
    }
    return rowBucket === headingBucket;
  });

  return rows.map((row) => {
    const label = [compact(row.brand_name), compact(row.strength)].filter(Boolean).join(' ');
    const price = simplifyPriceText(row.price_text);
    return `- ${label}${price ? ` [${price}]` : ''}`;
  });
};

const formatDoseSections = (
  payload: MedexResolvedPayload,
  audience?: 'adult' | 'child',
): string[] => {
  const sections = filterDoseSectionsByAudience(parseDoseSections(payload), audience);
  if (sections.length === 0) {
    return ['- Not found in MedEx dose section.'];
  }

  const lines: string[] = [];
  for (const section of sections) {
    lines.push(`🎉 *${section.heading.toUpperCase()}*`);
    lines.push('');

    const formulationLines = buildFormulationLinesForHeading(payload, section.heading);
    if (formulationLines.length > 0) {
      lines.push(...formulationLines);
      lines.push('');
    }

    for (const introLine of section.intro) {
      lines.push(capitalizeFirst(introLine));
      lines.push('');
    }

    for (const entry of section.entries) {
      lines.push(`**${capitalizeFirst(entry.label)}:**`);
      lines.push(capitalizeFirst(entry.text));
      lines.push('');
    }

    lines.push('');
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines;
};

const pickExampleBrand = (payload: MedexResolvedPayload): MedexBrandCard | null => {
  if (!Array.isArray(payload.available_brand_names) || payload.available_brand_names.length === 0) {
    return null;
  }

  const ranked = [...payload.available_brand_names].sort((left, right) => {
    const companyDelta = companyPriority(left.company) - companyPriority(right.company);
    if (companyDelta !== 0) return companyDelta;

    const formulationDelta = formulationPriority(left.price_label) - formulationPriority(right.price_label);
    if (formulationDelta !== 0) return formulationDelta;

    return compact(left.brand_name).localeCompare(compact(right.brand_name));
  });

  return ranked[0] || null;
};

const buildBrandSummaryLines = (
  payload: MedexResolvedPayload,
  options?: { originalQuery?: string },
): string[] => {
  const summary = payload.summary_above_indications;
  if (payload.selected_kind === 'brand') {
    const brandLabel = stripTrailingFormulation(
      compact(options?.originalQuery || payload.query || payload.selected_result_title),
    );
    const company = compact(summary?.manufacturer);
    const lines = [`- ${brandLabel}${company ? ` - ${company}` : ''}`];
    const sameCompanyRows = buildSameCompanyAlternateRows(payload);

    if (sameCompanyRows.length > 0) {
      lines.push('- Dosage Formulations:');

      const grouped = new Map<string, MedexAlternateBrandRow[]>();
      for (const row of sameCompanyRows) {
        const key = compact(row.dosage_form) || 'Other';
        const bucket = grouped.get(key) || [];
        bucket.push(row);
        grouped.set(key, bucket);
      }

      for (const [dosageForm, rows] of [...grouped.entries()].sort((left, right) => formulationPriority(left[0]) - formulationPriority(right[0]))) {
        lines.push(`  - **${dosageForm}**`);
        for (const row of rows) {
          const brandName = compact(row.brand_name);
          const strength = compact(row.strength);
          const price = simplifyPriceText(row.price_text);
          lines.push(`    - ${[brandName, strength].filter(Boolean).join(' ')}${price ? ` [${price}]` : ''}`);
        }
      }
    } else {
      const price = formatPriceSummary(summary);
      if (price) {
        lines.push(`- ${price}`);
      }
    }
    return lines;
  }

  const exampleBrand = pickExampleBrand(payload);
  if (!exampleBrand) return [];

  const price = compact(exampleBrand.price_text) || (compact(exampleBrand.price_bdt) ? `৳ ${compact(exampleBrand.price_bdt)}` : '');
  const lines = [
    `- ${compact(exampleBrand.brand_name)} ${compact(exampleBrand.strength)} - ${compact(exampleBrand.company)}`.trim(),
  ];
  if (price) {
    lines.push(`- Price: ${price}`);
  }
  return lines;
};

const resolveGenericName = (payload: MedexResolvedPayload): string =>
  compact(payload.summary_above_indications?.generic_name) ||
  compact(payload.selected_result_title) ||
  compact(payload.query);

const resolveDisplayTitle = (payload: MedexResolvedPayload, originalQuery?: string): string => {
  const genericName = resolveGenericName(payload);
  const query = compact(originalQuery || payload.query);
  if (payload.selected_kind === 'brand' && query && normalizeText(query) !== normalizeText(genericName)) {
    return `${titleCase(genericName)} (${titleCase(query)})`;
  }
  return titleCase(genericName);
};

const packagePriceLabel = (pkg?: MedexPackageInfo | null): string => {
  if (!pkg) return '';
  if (compact(pkg.label) && compact(pkg.price_text)) {
    return `${compact(pkg.label)}: ${compact(pkg.price_text)}${compact(pkg.pack_size_info) ? ` ${compact(pkg.pack_size_info)}` : ''}`;
  }
  if (compact(pkg.price_text)) return compact(pkg.price_text);
  return '';
};

type AlternateBrandDisplayRow = {
  dosageForm: string;
  brandName: string;
  company: string;
  strength: string;
  price: string;
};

const buildAlternateBrandRows = (rows: MedexAlternateBrandRow[]): AlternateBrandDisplayRow[] => {
  const seen = new Set<string>();
  const result: AlternateBrandDisplayRow[] = [];

  const ordered = [...rows].sort((left, right) => {
    const formulationDelta = formulationPriority(left.dosage_form) - formulationPriority(right.dosage_form);
    if (formulationDelta !== 0) return formulationDelta;

    const companyDelta = companyPriority(left.company) - companyPriority(right.company);
    if (companyDelta !== 0) return companyDelta;

    return compact(left.brand_name).localeCompare(compact(right.brand_name));
  });

  for (const row of ordered) {
    const displayRow: AlternateBrandDisplayRow = {
      dosageForm: compact(row.dosage_form) || 'Other',
      brandName: compact(row.brand_name),
      company: compact(row.company),
      strength: compact(row.strength),
      price: compact(row.price_text),
    };

    const key = [
      normalizeText(displayRow.dosageForm),
      normalizeText(displayRow.brandName),
      normalizeText(displayRow.company),
      normalizeText(displayRow.strength),
      normalizeText(displayRow.price),
    ].join('|');

    if (!displayRow.brandName || seen.has(key)) continue;
    seen.add(key);
    result.push(displayRow);
  }

  return result;
};

export const formatMedexDoseAnswer = (
  payload: MedexResolvedPayload,
  options?: { audience?: 'adult' | 'child'; originalQuery?: string },
): string => {
  const genericName = titleCase(resolveGenericName(payload));
  const headerLead =
    payload.selected_kind === 'brand'
      ? stripTrailingFormulation(compact(options?.originalQuery || payload.query || payload.selected_result_title)).toUpperCase()
      : genericName.toUpperCase();
  const lines: string[] = [`${headerLead} - Generic : ${genericName.toUpperCase()}`];

  if (options?.audience === 'adult') {
    const childHref = buildDrugAudienceActionLink(resolveGenericName(payload), 'child');
    const childLabel = buildDrugAudienceLinkLabel('child');
    lines.push(
      '',
      `⚠️ Only ADULT dose given, search child dose separately (${childHref ? `[${childLabel}](${childHref})` : childLabel})`,
    );
  }

  const brandSummaryLines = buildBrandSummaryLines(payload, options);
  if (brandSummaryLines.length > 0) {
    lines.push(
      '',
      block(sectionHeading(payload.selected_kind === 'brand' ? 'Selected brand' : 'Example brand'), brandSummaryLines),
    );
  }

  lines.push('', block(sectionHeading('Indications'), formatBulletList(extractIndicationLines(payload))));

  const contraindications = splitLines(payload.sections.contraindications);
  if (contraindications.length > 0) {
    lines.push('', block('❌ Contraindications', formatBulletList(contraindications)));
  }

  lines.push('', block(sectionHeading('Indications and dose'), formatDoseSections(payload, options?.audience)));

  const actionDrug = resolveGenericName(payload);
  if (actionDrug) {
    lines.push('', `[Search other brands](${buildDrugActionLink(actionDrug, 'brands')})`);
  }

  return lines.filter(Boolean).join('\n\n');
};

const mapSectionLabel = (section: AskDrugRequestedSection): string => {
  switch (section) {
    case 'contra_indications':
      return 'Contra indications';
    case 'side_effects':
      return 'Side effects';
    case 'breast_feeding':
      return 'Breast feeding';
    case 'important_safety_information':
      return 'Important safety information';
    case 'cautions':
      return 'Cautions';
    case 'pregnancy':
      return 'Pregnancy';
    case 'interactions':
      return 'Interactions';
    case 'indications_and_dose':
      return 'Indications and dose';
    default:
      return titleCase(section.replace(/_/g, ' '));
  }
};

const getSectionBody = (payload: MedexResolvedPayload, section: AskDrugRequestedSection): string[] => {
  switch (section) {
    case 'indications_and_dose':
      return [
        sectionHeading('Indications'),
        '',
        ...formatBulletList(extractIndicationLines(payload)),
        '',
        sectionHeading('Indications and dose'),
        '',
        ...formatDoseSections(payload),
      ];
    case 'contra_indications':
      return formatBulletList(splitLines(payload.sections.contraindications));
    case 'side_effects':
      return formatBulletList(splitLines(payload.sections.side_effects));
    case 'pregnancy':
      return formatBulletList(splitLines(payload.sections.pregnancy_and_lactation));
    case 'breast_feeding':
      return formatBulletList(splitLines(payload.sections.pregnancy_and_lactation));
    case 'important_safety_information':
    case 'cautions':
      return formatBulletList(splitLines(payload.sections.precautions_and_warnings));
    case 'interactions':
      return formatBulletList(splitLines(payload.sections.interaction));
    default:
      return [];
  }
};

export const formatMedexSectionAnswer = (
  payload: MedexResolvedPayload,
  sections: AskDrugRequestedSection[],
  originalQuery?: string,
): string => {
  const displayTitle = resolveDisplayTitle(payload, originalQuery);
  const blocks = [`## ${displayTitle}`];

  for (const section of sections) {
    const body = getSectionBody(payload, section);
    if (body.length === 0) continue;
    blocks.push(`### ${mapSectionLabel(section)}`, ...body, '');
  }

  return blocks.join('\n').trim();
};

export const formatMedexBrandsAnswer = (
  payload: MedexResolvedPayload,
  originalQuery?: string,
): string => {
  const displayTitle = resolveDisplayTitle(payload, originalQuery);
  const rows =
    payload.alternate_brands?.rows && payload.alternate_brands.rows.length > 0
      ? payload.alternate_brands.rows
      : payload.available_brand_names.map((item) => ({
          brand_name: item.brand_name || '',
          company: item.company || '',
          strength: item.strength || '',
          dosage_form: item.price_label || '',
          price_text: simplifyPriceText(item.price_text || packagePriceLabel({
            label: item.price_label,
            price_text: item.price_text,
            pack_size_info: item.pack_size_info,
          })),
        }));

  const grouped = new Map<string, AlternateBrandDisplayRow[]>();
  for (const row of buildAlternateBrandRows(rows)) {
    const bucket = grouped.get(row.dosageForm) || [];
    bucket.push(row);
    grouped.set(row.dosageForm, bucket);
  }

  const lines = [`## ${displayTitle}`, '', `### ${sectionHeading('Other brands')}`, ''];
  for (const [dosageForm, items] of [...grouped.entries()].sort((left, right) => formulationPriority(left[0]) - formulationPriority(right[0]))) {
    lines.push(`**${dosageForm}**`);
    for (const item of items) {
      lines.push(`- ${item.brandName}${item.strength ? ` ${item.strength}` : ''} - ${item.company}`.trim());
      if (item.price) {
        lines.push(`- Price: ${simplifyPriceText(item.price)}`);
      }
    }
    lines.push('');
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.join('\n').trim();
};
