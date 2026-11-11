import { normalizeArxiv, normalizeDOI, surname } from "./normalize";
import type { ReferenceBlock, ReferenceSection } from "./types";

interface PdfTextItem { str?: string; hasEOL?: boolean; transform?: ArrayLike<number> }
interface PdfAnnotation { subtype?: string; url?: string; rect?: ArrayLike<number> }
interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
  getAnnotations?(): Promise<PdfAnnotation[]>;
}
// parts: positions of all physical lines joined into this one at a hyphen
type PositionedLine = { text: string; x?: number; y?: number; order: number; parts?: Array<{ x?: number; y?: number }> };
interface OutlineItem {
  title?: string;
  items?: OutlineItem[];
  location?: { position?: { pageIndex?: number } };
}
export interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  getOutline2?(): Promise<OutlineItem[] | null>;
}

const REFERENCE_HEADING = /^\s*(?:\d{1,4}\.?\s+)?(references|bibliography|works cited|literature cited|references cited)(?:\s+\d{1,4})?\s*$/i;
// Only tried when no REFERENCE_HEADING exists, and then its last occurrence: "Reference" also heads table columns.
const LENIENT_REFERENCE_HEADING = /^\s*(?:\d{1,4}\.?\s+)?(reference|literatur|literaturverzeichnis)\s*$/i;
const STOP_HEADING = /^\s*(?:\d{1,4}\s+)?(appendix|appendices|supplementary material|supplemental material|acknowledg(?:e)?ments?)(?:\s+\d{1,4})?\b/i;
const ACKNOWLEDGEMENT_HEADING = /^\s*(?:\d{1,4}\s+)?acknowledg(?:e)?ments?(?:\s+\d{1,4})?\s*$/i;
const LETTERED_STOP_HEADING = /^\s*A(?:\.\d+)?(?:\.\s*|\s+)(?=[\p{Lu}])[^,.;]{2,100}\s*$/u;
// a line that cannot be the end of a reference: the next one continues it
const OPEN_REFERENCE_LINE = /(?:[,:;\-–—‐]|\b(?:and|of|the|for|in|on|to|with|a|an))\s*$/i;
// a book's index after the bibliography; the whole line only, so "Index Terms—…" does not stop
const INDEX_HEADING = /^\s*(?:(?:subject|author|name)\s+)?index\s*$/i;
// fewer references after a scanned heading: probably a table-of-contents entry, try the next heading
const MIN_SCANNED_REFERENCES = 3;
const LABELED_START = /(?:^|\n)\s*(?:\[\s*((?=[^\]\n]{0,24}\d)[A-Za-z0-9][A-Za-z0-9+.:/_\-\s]{0,23})\s*\]|((?!(?:18|19|20|21)\d{2}\b)\d{1,4}) ?[.)]|((?!(?:18|19|20|21)\d{2}\b)\d{1,4})(?=\s+(?:[A-ZÀ-ÖØ-Þ](?:\.|\s)|Technical\b)))(?:\s+|(?=\p{Lu}))/gu;
const PARTICLE = `(?:[Dd]e|[Dd]el|[Dd]en|[Dd]er|[Dd]i|[Dd]u|[Ll]a|[Ll]e|[Vv]an|[Vv]on)\\s+`;
const SURNAME = `(?:${PARTICLE}){0,3}[A-ZÀ-ÖØ-Þ][\\p{L}'’\u2010-]+(?:\\s+[A-ZÀ-ÖØ-Þ][\\p{L}'’\u2010-]+){0,2}`;
// Springer/Vancouver style without dots: "Aiken C (2024)", "Bishop JW, …", "Royer J-Y, …", "Chadwick Jr WW, …"
const COMPACT_INITIALS = `(?:\\s+Jr\\.?)?\\s+[A-Z]{1,3}(?:-[A-Z]{1,2})?(?=\\s*(?:[,;]|et\\s+al\\b|\\((?:19|20)\\d{2}))`;
const INITIALS = `(?:[A-Z](?:\\.-[A-Z])?\\.(?:\\s*[A-Z](?:\\.-[A-Z])?\\.){0,5}|[A-Z](?:-[A-Z])?(?=\\s*[,;]))`;
const INITIALS_FIRST = `(?:[A-Z](?:-[A-Z])?\\.\\s*){1,5}`;
const AUTHOR_START = new RegExp(
  `(?:^|\\n)(?=\\s*(?:${SURNAME},\\s*${INITIALS}|${SURNAME}${COMPACT_INITIALS}|${INITIALS_FIRST}${SURNAME}(?=\\s*[,;])))`,
  "gu"
);
const ORGANIZATION_START = /(?:^|\n)(?=\s*[A-Z][^\n,]{1,80}\b(?:Collaboration|Partnership)\b[^\n]*\b(?:19|20)\d{2}[a-z]?\b)/gu;
const DITTO_START = /(?:^|\n)(?=\s*[—–-]\.\s*(?:19|20)\d{2}[a-z]?\b)/gu;
// Organisations and other authors without initials: "FIRMS (2026) Fire-…", "Global Volcanism Program (2026) [Database] …";
// the year may open the next, indented line.
// Indented (continuation) lines start with CONTINUATION_LINE and never match; running heads are followed by a
// (page) number such as "88:135" or "S17".
const YEAR_PAREN_START = /(?:^|\n)(?=[A-ZÀ-ÖØ-Þ][^\n()]{1,100}?(?:\n\u0001)?\((?:19|20)\d{2}[a-z]?\)\.?\s+\u0001?(?![A-Z]?\d)[\p{Lu}“"[])/gu;
const DISCRETIONARY_HYPHEN = /[-\u00ad\u0002]\s*$/;
const CONTINUATION_LINE = "\u0001";
const PDF_DIACRITIC_ARTIFACT = /[´`^¨]\s*/g;
const SPLIT_HEADING_WORDS = [
  "references", "bibliography", "appendix", "appendices",
  "supplementary", "supplemental", "material", "acknowledgement",
  "acknowledgements", "acknowledgment", "acknowledgments"
].map(word => ({ word, pattern: new RegExp(`\\b${word.split("").join("\\s*")}\\b`, "gi") }));

export class PdfSectionExtractor {
  async extract(pdf: PdfDocument): Promise<ReferenceSection | undefined> {
    const structured = await this.fromOutline(pdf);
    if (structured) {
      const section = await this.extractRange(pdf, structured.startPage, structured.endPage, "zotero-structure", undefined, undefined, structured.startHeading, structured.endHeading);
      section.startHeading = structured.startHeading;
      section.endHeading = structured.endHeading;
      return section;
    }
    const scanned = await this.findByHeadings(pdf) || await this.findByLastHeading(pdf, LENIENT_REFERENCE_HEADING);
    if (!scanned) {
      const headingless = await this.findByNumberedReferences(pdf);
      if (!headingless) return undefined;
      return this.extractRange(pdf, headingless.startPage, pdf.numPages - 1, "heading-scan", headingless.startLine);
    }
    const section = await this.extractScanned(pdf, scanned);
    // A book's table of contents lists "Bibliography 595"; that hit yields (almost) no references, so try later ones.
    if (section.references.length < MIN_SCANNED_REFERENCES) {
      for (let next = await this.findByHeadings(pdf, REFERENCE_HEADING, scanned.startPage + 1); next; next = await this.findByHeadings(pdf, REFERENCE_HEADING, next.startPage + 1)) {
        const candidate = await this.extractScanned(pdf, next);
        if (candidate.references.length >= MIN_SCANNED_REFERENCES) return candidate;
      }
    }
    return section;
  }

  private async extractScanned(pdf: PdfDocument, scanned: { startPage: number; endPage: number; startLine: number; endLine?: number }): Promise<ReferenceSection> {
    const section = await this.extractRange(pdf, scanned.startPage, scanned.endPage, "heading-scan", scanned.startLine, scanned.endLine);
    section.startHeading = "References";
    return section;
  }

  private async fromOutline(pdf: PdfDocument): Promise<{ startPage: number; endPage: number; startHeading: string; endHeading?: string } | undefined> {
    if (!pdf.getOutline2) return undefined;
    try {
      const outline = await pdf.getOutline2();
      const flat = this.flatten(outline || []);
      const refIndex = flat.findIndex(entry => this.isReferenceHeading(entry.title));
      if (refIndex < 0) return undefined;
      const ref = flat[refIndex]!;
      const next = flat.slice(refIndex + 1).find(entry => entry.depth <= ref.depth && entry.page > ref.page);
      return { startPage: ref.page, endPage: next ? next.page : pdf.numPages - 1, startHeading: ref.title, endHeading: next?.title };
    } catch {
      return undefined;
    }
  }

  private flatten(items: OutlineItem[], depth = 0): Array<{ title: string; page: number; depth: number }> {
    const result: Array<{ title: string; page: number; depth: number }> = [];
    for (const item of items) {
      const page = item.location?.position?.pageIndex;
      if (item.title && page != null) result.push({ title: item.title.trim(), page, depth });
      result.push(...this.flatten(item.items || [], depth + 1));
    }
    return result;
  }

  private async findByHeadings(pdf: PdfDocument, heading = REFERENCE_HEADING, fromPage = 0): Promise<{ startPage: number; endPage: number; startLine: number; endLine?: number } | undefined> {
    let found: { startPage: number; startLine: number } | undefined;
    let previousLine: string | undefined;
    for (let pageIndex = fromPage; pageIndex < pdf.numPages; pageIndex++) {
      const lines = await this.pageLines(pdf, pageIndex);
      if (!found) {
        const startLine = lines.findIndex(line => heading.test(this.visibleLine(line)));
        if (startLine >= 0) found = { startPage: pageIndex, startLine: startLine + 1 };
        previousLine = lines.at(-1);
        continue;
      }
      const stopLine = this.stopLineIndex(lines, previousLine);
      if (stopLine >= 0) return { ...found, endPage: pageIndex, endLine: stopLine };
      previousLine = lines.at(-1) ?? previousLine;
    }
    return found ? { ...found, endPage: pdf.numPages - 1 } : undefined;
  }

  private async findByLastHeading(pdf: PdfDocument, heading: RegExp): Promise<{ startPage: number; endPage: number; startLine: number; endLine?: number } | undefined> {
    for (let pageIndex = pdf.numPages - 1; pageIndex >= 0; pageIndex--) {
      const lines = await this.pageLines(pdf, pageIndex);
      if (lines.some(line => heading.test(this.visibleLine(line)))) return this.findByHeadings(pdf, heading, pageIndex);
    }
    return undefined;
  }

  private isReferenceHeading(line: string): boolean {
    const visible = this.visibleLine(line);
    return REFERENCE_HEADING.test(visible) || LENIENT_REFERENCE_HEADING.test(visible);
  }

  private async findByNumberedReferences(pdf: PdfDocument): Promise<{ startPage: number; startLine: number } | undefined> {
    for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex++) {
      const lines = await this.pageLines(pdf, pageIndex);
      for (let startLine = 0; startLine < lines.length; startLine++) {
        if (!/^\s*1(?: ?[.)](?=\s+\p{Lu})|(?=\s+(?:[A-ZÀ-ÖØ-Þ](?:\.|\s)|Technical\b)))/u.test(this.visibleLine(lines[startLine]!))) continue;
        const samplePages = [lines.slice(startLine).join("\n")];
        for (let nextPage = pageIndex + 1; nextPage < Math.min(pdf.numPages, pageIndex + 3); nextPage++) {
          samplePages.push((await this.pageLines(pdf, nextPage)).join("\n"));
        }
        const references = this.splitReferences(samplePages.join("\n"));
        if (references.length < 5) continue;
        const firstFive = references.slice(0, 5);
        if (firstFive.every((reference, index) => reference.index === index + 1)
          && firstFive.filter(reference => /\b(?:18|19|20|21)\d{2}\b/.test(reference.raw)).length >= 3) {
          return { startPage: pageIndex, startLine };
        }
      }
    }
    return undefined;
  }

  private async extractRange(
    pdf: PdfDocument,
    startPage: number,
    endPage: number,
    source: ReferenceSection["source"],
    startLine = 0,
    endLine?: number,
    startHeading?: string,
    endHeading?: string
  ): Promise<ReferenceSection> {
    const pages: string[] = [];
    let detectedEndPage = endPage;
    let previousLine: string | undefined;
    for (let pageIndex = startPage; pageIndex <= endPage; pageIndex++) {
      let lines = await this.pageLines(pdf, pageIndex);
      if (pageIndex === startPage && startHeading) {
        const headingLine = lines.findIndex(line => this.sameHeading(line, startHeading));
        if (headingLine >= 0) startLine = headingLine + 1;
      }
      if (pageIndex === endPage && endHeading) {
        const headingLine = lines.findIndex(line => this.sameHeading(line, endHeading));
        if (headingLine >= 0) endLine = headingLine;
      }
      if (pageIndex === startPage) lines = lines.slice(startLine);
      if (pageIndex === endPage && endLine != null) lines = lines.slice(0, endLine);
      const reorderedAcknowledgement = pageIndex === startPage
        ? lines.findIndex(line => ACKNOWLEDGEMENT_HEADING.test(this.visibleLine(line)))
        : -1;
      if (reorderedAcknowledgement >= 0) {
        pages.push(lines.slice(0, reorderedAcknowledgement).join("\n"));
        continue;
      }
      const stopLine = this.stopLineIndex(lines, previousLine);
      if (stopLine >= 0) {
        lines = lines.slice(0, stopLine);
        detectedEndPage = pageIndex;
        if (lines.length) pages.push(lines.join("\n"));
        break;
      }
      pages.push(lines.join("\n"));
      previousLine = lines.at(-1) ?? previousLine;
    }
    return { startPage, endPage: detectedEndPage, references: this.splitReferences(pages.join("\n")), source };
  }

  private sameHeading(a: string, b: string): boolean {
    const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    return normalize(this.visibleLine(a)) === normalize(this.visibleLine(b));
  }

  /** First stop heading in `lines`; `before` is the line preceding `lines[0]` (end of the previous page). */
  private stopLineIndex(lines: string[], before?: string): number {
    return lines.findIndex((line, index) => this.isStopHeading(line, index ? lines[index - 1] : before));
  }

  private isStopHeading(line: string, previous?: string): boolean {
    const visible = this.visibleLine(line);
    if (STOP_HEADING.test(visible) || INDEX_HEADING.test(visible)) return true;
    if (!LETTERED_STOP_HEADING.test(visible)) return false;
    // "A Georeferenced Dataset to Train and Test …" is a wrapped title, not the appendix heading "A Proofs":
    // it hangs under a reference label, or the line before it has not finished its reference.
    return !line.startsWith(CONTINUATION_LINE) && !(previous != null && this.leavesReferenceOpen(previous));
  }

  private leavesReferenceOpen(line: string): boolean {
    const visible = this.visibleLine(line).trim();
    if (OPEN_REFERENCE_LINE.test(visible)) return true;
    return (visible.match(/“/g)?.length || 0) > (visible.match(/”/g)?.length || 0);
  }

  private visibleLine(line: string): string {
    let visible = line.replaceAll(CONTINUATION_LINE, "");
    for (const { word, pattern } of SPLIT_HEADING_WORDS) {
      visible = visible.replace(pattern, word);
    }
    return visible;
  }

  private async pageLines(pdf: PdfDocument, pageIndex: number): Promise<string[]> {
    const wrappedPage = await pdf.getPage(pageIndex + 1);
    const page = this.unwrap(wrappedPage);
    if (typeof page.getTextContent !== "function") {
      throw new Error(`Reference Linker: PDF page ${pageIndex + 1} does not expose getTextContent()`);
    }
    const content = await page.getTextContent();
    const lines: PositionedLine[] = [];
    let line = "";
    let lineX: number | undefined;
    let lineY: number | undefined;
    let continued = "";
    let continuedX: number | undefined;
    let continuedY: number | undefined;
    // positions of all physical lines joined into one at a hyphen, for placing links (addLinkIdentifiers)
    let parts: Array<{ x?: number; y?: number }> = [];
    const flushLine = () => {
      const value = line.trim();
      if (DISCRETIONARY_HYPHEN.test(value)) {
        if (!continued) {
          continuedX = lineX;
          continuedY = lineY;
        }
        continued += value.replace(DISCRETIONARY_HYPHEN, "");
        parts.push({ x: lineX, y: lineY });
      } else if (value) {
        parts.push({ x: lineX, y: lineY });
        lines.push({ text: `${continued}${value}`.replace(PDF_DIACRITIC_ARTIFACT, "").trim(), x: continuedX ?? lineX, y: continuedY ?? lineY, order: lines.length, parts });
        continued = "";
        continuedX = undefined;
        continuedY = undefined;
        parts = [];
      }
      line = "";
      lineX = undefined;
      lineY = undefined;
    };
    for (const item of content.items) {
      if (item.str) {
        const itemY = typeof item.transform?.[5] === "number" ? item.transform[5] : undefined;
        if (line && lineY != null && itemY != null && Math.abs(itemY - lineY) > 4) flushLine();
        if (!line) {
          lineX = typeof item.transform?.[4] === "number" ? item.transform[4] : undefined;
          lineY = itemY;
        }
        line += (line && !/[-–—\u2010\s]$/.test(line) && !item.str.startsWith("\u2010") ? " " : "") + item.str;
      }
      if (item.hasEOL) flushLine();
    }
    if (line.trim()) flushLine();
    else if (continued) lines.push({ text: continued.replace(PDF_DIACRITIC_ARTIFACT, "").trim(), x: continuedX, y: continuedY, order: lines.length, parts });
    await this.addLinkIdentifiers(page, lines);
    const positionCounts = new Map<number, number>();
    for (const value of lines) {
      if (value.x == null) continue;
      const position = Math.round(value.x);
      positionCounts.set(position, (positionCounts.get(position) || 0) + 1);
    }
    const recurringPositions = [...positionCounts]
      .filter(([, count]) => count >= 2)
      .map(([position]) => position);
    const numberedLines = lines.map(value => Number(value.text.match(/\s(\d{1,4})$/)?.[1] || NaN));
    let sequentialRun = 0;
    let longestSequentialRun = 0;
    for (let i = 1; i < numberedLines.length; i++) {
      sequentialRun = Number.isFinite(numberedLines[i - 1]) && numberedLines[i] === numberedLines[i - 1]! + 1 ? sequentialRun + 1 : 0;
      longestSequentialRun = Math.max(longestSequentialRun, sequentialRun);
    }
    if (longestSequentialRun >= 3) {
      for (const value of lines) value.text = value.text.replace(/\s+\d{1,4}$/, "");
    }
    const columnBases = recurringPositions
      .sort((a, b) => a - b)
      .filter(position => !recurringPositions.some(other => position > other && position - other <= 32));
    const columnLines = columnBases.map(() => [] as number[]);
    for (const value of lines) {
      if (value.x == null || value.y == null || !columnBases.length) continue;
      let best = 0;
      for (let i = 1; i < columnBases.length; i++) {
        if (Math.abs(value.x - columnBases[i]!) < Math.abs(value.x - columnBases[best]!)) best = i;
      }
      columnLines[best]!.push(value.y);
    }
    const alignedColumns = columnLines.some((left, leftIndex) => columnLines.some((right, rightIndex) => {
      if (rightIndex <= leftIndex || columnBases[rightIndex]! - columnBases[leftIndex]! < 100) return false;
      let aligned = 0;
      for (const y of left) {
        if (right.some(otherY => Math.abs(y - otherY) <= 20)) aligned++;
      }
      return aligned >= 2;
    }));
    const hasColumns = columnBases.length >= 2 && alignedColumns;
    const ordered = hasColumns ? (() => {
      const nearestColumn = (value: (typeof lines)[number]) => {
        if (value.x == null) return 0;
        let best = 0;
        for (let i = 1; i < columnBases.length; i++) {
          if (Math.abs(value.x - columnBases[i]!) < Math.abs(value.x - columnBases[best]!)) best = i;
        }
        return best;
      };
      const headingIndex = lines.findIndex(value => this.isReferenceHeading(value.text));
      const firstLabeledAfterHeading = headingIndex >= 0 ? lines.slice(headingIndex + 1).find(value =>
        /^\s*(?:\[\s*[A-Za-z0-9][^\]]{0,24}\]|\d{1,4} ?[.)])(?:\s+|(?=\p{Lu}))/u.test(value.text)
      ) : undefined;
      // unnumbered lists have no labeled line: the heading's own column is where the list starts
      const referenceColumn = firstLabeledAfterHeading ? nearestColumn(firstLabeledAfterHeading)
        : headingIndex >= 0 ? nearestColumn(lines[headingIndex]!) : 0;
      const column = (value: (typeof lines)[number]) =>
        this.isReferenceHeading(value.text) ? referenceColumn : nearestColumn(value);
      return [...lines].sort((a, b) => {
        const columnDifference = column(a) - column(b);
        if (columnDifference) return columnDifference;
        if (a.y != null && b.y != null && Math.abs(a.y - b.y) > 0.5) return b.y - a.y;
        return a.order - b.order;
      });
    })() : lines;
    return ordered.flatMap(value => {
      let line = value.text;
      if (value.x != null) {
        const indented = columnBases.some(position => value.x! - position >= 5 && value.x! - position <= 36);
        const labeled = /^\s*(?:\[\s*[A-Za-z0-9][^\]]{0,24}\]|\d{1,4} ?[.)])(?:\s+|(?=\p{Lu}))/u.test(value.text);
        if (indented && !labeled) line = `${CONTINUATION_LINE}${line}`;
      }
      return this.splitInlineReferenceHeading(line);
    });
  }

  /**
   * Many publishers put a reference's DOI only into its hyperlink (the visible text is the title or "Crossref").
   * Such DOIs and arXiv IDs are appended to the line the link starts on, so the parser can match by identifier
   * instead of falling back to the title. Lines that already show the identifier are left as they are.
   */
  private async addLinkIdentifiers(page: PdfPage, lines: PositionedLine[]): Promise<void> {
    if (typeof page.getAnnotations !== "function") return;
    let annotations: PdfAnnotation[];
    try {
      annotations = this.unwrap(await page.getAnnotations()) || [];
    } catch {
      return;
    }
    for (const annotation of annotations) {
      const url = this.decode(annotation.url || "");
      const rect = annotation.rect;
      if (!url || !rect || rect.length < 4) continue;
      const doi = normalizeDOI(url);
      const arxiv = !doi && /arxiv\.org\//i.test(url) ? normalizeArxiv(url) : undefined;
      if (!doi && !arxiv) continue;
      const x0 = rect[0]!;
      const y0 = Math.min(rect[1]!, rect[3]!);
      const top = Math.max(rect[1]!, rect[3]!);
      const tolerance = Math.max(4, Math.abs(rect[3]! - rect[1]!));
      // every physical line: a line joined at a hyphen is found by its second half too
      const candidates = lines.flatMap(line => (line.parts?.length ? line.parts : [line]).map(part => ({ line, x: part.x, y: part.y })));
      // A link wrapped over two lines has one rect around both; it belongs to the upper line (where it starts), not
      // to the next reference starting on the lower one. Baselines inside the rect, the link's column only (line
      // starts at most a hanging indent apart), the top one wins.
      const inside = candidates.filter(candidate => candidate.x != null && candidate.y != null
        && candidate.x <= x0 + 2 && candidate.y >= y0 - 4 && candidate.y <= top - 2);
      const columnStart = Math.max(...inside.map(candidate => candidate.x!));
      let best: (typeof candidates)[number] | undefined = inside
        .filter(candidate => columnStart - candidate.x! <= 40)
        .sort((a, b) => b.y! - a.y!)[0];
      // the line the link sits on: same height, starting at or left of the link; the closest start wins, so in
      // two-column layouts the line of the link's own column is taken
      if (!best) for (const candidate of candidates) {
        if (candidate.x == null || candidate.y == null) continue;
        if (Math.abs(candidate.y - y0) > tolerance || candidate.x > x0 + 2) continue;
        if (!best || candidate.x > best.x! || (candidate.x === best.x && Math.abs(candidate.y - y0) < Math.abs(best.y! - y0))) {
          best = candidate;
        }
      }
      if (!best) continue;
      const target = best.line;
      if (doi && normalizeDOI(target.text) !== doi) target.text += ` doi:${doi}`;
      if (arxiv && normalizeArxiv(target.text) !== arxiv) target.text += ` arXiv:${arxiv}`;
    }
  }

  private decode(url: string): string {
    try {
      return decodeURIComponent(url);
    } catch {
      return url;
    }
  }

  private splitInlineReferenceHeading(line: string): string[] {
    const visible = this.visibleLine(line);
    const match = visible.match(/^\s*((?:\d{1,4}\s+)?(?:references cited|literature cited|works cited|references|bibliography)(?:\s+\d{1,4})?)\s+(.+)$/i);
    if (!match || !this.looksLikeReferenceStart(match[2]!)) return [line];
    return [match[1]!, match[2]!];
  }

  private looksLikeReferenceStart(value: string): boolean {
    return /^\s*(?:\[\s*[A-Za-z0-9]|\d{1,4}[.)]|[A-ZÀ-ÖØ-Þ][\p{L}'’-]+(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}'’-]+){0,2}\s*,|[A-ZÀ-ÖØ-Þ][\p{L}'’-]+\s+[A-Z](?:-[A-Z])?\s*[,;]|[A-Z](?:-[A-Z])?\.\s*[A-ZÀ-ÖØ-Þ][\p{L}'’-]+)/u.test(value);
  }

  private unwrap<T>(value: T): T {
    const privileged = globalThis as typeof globalThis & {
      Cu?: { waiveXrays?<V>(target: V): V };
    };
    const withWrapper = value as T & { wrappedJSObject?: T };
    return privileged.Cu?.waiveXrays?.(value) || withWrapper.wrappedJSObject || value;
  }

  private splitReferences(text: string): ReferenceBlock[] {
    const starts = [...text.matchAll(LABELED_START)];
    const labeledStarts = this.plausibleLabeledStarts(starts);
    if (labeledStarts.length >= 2) {
      const final = labeledStarts.at(-1)!;
      const finalNumber = Number(this.label(final));
      const numberingReset = Number.isFinite(finalNumber) ? starts.find(match => {
        if (match.index! <= final.index!) return false;
        const label = this.label(match);
        const value = /^\d+$/.test(label) ? Number(label) : undefined;
        return value != null && value <= finalNumber;
      }) : undefined;
      return labeledStarts.map((match, i) => ({
        raw: this.visibleLine(text.slice(match.index!, labeledStarts[i + 1]?.index ?? numberingReset?.index ?? text.length)).trim(),
        fragments: [],
        index: /^\d+$/.test(this.label(match)) ? Number(this.label(match)) : undefined
      })).filter(block => block.raw.length >= 20);
    }
    const indices = [...new Set([
      ...[...text.matchAll(AUTHOR_START)].map(match => match.index!),
      ...[...text.matchAll(ORGANIZATION_START)].map(match => match.index!),
      ...[...text.matchAll(DITTO_START)].map(match => match.index!),
      ...[...text.matchAll(YEAR_PAREN_START)].map(match => match.index!)
    ])].sort((a, b) => a - b);
    let previousAuthor: string | undefined;
    return indices.map((start, i) => {
      const raw = this.visibleLine(text.slice(start, indices[i + 1] ?? text.length)).trim();
      const author = this.referenceFirstAuthor(raw);
      const organization = raw.match(/^([^,]{1,80}\b(?:Collaboration|Partnership)\b)/i)?.[1];
      const firstAuthorHint = /^[—–-]\./.test(raw) ? previousAuthor : surname(author || organization);
      if (firstAuthorHint) previousAuthor = firstAuthorHint;
      return { raw, fragments: [], firstAuthorHint };
    }).filter(block => block.raw.length >= 20);
  }

  private plausibleLabeledStarts(starts: RegExpMatchArray[]): RegExpMatchArray[] {
    if (starts.length < 2) return [];
    const numeric = starts.map(match => /^\d+$/.test(this.label(match)) ? Number(this.label(match)) : undefined);
    if (!numeric.some(value => value != null)) return starts;
    const accepted: RegExpMatchArray[] = [];
    let expected = 1;
    for (let i = 0; i < starts.length; i++) {
      if (numeric[i] !== expected) continue;
      accepted.push(starts[i]!);
      expected++;
    }
    return accepted.length >= 2 ? accepted : [];
  }

  private label(match: RegExpMatchArray): string {
    return match[1] || match[2] || match[3] || "";
  }

  private referenceFirstAuthor(raw: string): string | undefined {
    const surnameFirst = raw.match(new RegExp(`^(${SURNAME})(?:,\\s*${INITIALS}|${COMPACT_INITIALS})`, "u"))?.[1];
    if (surnameFirst) return surname(surnameFirst);
    const initialsFirst = raw.match(new RegExp(`^${INITIALS_FIRST}(${SURNAME})(?=\\s*[,;])`, "u"))?.[1];
    return surname(initialsFirst);
  }
}
