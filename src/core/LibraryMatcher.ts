import { normalizeArxiv, normalizeContainerTitle, normalizeDOI, normalizeLocator, normalizeTitle, normalizeVolume, surname, titleSimilarity } from "./normalize";
import type { LibraryRecord, MatchOutcome, MatchResult, ParsedCitation } from "./types";

interface ScoredCandidate {
  record: LibraryRecord;
  exact: boolean;
  score: number;
}

interface MetadataCheck {
  authorMatch: boolean;
  yearMatch: boolean;
  containerMatch: boolean;
  itemTypeMatch: boolean;
}

export class LibraryMatcher {
  private byDOI = new Map<string, LibraryRecord[]>();
  private byArxiv = new Map<string, LibraryRecord[]>();
  private byTitle = new Map<string, LibraryRecord[]>();
  private byCompactTitle = new Map<string, LibraryRecord[]>();
  private byToken = new Map<string, Set<LibraryRecord>>();
  private byAuthorYear = new Map<string, LibraryRecord[]>();
  private pdfChecks = new Map<LibraryRecord, Promise<number | undefined>>();

  constructor(private readonly zotero: ZoteroAPI) {}

  async index(libraryID: number): Promise<void> {
    const items = await this.zotero.Items.getAll(libraryID, true, false);
    this.byDOI.clear();
    this.byArxiv.clear();
    this.byTitle.clear();
    this.byCompactTitle.clear();
    this.byToken.clear();
    this.byAuthorYear.clear();
    this.pdfChecks.clear();

    for (const item of items) {
      if (!item.isRegularItem()) continue;
      const title = this.field(item, "title");
      if (!title) continue;
      const extra = this.field(item, "extra");
      const creators = item.getCreators();
      const containerTitle = this.field(item, "bookTitle")
        || this.field(item, "proceedingsTitle")
        || this.field(item, "publicationTitle")
        || undefined;
      const pdfAttachmentIDs = item.getAttachments().filter(id => {
        const attachment = this.zotero.Items.get(id);
        return attachment && attachment.attachmentContentType === "application/pdf";
      });
      const pdfAttachmentID = pdfAttachmentIDs[0];
      const record: LibraryRecord = {
        item,
        title,
        normalizedTitle: normalizeTitle(title),
        containerTitle,
        normalizedContainerTitle: containerTitle ? normalizeContainerTitle(containerTitle) : undefined,
        doi: normalizeDOI(this.field(item, "DOI") || extra),
        arxiv: normalizeArxiv(`${extra} ${this.field(item, "url")}`),
        year: this.year(this.field(item, "date")),
        arxivYear: this.arxivYear(normalizeArxiv(`${extra} ${this.field(item, "url")}`)),
        firstAuthor: surname(creators[0]?.lastName || creators[0]?.name),
        volume: normalizeVolume(this.field(item, "volume")),
        issue: this.field(item, "issue") || undefined,
        pages: this.field(item, "pages") || undefined,
        articleNumber: this.field(item, "articleNumber") || undefined,
        itemType: this.itemType(item),
        pdfAttachmentID,
        pdfAttachmentIDs
      };

      for (const token of new Set(this.tokens(record.normalizedTitle))) {
        const records = this.byToken.get(token) || new Set<LibraryRecord>();
        records.add(record);
        this.byToken.set(token, records);
      }
      if (record.doi) this.add(this.byDOI, record.doi, record);
      if (record.arxiv) this.add(this.byArxiv, record.arxiv, record);
      this.add(this.byTitle, record.normalizedTitle, record);
      this.add(this.byCompactTitle, this.compact(record.normalizedTitle), record);
      if (record.firstAuthor && record.year) this.add(this.byAuthorYear, this.authorYearKey(record.firstAuthor, record.year), record);
    }
  }

  /**
   * The first PDF attachment of a matched record whose file exists, or undefined. A linked file that was moved or
   * deleted would otherwise show "↗ PDF" and fail on click. Checked lazily for matched records only, once per record.
   */
  availablePdf(record: LibraryRecord): Promise<number | undefined> {
    let pending = this.pdfChecks.get(record);
    if (!pending) {
      pending = (async () => {
        for (const id of record.pdfAttachmentIDs ?? (record.pdfAttachmentID ? [record.pdfAttachmentID] : [])) {
          const attachment = this.zotero.Items.get(id);
          if (!attachment) continue;
          if (!attachment.fileExists || await attachment.fileExists()) return id;
        }
        return undefined;
      })();
      this.pdfChecks.set(record, pending);
    }
    return pending;
  }

  match(citation: ParsedCitation): MatchResult | undefined {
    return this.matchWithOutcome(citation).match;
  }

  matchWithOutcome(citation: ParsedCitation): MatchOutcome {
    if (citation.doi) {
      const record = this.preferredIdentifierRecord(this.byDOI.get(citation.doi) || [], citation);
      if (record) return { match: { record, method: "doi", score: 1 }, ambiguous: false };
    }
    if (citation.arxiv) {
      const record = this.preferredIdentifierRecord(this.byArxiv.get(citation.arxiv) || [], citation);
      if (record) return { match: { record, method: "arxiv", score: 1 }, ambiguous: false };
    }
    const bibliographic = this.matchBibliographic(citation);
    if (bibliographic) return bibliographic;
    if (!citation.normalizedTitle || citation.normalizedTitle.length < 12) return this.matchContained(citation) || { ambiguous: false };

    const exact = (this.byTitle.get(citation.normalizedTitle) || [])
      .map(record => this.scoreCandidate(record, citation, true))
      .filter((candidate): candidate is ScoredCandidate => Boolean(candidate));
    if (exact.length) return this.resolve(exact, "title-exact", citation)!;

    const compactExact = (this.byCompactTitle.get(this.compact(citation.normalizedTitle)) || [])
      .filter(record => record.normalizedTitle !== citation.normalizedTitle)
      .map(record => this.scoreCandidate(record, citation, true))
      .filter((candidate): candidate is ScoredCandidate => Boolean(candidate));
    if (compactExact.length) return this.resolve(compactExact, "title-exact", citation)!;

    const records = new Set<LibraryRecord>();
    for (const token of this.tokens(citation.normalizedTitle)) {
      for (const record of this.byToken.get(token) || []) records.add(record);
    }
    const fuzzy = [...records]
      .filter(record => record.normalizedTitle !== citation.normalizedTitle)
      .map(record => this.scoreCandidate(record, citation, false))
      .filter((candidate): candidate is ScoredCandidate => Boolean(candidate));
    return this.resolve(fuzzy, "title-fuzzy", citation) || this.matchContained(citation) || { ambiguous: false };
  }

  /**
   * The reference text contains a library title as a whole phrase, by the same first author. Covers references whose
   * title was not parsed ("Redmon, J.; Farhadi, A. YOLO9000: Better, Faster, Stronger. In …") or was parsed with
   * extra words ("Introduction to Microwave Remote Sensing. Boca Raton"). The longest contained title wins, so DeepSORT
   * is not taken for SORT; a title that is only part of a much longer parsed title ("Generative adversarial networks"
   * in "Generative adversarial networks: an overview") is another work. Two-word titles also need the year.
   */
  private matchContained(citation: ParsedCitation): MatchOutcome | undefined {
    const text = ` ${normalizeTitle(citation.raw)} `;
    const records = new Set<LibraryRecord>();
    for (const token of new Set(this.tokens(text.trim()))) {
      for (const record of this.byToken.get(token) || []) records.add(record);
    }
    const contained = [...records].filter(record => {
      const title = record.normalizedTitle;
      if (title.split(" ").length < 2 || title.length < 8 || !text.includes(` ${title} `)) return false;
      return !this.followedBySubtitle(title, citation.raw) && !this.extendsTitle(title, citation.title);
    });
    const longest = contained.filter(record => !contained.some(other =>
      other.normalizedTitle.length > record.normalizedTitle.length && other.normalizedTitle.includes(record.normalizedTitle)));
    const scored = longest.flatMap(record => {
      const metadata = this.checkMetadata(record, citation, true);
      if (!metadata?.authorMatch) return [];
      if (this.shortTitle(record) && this.yearDistance(record, citation) > 1) return [];
      return [{
        record,
        exact: true,
        score: 0.9 + Number(metadata.yearMatch) * 0.04 + Number(metadata.containerMatch) * 0.05 + Number(metadata.itemTypeMatch) * 0.03
      }];
    });
    return this.resolve(scored, "title-contained", citation);
  }

  private matchBibliographic(citation: ParsedCitation): MatchOutcome | undefined {
    if (citation.normalizedTitle || !citation.firstAuthor || !citation.year) return undefined;
    const candidates = this.byAuthorYear.get(this.authorYearKey(citation.firstAuthor, citation.year)) || [];
    const scored = candidates.flatMap(record => {
      let matches = 0;
      let score = 0.45;
      const citationLocator = normalizeLocator(citation.articleNumber || citation.pages);
      const recordLocator = normalizeLocator(record.articleNumber || record.pages);

      if (citation.normalizedContainerTitle && record.normalizedContainerTitle) {
        if (citation.normalizedContainerTitle !== record.normalizedContainerTitle) return [];
        matches++;
        score += 0.18;
      }
      if (citation.volume && record.volume) {
        if (normalizeVolume(citation.volume) !== normalizeVolume(record.volume)) return [];
        matches++;
        score += 0.16;
      }
      if (citationLocator && recordLocator) {
        if (citationLocator !== recordLocator) return [];
        matches++;
        score += 0.2;
      }
      const strongEnough = matches >= 2 && Boolean(citationLocator || (citation.normalizedContainerTitle && citation.volume));
      return strongEnough ? [{ record, exact: true, score }] : [];
    });
    return this.resolve(scored, "bibliographic");
  }

  private scoreCandidate(record: LibraryRecord, citation: ParsedCitation, exact: boolean): ScoredCandidate | undefined {
    const metadata = this.checkMetadata(record, citation, exact);
    if (!metadata) return undefined;

    let titleScore = 1;
    if (!exact) {
      titleScore = titleSimilarity(citation.normalizedTitle!, record.normalizedTitle) || 0;
      if (!titleScore && metadata.authorMatch && metadata.yearMatch) {
        titleScore = titleSimilarity(citation.normalizedTitle!, record.normalizedTitle, true) || 0;
      }
      if (!titleScore) return undefined;
      if (!metadata.authorMatch && !metadata.yearMatch && !metadata.containerMatch && !metadata.itemTypeMatch) return undefined;
    }

    return {
      record,
      exact,
      score: titleScore
        + Number(metadata.authorMatch) * 0.08
        + Number(metadata.yearMatch) * 0.04
        + Number(metadata.containerMatch) * 0.05
        + Number(metadata.itemTypeMatch) * 0.03
    };
  }

  /**
   * `wholeTitle`: the title matched as a whole (exact or contained), not fuzzily. Then another year is allowed when
   * the first author agrees: another version of the same work, e.g. AlexNet cited as NIPS 2012 and in Zotero as its
   * 2017 CACM reprint, or an arXiv preprint dated by its latest version.
   */
  private checkMetadata(record: LibraryRecord, citation: ParsedCitation, wholeTitle = false): MetadataCheck | undefined {
    const authorMatch = Boolean(record.firstAuthor
      && (citation.firstAuthor === record.firstAuthor || this.inFirstAuthor(record.firstAuthor, citation.raw)));
    if (citation.firstAuthor && record.firstAuthor && !authorMatch) return undefined;

    const years = this.yearDistance(record, citation);
    const yearMatch = years === 0;
    if (Number.isFinite(years) && years > 1 && !(wholeTitle && authorMatch && !this.shortTitle(record))) return undefined;

    const itemTypeMatch = Boolean(citation.itemTypeHint && record.itemType && citation.itemTypeHint === record.itemType);

    let containerMatch = false;
    if (citation.normalizedContainerTitle && record.normalizedContainerTitle) {
      containerMatch = citation.normalizedContainerTitle === record.normalizedContainerTitle
        || titleSimilarity(citation.normalizedContainerTitle, record.normalizedContainerTitle) != null;
      if (citation.itemTypeHint === "bookSection" && record.itemType === "bookSection" && !containerMatch) return undefined;
    }
    return { authorMatch, yearMatch, containerMatch, itemTypeMatch };
  }

  private resolve(candidates: ScoredCandidate[], method: MatchResult["method"], citation?: ParsedCitation): MatchOutcome | undefined {
    candidates.sort((a, b) => b.score - a.score || a.record.item.id - b.record.item.id);
    let first = candidates[0];
    if (!first) return undefined;
    const second = candidates[1];
    if (second && first.score - second.score < 0.06) {
      const tied = candidates.filter(candidate => first!.score - candidate.score < 0.06);
      const sameDOI = first.record.doi && tied.every(candidate => candidate.record.doi === first!.record.doi);
      const sameArxiv = first.record.arxiv && tied.every(candidate => candidate.record.arxiv === first!.record.arxiv);
      if (sameDOI || sameArxiv) {
        first = tied.sort((a, b) =>
          Number(Boolean(b.record.pdfAttachmentID)) - Number(Boolean(a.record.pdfAttachmentID))
          || a.record.item.id - b.record.item.id
        )[0]!;
      } else if (this.sameWork(tied.map(candidate => candidate.record))) {
        // versions of one work (preprint and published paper, or a duplicate): the one closest to the citation
        const distance = (record: LibraryRecord) => citation ? this.yearDistance(record, citation) : 0;
        const typeMatch = (record: LibraryRecord) => Number(Boolean(citation?.itemTypeHint && citation.itemTypeHint === record.itemType));
        first = tied.sort((a, b) =>
          (distance(a.record) === distance(b.record) ? 0 : distance(a.record) < distance(b.record) ? -1 : 1)
          || typeMatch(b.record) - typeMatch(a.record)
          || Number(Boolean(b.record.pdfAttachmentID)) - Number(Boolean(a.record.pdfAttachmentID))
          || a.record.item.id - b.record.item.id
        )[0]!;
      } else {
        return { ambiguous: true };
      }
    }
    return { match: { record: first.record, method, score: Math.min(first.score, 0.99) }, ambiguous: false };
  }

  private preferredIdentifierRecord(records: LibraryRecord[], citation: ParsedCitation): LibraryRecord | undefined {
    return [...records].sort((a, b) => {
      const pdf = Number(Boolean(b.pdfAttachmentID)) - Number(Boolean(a.pdfAttachmentID));
      if (pdf) return pdf;
      const metadata = this.identifierMetadataScore(b, citation) - this.identifierMetadataScore(a, citation);
      return metadata || a.item.id - b.item.id;
    })[0];
  }

  private identifierMetadataScore(record: LibraryRecord, citation: ParsedCitation): number {
    return Number(Boolean(citation.firstAuthor && record.firstAuthor === citation.firstAuthor))
      + Number(Boolean(citation.year && record.year === citation.year));
  }

  private itemType(item: ZoteroItem): string | undefined {
    try {
      return this.zotero.ItemTypes?.getName(item.itemTypeID) || (this.field(item, "bookTitle") ? "bookSection" : undefined);
    } catch {
      return this.field(item, "bookTitle") ? "bookSection" : undefined;
    }
  }

  private field(item: ZoteroItem, name: string): string {
    try {
      return item.getField(name) || "";
    } catch {
      return "";
    }
  }

  private tokens(value: string): string[] {
    return value.split(" ").filter(word => word.length > 2);
  }

  private compact(value: string): string {
    return value.replace(/\s+/g, "");
  }

  private add(map: Map<string, LibraryRecord[]>, key: string, record: LibraryRecord): void {
    const records = map.get(key) || [];
    records.push(record);
    map.set(key, records);
  }

  private authorYearKey(author: string, year: number): string {
    return `${author}\u0000${year}`;
  }

  /**
   * In the raw reference the title goes on with a subtitle ("Efficient Processing of Deep Neural Networks: A Tutorial
   * and Survey"): a longer title, so another work than the library item without it (here a book by the same authors).
   */
  private followedBySubtitle(normalizedTitle: string, raw: string): boolean {
    const found = this.findTitle(normalizedTitle, raw);
    return Boolean(found && /^\s*(?::|[—–]|\s-)\s*[\p{L}\p{N}]/u.test(found.after));
  }

  /**
   * The parsed title continues the library title with more words ("Principles of Vibration and Sound" around
   * "Vibration and Sound"): a longer title, another work. A parsed title that only picked up authors or the venue
   * around it ("and J. Sun. Deep residual learning for image recognition. In CVPR") is separated by a period.
   */
  private extendsTitle(normalizedTitle: string, parsedTitle?: string): boolean {
    const found = parsedTitle ? this.findTitle(normalizedTitle, parsedTitle) : undefined;
    if (!found) return false;
    const left = found.before.trim() !== "" && !/[.!?"“”]\s*$/u.test(found.before);
    const right = /^\s*[\p{L}\p{N}]/u.test(found.after);
    return left || right;
  }

  /** `normalizedTitle` in `text`, its words separated by any punctuation; the text before and after it. */
  private findTitle(normalizedTitle: string, text: string): { before: string; after: string } | undefined {
    const plain = text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    const words = normalizedTitle.split(" ").join("[^\\p{L}\\p{N}]+");
    const match = plain.match(new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, "u"));
    if (!match || match.index == null) return undefined;
    return { before: plain.slice(0, match.index), after: plain.slice(match.index + match[0].length) };
  }

  /** "Network in Network", "Machine Learning": too unspecific to accept another year or a match without a year. */
  private shortTitle(record: LibraryRecord): boolean {
    return this.tokens(record.normalizedTitle).length < 3 || record.normalizedTitle.length < 15;
  }

  /** Same title (ignoring spaces and punctuation) and same first author: versions or duplicates of one work. */
  private sameWork(records: LibraryRecord[]): boolean {
    const [first] = records;
    return Boolean(first?.firstAuthor) && records.every(record =>
      record.firstAuthor === first!.firstAuthor && this.compact(record.normalizedTitle) === this.compact(first!.normalizedTitle));
  }

  /** Years between the citation and the closest of the record's years; Infinity when either has none. */
  private yearDistance(record: LibraryRecord, citation: ParsedCitation): number {
    const years = [record.year, record.arxivYear].filter((year): year is number => year != null);
    if (!citation.year || !years.length) return Infinity;
    return Math.min(...years.map(year => Math.abs(year - citation.year!)));
  }

  /**
   * The surname occurs in the first author of the raw reference. The parsed firstAuthor can be a given name or glued
   * to the next word in PDF text ("SainingXie, RossGirshick", "ChenLC"), which used to reject the right item.
   */
  private inFirstAuthor(name: string, raw: string): boolean {
    const first = raw.replace(/^\s*(?:\[[^\]]{1,24}\]|\d+[.)]?)\s*/, "").split(/,|;|\(|\s(?:and|&)\s/)[0]!.slice(0, 60);
    return normalizeTitle(first).split(" ").some(token => token === name
      || (name.length >= 3 && token.length > name.length && (token.startsWith(name) || token.endsWith(name))));
  }

  private arxivYear(id?: string): number | undefined {
    const match = id?.match(/^(\d{2})\d{2}\.\d{4,5}$/) || id?.match(/\/(\d{2})\d{5}$/);
    if (!match) return undefined;
    const year = Number(match[1]);
    return year >= 91 ? 1900 + year : 2000 + year;
  }

  private year(value: string): number | undefined {
    // the date field holds only a date, so years before 1900 (classic literature) are safe to accept here
    const match = value.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
    return match ? Number(match[1]) : undefined;
  }
}
