import * as cheerio from 'cheerio';
import type {
  MedexAlternateBrandGroup,
  MedexAlternateBrandRow,
  MedexBrandCard,
  MedexPackageInfo,
  MedexResolvedPayload,
  MedexSummaryBlock,
} from '@/types';

const BASE_URL = 'https://medex.com.bd';

const HEADERS: HeadersInit = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Connection: 'keep-alive',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

const SECTION_IDS: Record<string, string> = {
  description: 'description',
  indications: 'indications',
  pharmacology: 'mode_of_action',
  dosage_and_administration: 'dosage',
  interaction: 'interaction',
  contraindications: 'contraindications',
  side_effects: 'side_effects',
  pregnancy_and_lactation: 'pregnancy_cat',
  precautions_and_warnings: 'precautions',
  overdose_effects: 'overdose_effects',
};

const MONEY_RE = /^৳\s*[\d,.]+$/;
const STANDARD_PRICE_LABELS = new Set(['Unit Price:', 'Strip Price:']);
const PREFERRED_COMPANIES = [
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
const PREFERRED_DOSAGE_FORMS = [
  'tablet',
  'capsule',
  'tablet (enteric coated)',
  'tablet (film coated)',
  'tablet (extended release)',
  'tablet (sustained release)',
  'oral suspension',
  'syrup',
  'suspension',
  'injection',
  'infusion',
  'suppository',
  'pediatric drop',
  'drops',
];

type SearchResult = {
  url: string;
  title: string;
  brand: string;
  description?: string | null;
  manufacturer?: string | null;
  kind: 'brand' | 'generic';
};

export class MedexServerNoExactMatchError extends Error {
  queryName: string;

  suggestions: string[];

  constructor(queryName: string, suggestions: string[]) {
    super(`No exact MedEx result found for '${queryName}'`);
    this.name = 'MedexServerNoExactMatchError';
    this.queryName = queryName;
    this.suggestions = suggestions;
  }
}

const clean = (text?: string | null): string | null => {
  if (text == null) return null;
  const value = text.replace(/\s+/g, ' ').trim();
  return value || null;
};

const normalizeBrand = (text?: string | null): string =>
  (clean(text) || '')
    .replace(/\s*\(.*?\)\s*$/g, '')
    .replace(/\s+\d.*$/g, '')
    .toLowerCase()
    .trim();

const displayBrandName = (text?: string | null): string =>
  (clean(text) || '')
    .replace(/\s*\(.*?\)\s*$/g, '')
    .replace(/\s+\d.*$/g, '')
    .trim();

const normalizeChoiceText = (text?: string | null): string =>
  (clean(text) || '').replace(/\s+/g, ' ').trim().toLowerCase();

const normalizeCompany = (text?: string | null): string => clean(text) || '';

const scoreCompany = (company?: string | null): [number, string] => {
  const normalized = normalizeCompany(company).toLowerCase();
  if (!normalized) return [PREFERRED_COMPANIES.length + 1, ''];
  for (let index = 0; index < PREFERRED_COMPANIES.length; index += 1) {
    if (normalized.includes(PREFERRED_COMPANIES[index])) {
      return [index, normalized];
    }
  }
  return [PREFERRED_COMPANIES.length, normalized];
};

const extractDosageFormFromTitle = (title?: string | null): string => {
  const value = clean(title) || '';
  const match = value.match(/\(([^()]*)\)\s*$/);
  return match ? match[1].trim().toLowerCase() : '';
};

const scoreDosageForm = (title?: string | null): [number, string] => {
  const dosageForm = extractDosageFormFromTitle(title);
  if (!dosageForm) return [PREFERRED_DOSAGE_FORMS.length + 1, ''];
  for (let index = 0; index < PREFERRED_DOSAGE_FORMS.length; index += 1) {
    if (dosageForm.includes(PREFERRED_DOSAGE_FORMS[index])) {
      return [index, dosageForm];
    }
  }
  return [PREFERRED_DOSAGE_FORMS.length, dosageForm];
};

const toAbsoluteUrl = (href?: string | null): string | null => {
  const value = clean(href);
  if (!value) return null;
  return value.startsWith('http') ? value : new URL(value, BASE_URL).toString();
};

const priceText = (value?: string | null): string | null => {
  const normalized = clean(value);
  if (!normalized) return null;
  return normalized.startsWith('৳') ? normalized : `৳ ${normalized}`;
};

const fetchHtml = async (url: string): Promise<{ html: string; ms: number; status: number }> => {
  const started = Date.now();
  const response = await fetch(url, {
    method: 'GET',
    headers: HEADERS,
    cache: 'no-store',
  });
  const ms = Date.now() - started;
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`MedEx fetch failed (${response.status}) for ${url}`);
  }
  return {
    html,
    ms,
    status: response.status,
  };
};

const parseSearchResults = (searchHtml: string): SearchResult[] => {
  const $ = cheerio.load(searchHtml);
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  $('div.search-result-row').each((_, row) => {
    const title = clean($(row).find('div.search-result-title a').first().text());
    const href = $(row).find('div.search-result-title a').first().attr('href');
    const url = toAbsoluteUrl(href);

    if (!title || !url || (!url.includes('/brands/') && !url.includes('/generics/'))) {
      return;
    }
    if (seen.has(url)) return;
    seen.add(url);

    const description = clean($(row).find('p').first().text());
    const manufacturerMatch = description?.match(/is manufactured by (.+?)(?:\.)?$/i);
    const manufacturer = manufacturerMatch ? clean(manufacturerMatch[1]) : null;
    const kind: 'brand' | 'generic' = url.includes('/generics/') ? 'generic' : 'brand';

    results.push({
      url,
      title,
      brand: normalizeBrand(title),
      description,
      manufacturer,
      kind,
    });
  });

  return results;
};

const buildResultSuggestions = (results: SearchResult[], limit = 8): string[] => {
  const suggestions: string[] = [];
  const seen = new Set<string>();

  for (const item of results) {
    const suggestion = displayBrandName(item.title) || clean(item.title) || '';
    const normalized = normalizeChoiceText(suggestion);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    suggestions.push(suggestion);
    if (suggestions.length >= limit) break;
  }

  return suggestions;
};

const resolveSelectedResult = (
  results: SearchResult[],
  query: string,
): { selected: SearchResult; kind: 'brand' | 'generic' } => {
  if (results.length === 0) {
    throw new Error('No MedEx results found');
  }

  const genericResults = results.filter((item) => item.kind === 'generic');
  const brandResults = results.filter((item) => item.kind === 'brand');
  const queryBrand = normalizeBrand(query);
  const queryChoice = normalizeChoiceText(query);

  const exactGenericMatches = genericResults.filter(
    (item) =>
      normalizeChoiceText(item.title) === queryChoice || normalizeBrand(item.title) === queryBrand,
  );
  if (exactGenericMatches.length > 0) {
    return { selected: exactGenericMatches[0], kind: 'generic' };
  }

  const exactBrandMatches = brandResults.filter(
    (item) =>
      item.brand === queryBrand ||
      normalizeChoiceText(displayBrandName(item.title)) === queryChoice,
  );
  if (exactBrandMatches.length > 0) {
    const selected = [...exactBrandMatches].sort((left, right) => {
      const companyDelta = scoreCompany(left.manufacturer)[0] - scoreCompany(right.manufacturer)[0];
      if (companyDelta !== 0) return companyDelta;
      const dosageDelta = scoreDosageForm(left.title)[0] - scoreDosageForm(right.title)[0];
      if (dosageDelta !== 0) return dosageDelta;
      return exactBrandMatches.indexOf(left) - exactBrandMatches.indexOf(right);
    })[0];
    return { selected, kind: 'brand' };
  }

  throw new MedexServerNoExactMatchError(query, buildResultSuggestions(results));
};

const isBlockTag = (tagName?: string | null): boolean =>
  !!tagName && ['p', 'div', 'li', 'br'].includes(tagName.toLowerCase());

const extractSectionText = ($: cheerio.CheerioAPI, sectionId: string): string | null => {
  const sectionNode = $(`#${sectionId}`).first().nextAll('div.ac-body').first();
  if (sectionNode.length === 0) return null;

  const parts: string[] = [];
  const recurse = (node: any): void => {
    if (!node) return;
    if (node.type === 'text' && node.data) {
      parts.push(node.data);
      return;
    }

    const children = node.children || [];
    for (const child of children) {
      const childTag = child?.tagName || child?.name || null;
      if (isBlockTag(childTag) && parts.length > 0 && !parts[parts.length - 1].endsWith('\n')) {
        parts.push('\n');
      }
      recurse(child);
      if (isBlockTag(childTag) && (parts.length === 0 || !parts[parts.length - 1].endsWith('\n'))) {
        parts.push('\n');
      }
    }
  };

  recurse(sectionNode.get(0));
  const text = parts.join('');
  const lines = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : null;
};

const parsePackages = ($: cheerio.CheerioAPI): MedexPackageInfo[] => {
  const packages: MedexPackageInfo[] = [];

  $('div.package-container').each((_, container) => {
    const current: MedexPackageInfo = {};
    $(container)
      .find('span')
      .each((__, span) => {
        const text = clean($(span).text());
        if (!text) return;

        const classes = $(span).attr('class') || '';
        const isMoney = MONEY_RE.test(text);
        const isPackInfo = classes.includes('pack-size-info') || (text.startsWith('(') && text.includes('৳'));
        const isLabel = !isMoney && !isPackInfo;

        if (isLabel) {
          if (current.label && current.price_text) {
            packages.push({ ...current });
            Object.keys(current).forEach((key) => delete (current as Record<string, unknown>)[key]);
          }
          current.label = text.replace(/:$/, '').trim();
          if (STANDARD_PRICE_LABELS.has(text)) {
            current.price_kind = text.replace(/:$/, '').trim().toLowerCase().replace(/\s+/g, '_');
          }
          return;
        }

        if (isMoney) {
          current.price_text = text;
          current.price_bdt = text.replace('৳', '').trim();
          return;
        }

        if (isPackInfo) {
          current.pack_size_info = text;
        }
      });

    if (current.label || current.price_text || current.pack_size_info) {
      packages.push({ ...current });
    }
  });

  const seen = new Set<string>();
  return packages.filter((pkg) => {
    const key = `${pkg.label || ''}|${pkg.price_text || ''}|${pkg.pack_size_info || ''}`;
    if ((!pkg.label && !pkg.price_text && !pkg.pack_size_info) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const extractSummary = ($: cheerio.CheerioAPI, selectedTitle?: string | null): MedexSummaryBlock => {
  const h1 = clean($('h1').first().text());
  const dosageForm = clean($('small[title="Dosage Form"]').first().text());
  let generic = clean($('[title="Generic Name"]').first().text());
  if (!generic) {
    generic = clean($('a[href*="/generics/"]').first().text());
  }
  if (!generic || generic.toLowerCase() === 'available brands') {
    generic = selectedTitle ? selectedTitle.replace(/\s*\(.*?\)\s*$/g, '').trim() : generic;
  }

  let manufacturer = clean($('[title="Manufactured by"]').first().text());
  if (!manufacturer) {
    manufacturer = clean($('a[href*="/companies/"]').first().text());
  }

  let strength = clean($('[title="Strength"]').first().text());
  if (!strength && selectedTitle) {
    const match = selectedTitle.match(/(\d+\s*mg(?:\/vial)?)/i);
    if (match) {
      strength = match[1];
    }
  }

  const packages = parsePackages($);
  let unitPrice: string | null = null;
  let stripPrice: string | null = null;

  for (const pkg of packages) {
    const label = (pkg.label || '').toLowerCase();
    if (label === 'unit price' && !unitPrice) {
      unitPrice = pkg.price_text || null;
    }
    if (label === 'strip price' && !stripPrice) {
      stripPrice = pkg.price_text || null;
    }
  }

  if (!unitPrice) {
    unitPrice = clean(
      $('span')
        .filter((_, span) => $(span).text().includes('Unit Price'))
        .first()
        .next('span')
        .text(),
    );
  }
  if (!stripPrice) {
    stripPrice = clean(
      $('span')
        .filter((_, span) => $(span).text().includes('Strip Price'))
        .first()
        .next('span')
        .text(),
    );
  }

  const availableAs = $('a.btn-sibling-brands')
    .map((_, anchor) => clean($(anchor).text()))
    .get()
    .filter(Boolean) as string[];

  return {
    display_name: h1,
    dosage_form: dosageForm,
    generic_name: generic,
    manufacturer,
    strength,
    unit_price_bdt: priceText(unitPrice),
    strip_price_bdt: priceText(stripPrice),
    pricing: {
      unit_price_bdt: priceText(unitPrice),
      strip_price_bdt: priceText(stripPrice),
      packages,
    },
    available_as: availableAs,
  };
};

const parseBrandCards = ($: cheerio.CheerioAPI): MedexBrandCard[] => {
  const cards: MedexBrandCard[] = [];

  $('div.available-brands-default div.available-brands').each((_, item) => {
    const brandName = clean($(item).find('div.data-row-top').first().text());
    const strength = clean($(item).find('div.data-row-strength').first().text());
    const company = clean($(item).find('div.data-row-company').first().text());
    const priceBlock = clean($(item).find('div.packages-wrapper').first().text());

    let priceLabel: string | null = null;
    let priceValue: string | null = null;
    let packSizeInfo: string | null = null;

    if (priceBlock) {
      let match = priceBlock.match(/^(.*?):\s*৳\s*([\d,.]+)\s*$/);
      if (match) {
        priceLabel = clean(match[1]);
        priceValue = `৳ ${match[2]}`;
      } else {
        match = priceBlock.match(/^(.*?)\s*:\s*(.*)$/);
        if (match) {
          priceLabel = clean(match[1]);
          const rest = clean(match[2]);
          if (rest && rest.includes('৳')) {
            priceValue = rest.startsWith('৳') ? rest : `৳ ${rest.replace('৳', '').trim()}`;
          } else {
            packSizeInfo = rest;
          }
        }
      }
    }

    cards.push({
      brand_name: brandName,
      strength,
      company,
      price_label: priceLabel,
      price_bdt: priceValue ? priceValue.replace('৳', '').trim() : null,
      price_text: priceValue,
      pack_size_info: packSizeInfo,
    });
  });

  return cards;
};

const parseAlternateBrands = ($: cheerio.CheerioAPI): {
  page_title?: string | null;
  rows: MedexAlternateBrandRow[];
  grouped_by_company: MedexAlternateBrandGroup[];
} => {
  let pageTitle = clean($('h1').first().text());
  if (pageTitle) {
    pageTitle = pageTitle.replace(' Available Brands', '').trim();
  }

  const rows: MedexAlternateBrandRow[] = [];
  $('table.bindex-table tr.brand-row').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 5) return;

    const brandName = clean(cells.eq(0).text());
    const dosageForm = clean(cells.eq(1).text());
    const strength = clean(cells.eq(2).text());
    const company = clean(cells.eq(3).text());
    const priceTextRaw = clean(cells.eq(4).text());
    const brandUrl = toAbsoluteUrl($(row).attr('data-href'));

    let priceLabel: string | null = null;
    let unitPriceBdt: string | null = null;
    let packSizeInfo: string | null = null;

    if (priceTextRaw) {
      let match = priceTextRaw.match(/^(Unit Price:)\s*৳\s*([\d,.]+)\s*(.*)$/);
      if (match) {
        priceLabel = 'Unit Price';
        unitPriceBdt = match[2];
        packSizeInfo = clean(match[3]);
      } else {
        match = priceTextRaw.match(/^(.+?):\s*৳\s*([\d,.]+)\s*(.*)$/);
        if (match) {
          priceLabel = clean(match[1]);
          unitPriceBdt = match[2];
          packSizeInfo = clean(match[3]);
        }
      }
    }

    rows.push({
      brand_name: brandName,
      dosage_form: dosageForm,
      strength,
      company,
      brand_url: brandUrl,
      price_label: priceLabel,
      unit_price_bdt: unitPriceBdt,
      pack_size_info: packSizeInfo,
      price_text: priceTextRaw,
    });
  });

  const grouped = new Map<string, Map<string, MedexAlternateBrandRow[]>>();
  for (const row of rows) {
    const company = row.company || 'Unknown Company';
    const dosageForm = row.dosage_form || 'Unknown Dosage Form';
    const companyBucket = grouped.get(company) || new Map<string, MedexAlternateBrandRow[]>();
    const dosageBucket = companyBucket.get(dosageForm) || [];
    dosageBucket.push(row);
    companyBucket.set(dosageForm, dosageBucket);
    grouped.set(company, companyBucket);
  }

  const groupedByCompany: MedexAlternateBrandGroup[] = [...grouped.entries()].map(
    ([company, dosageForms]) => ({
      company,
      dosage_forms: [...dosageForms.entries()].map(([dosageForm, brands]) => ({
        dosage_form: dosageForm,
        brands,
      })),
    }),
  );

  return {
    page_title: pageTitle,
    rows,
    grouped_by_company: groupedByCompany,
  };
};

const getAlternateBrandsUrl = ($: cheerio.CheerioAPI): string | null => {
  const href = $('a[href*="/brand-names"]').first().attr('href');
  return toAbsoluteUrl(href);
};

export const buildMedexPayload = async (query: string): Promise<MedexResolvedPayload> => {
  const started = Date.now();

  const searchUrl = `${BASE_URL}/search?search=${encodeURIComponent(query)}`;
  const searchResponse = await fetchHtml(searchUrl);
  const searchResults = parseSearchResults(searchResponse.html);
  if (searchResults.length === 0) {
    throw new Error(`No MedEx result found for '${query}'`);
  }

  const { selected, kind } = resolveSelectedResult(searchResults, query);
  const pageResponse = await fetchHtml(selected.url);
  const $page = cheerio.load(pageResponse.html);
  const parseStarted = Date.now();

  const payload: MedexResolvedPayload = {
    query,
    resolved_query: query,
    selected_kind: kind,
    search_url: searchUrl,
    search_result_count_estimate: searchResults.length,
    selected_result_title: selected.title,
    selected_result_url: selected.url,
    summary_above_indications: extractSummary($page, selected.title),
    sections: {
      description: extractSectionText($page, SECTION_IDS.description),
      indications: extractSectionText($page, SECTION_IDS.indications),
      pharmacology: extractSectionText($page, SECTION_IDS.pharmacology),
      dosage_and_administration: extractSectionText($page, SECTION_IDS.dosage_and_administration),
      interaction: extractSectionText($page, SECTION_IDS.interaction),
      contraindications: extractSectionText($page, SECTION_IDS.contraindications),
      side_effects: extractSectionText($page, SECTION_IDS.side_effects),
      pregnancy_and_lactation: extractSectionText($page, SECTION_IDS.pregnancy_and_lactation),
      precautions_and_warnings: extractSectionText($page, SECTION_IDS.precautions_and_warnings),
      overdose_effects: extractSectionText($page, SECTION_IDS.overdose_effects),
    },
    available_brand_names: kind === 'generic' ? parseBrandCards($page) : [],
    alternate_brands: null,
    logs: {
      search_fetch_ms: searchResponse.ms,
      brand_fetch_ms: pageResponse.ms,
      parse_ms: 0,
      total_ms: 0,
      source: 'server',
      http_status: {
        search: searchResponse.status,
        brand: pageResponse.status,
      },
    },
  };

  let alternateUrl: string | null = null;
  if (kind === 'brand') {
    alternateUrl = getAlternateBrandsUrl($page);
  } else if (kind === 'generic' && selected.url.includes('/generics/')) {
    alternateUrl = `${selected.url.replace(/\/$/, '')}/brand-names`;
  }

  if (alternateUrl) {
    const alternateResponse = await fetchHtml(alternateUrl);
    const $alternate = cheerio.load(alternateResponse.html);
    payload.alternate_brands = {
      source_url: alternateUrl,
      ...parseAlternateBrands($alternate),
    };
    payload.logs = {
      ...payload.logs,
      alternate_brands_fetch_ms: alternateResponse.ms,
      http_status: {
        ...(payload.logs?.http_status || {}),
        alternate: alternateResponse.status,
      },
    };
  }

  const parseMs = Date.now() - parseStarted;
  payload.logs = {
    ...payload.logs,
    parse_ms: parseMs,
    total_ms: Date.now() - started,
  };

  return payload;
};
