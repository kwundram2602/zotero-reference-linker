export function normalizeDOI(value: string): string | undefined {
  const match = value.match(/10\.\d{4,9}\/[-._;()/:a-z0-9]+/i);
  return match?.[0].replace(/[.,;:)\]}]+$/g, "").toLowerCase();
}

// A DOI broken at a line end ("…/10.1016/j.jag.⏎2020.102174", "…/10.3390/⏎rs14081792"): after a slash any token
// continues it; after a period only one starting in lower case or a digit, and never a year ("10.1000/xyz. 2020."),
// a URL, an identifier appended from a link or a page number from the footer ("…/rs10010085. 112 M. Wocher et al.").
// The continuation has a digit: "…/10.1109/ december 2017" is a page header, not the rest of the DOI.
const BROKEN_DOI = /(10\.\d{4,9}\/(?:[-._;()/:a-zA-Z0-9]*[./])?)\s+(?!(?:doi|DOI|arXiv|arxiv|https?|HTTPS?):|URL\b|(?:19|20)\d{2}[a-z]?[.,]?(?:\s|$)|\d{1,4}(?:\s|$))(?:(?<=\/\s*)(?=[A-Za-z0-9])|(?=[a-z0-9]))(?=[^\s\d]*\d)/g;
const DOI = /10\.\d{4,9}\/[-._;()/:a-z0-9]+/gi;

/**
 * The DOI of a reference's text. A DOI cut at a line end is joined again, and when a later DOI extends the first one
 * (the full DOI that the extractor appends from the reference's hyperlink) the longer one wins.
 */
export function referenceDOI(value: string): string | undefined {
  const joined = value.replace(BROKEN_DOI, "$1");
  const candidates = [...joined.matchAll(DOI)].map(match => match[0].replace(/[.,;:)\]}]+$/g, "").toLowerCase());
  const first = candidates[0];
  if (!first) return undefined;
  return candidates.find(candidate => candidate.length > first.length && candidate.startsWith(first)) ?? first;
}

export function normalizeArxiv(value: string): string | undefined {
  const match = value.match(/(?:arxiv\s*:\s*)?((?:[a-z-]+\/\d{7})|(?:\d{4}\.\d{4,5}))(?:v\d+)?/i);
  return match?.[1]?.toLowerCase();
}

export function normalizeTitle(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const CONTAINER_ALIASES: Record<string, string> = {
  "a a": "astronomy astrophysics",
  "astronomy astrophysics": "astronomy astrophysics",
  "apj": "astrophysical journal",
  "astrophysical journal": "astrophysical journal",
  "apjs": "astrophysical journal supplement series",
  "astrophysical journal supplement series": "astrophysical journal supplement series",
  "araa": "annual review astronomy astrophysics",
  "annual review astronomy astrophysics": "annual review astronomy astrophysics",
  "mnras": "monthly notices royal astronomical society",
  "monthly notices royal astronomical society": "monthly notices royal astronomical society",
  "ann phys": "annalen physik",
  "annalen physik": "annalen physik",
  "annalen der physik": "annalen physik",
  "j med": "journal medicine",
  "journal medicine": "journal medicine"
};

export function normalizeContainerTitle(value: string): string {
  const normalized = normalizeTitle(value)
    .replace(/\bthe\b/g, " ")
    .replace(/\band\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return CONTAINER_ALIASES[normalized] || normalized;
}

export function normalizeVolume(value?: string): string | undefined {
  const match = value?.trim().match(/[A-Za-z]?\d+[A-Za-z]?/);
  return match?.[0].toLowerCase();
}

export function normalizeLocator(value?: string): string | undefined {
  const first = value?.trim().split(/[-–—]/)[0]?.match(/[A-Za-z]?\d+/)?.[0];
  return first?.toLowerCase();
}

export function surname(value?: string): string | undefined {
  if (!value) return undefined;
  return normalizeTitle(value).split(" ").filter(Boolean).at(-1);
}

function titleTokens(value: string): string[] {
  return normalizeTitle(value).split(" ")
    .filter(word => word.length > 2)
    .map(word => word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);
}

function properTokenSubset(a: Set<string>, b: Set<string>): boolean {
  if (a.size === b.size) return false;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  return [...small].every(word => large.has(word));
}

function bigramCoverage(a: string[], b: string[]): number {
  const pairs = (words: string[]) => new Set(words.slice(0, -1).map((word, index) => `${word}\u0000${words[index + 1]}`));
  const aa = pairs(a);
  const bb = pairs(b);
  if (!aa.size || !bb.size) return 0;
  let intersection = 0;
  for (const pair of aa) if (bb.has(pair)) intersection++;
  return intersection / Math.max(aa.size, bb.size);
}

export function titleSimilarity(a: string, b: string, relaxed = false): number | undefined {
  if (!a || !b) return undefined;
  const aWords = titleTokens(a);
  const bWords = titleTokens(b);
  const aa = new Set(aWords);
  const bb = new Set(bWords);
  if (aa.size < 4 || bb.size < 4 || properTokenSubset(aa, bb)) return undefined;

  let intersection = 0;
  for (const word of aa) if (bb.has(word)) intersection++;
  if (intersection === aa.size && intersection === bb.size && normalizeTitle(a) !== normalizeTitle(b)) return undefined;
  if (relaxed && (aa.size - intersection > 1 || bb.size - intersection > 1)) return undefined;

  const leftCoverage = intersection / aa.size;
  const rightCoverage = intersection / bb.size;
  const jaccard = intersection / (aa.size + bb.size - intersection);
  const order = bigramCoverage(aWords, bWords);
  const minimum = relaxed
    ? { coverage: 0.8, jaccard: 0.65, order: 0.45 }
    : { coverage: 0.85, jaccard: 0.75, order: 0.55 };
  if (leftCoverage < minimum.coverage || rightCoverage < minimum.coverage
    || jaccard < minimum.jaccard || order < minimum.order) return undefined;
  return 0.3 * leftCoverage + 0.3 * rightCoverage + 0.25 * jaccard + 0.15 * order;
}

export function similarity(a: string, b: string): number {
  if (normalizeTitle(a) === normalizeTitle(b)) return 1;
  return titleSimilarity(a, b) || 0;
}
