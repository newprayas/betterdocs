const stripMarkdown = (value: string): string =>
  value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, ' $1 ')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, ' $1 ')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_~|]+/g, ' ')
    .replace(/[-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const normalizeSearchText = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const toSearchableText = (value: string): string => normalizeSearchText(stripMarkdown(value));

const tokenize = (value: string): string[] =>
  toSearchableText(value)
    .split(/\s+/)
    .filter(Boolean);

export const fuzzyScore = (query: string, candidate: string): number => {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedCandidate = toSearchableText(candidate);

  if (!normalizedQuery || !normalizedCandidate) return 0;
  if (normalizedCandidate === normalizedQuery) return 1000;
  if (normalizedCandidate.includes(normalizedQuery)) return 950;

  const queryTokens = tokenize(query);
  const candidateTokens = tokenize(candidate);
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;

  let score = 0;

  const scoreTokenMatch = (needle: string, haystack: string): number => {
    if (haystack === needle) return 30;
    if (haystack.startsWith(needle)) return 26 - Math.min(10, haystack.length - needle.length);
    if (haystack.includes(needle)) return 20 - Math.min(8, haystack.length - needle.length);
    if (isSubsequence(needle, haystack)) return 12 - Math.min(6, haystack.length - needle.length);
    return 0;
  };

  for (const token of queryTokens) {
    let best = 0;
    for (const candidateToken of candidateTokens) {
      best = Math.max(best, scoreTokenMatch(token, candidateToken));
      if (best >= 30) break;
    }
    score += best;
  }

  if (queryTokens.every((token) => candidateTokens.some((candidateToken) => candidateToken.includes(token)))) {
    score += 40;
  }

  const firstToken = queryTokens[0];
  if (firstToken && candidateTokens[0]?.startsWith(firstToken)) {
    score += 20;
  }

  return Math.max(score, 0);
};

const isSubsequence = (needle: string, haystack: string): boolean => {
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) {
      index += 1;
      if (index === needle.length) return true;
    }
  }
  return false;
};

export const fuzzyFilter = <T>(
  items: T[],
  query: string,
  toCandidate: (item: T) => string,
): T[] => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return items;

  return items
    .map((item) => ({ item, score: fuzzyScore(normalizedQuery, toCandidate(item)) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .map(({ item }) => item);
};
