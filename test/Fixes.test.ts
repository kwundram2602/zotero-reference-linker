import { describe, expect, it } from "vitest";
import { CitationParser } from "../src/core/CitationParser";
import { LibraryMatcher } from "../src/core/LibraryMatcher";
import { normalizeTitle } from "../src/core/normalize";
import { PdfSectionExtractor, type PdfDocument } from "../src/core/PdfSectionExtractor";
import { ReaderIntegration } from "../src/reader/ReaderIntegration";
import { ReferenceOverlay } from "../src/reader/ReferenceOverlay";

const TITLE = "On the origin of species by means of natural selection";

function matcherWith(date: string, attachments: Record<number, boolean | undefined>): LibraryMatcher {
  const items = [{
    id: 1,
    libraryID: 1,
    itemTypeID: 1,
    isRegularItem: () => true,
    getField: (field: string) => ({ title: TITLE, date } as Record<string, string>)[field] || "",
    getCreators: () => [{ lastName: "Darwin" }],
    getAttachments: () => Object.keys(attachments).map(Number)
  }];
  const zotero = {
    Items: {
      getAll: async () => items,
      get: (id: number) => id in attachments ? {
        attachmentContentType: "application/pdf",
        // undefined: an attachment object without fileExists (older API) counts as present
        ...(attachments[id] === undefined ? {} : { fileExists: async () => attachments[id] })
      } : false
    }
  } as unknown as ZoteroAPI;
  return new LibraryMatcher(zotero);
}

function citation(year: number) {
  return { raw: TITLE, title: TITLE, normalizedTitle: normalizeTitle(TITLE), firstAuthor: "darwin", year };
}

describe("availablePdf", () => {
  it("skips PDF attachments whose file is missing", async () => {
    const matcher = matcherWith("1859", { 11: false, 12: true });
    await matcher.index(1);
    const match = matcher.match(citation(1859))!;
    expect(match.record.pdfAttachmentIDs).toEqual([11, 12]);
    expect(await matcher.availablePdf(match.record)).toBe(12);
  });

  it("returns undefined when no PDF file exists, so the badge says Item", async () => {
    const matcher = matcherWith("1859", { 11: false });
    await matcher.index(1);
    expect(await matcher.availablePdf(matcher.match(citation(1859))!.record)).toBeUndefined();
  });

  it("keeps attachments without fileExists", async () => {
    const matcher = matcherWith("1859", { 11: undefined });
    await matcher.index(1);
    expect(await matcher.availablePdf(matcher.match(citation(1859))!.record)).toBe(11);
  });
});

describe("years before 1900", () => {
  it("reads them from the item date, so a wrong citation year is rejected", async () => {
    const matcher = matcherWith("1859-11-24", {});
    await matcher.index(1);
    expect(matcher.match(citation(1859))?.record.year).toBe(1859);
    // without an author to confirm it, another year is another work; with the same author it is another edition
    expect(matcher.match({ ...citation(1950), firstAuthor: undefined })).toBeUndefined();
    expect(matcher.match(citation(1950))?.record.year).toBe(1859);
  });

  it("parses an old year only when no modern year is present", () => {
    const parser = new CitationParser();
    const old = parser.parse({ raw: "Darwin, C. On the origin of species. John Murray, London, 1859.", fragments: [] });
    expect(old.year).toBe(1859);
    const pages = parser.parse({ raw: "A. Author. A useful paper title here. Journal 12, pp. 1823–1830, 2019.", fragments: [] });
    expect(pages.year).toBe(2019);
  });
});

describe("identifiers from reference hyperlinks", () => {
  function linkedPdf(url: string): PdfDocument {
    const lines: Array<[string, number]> = [
      ["References", 700],
      ["[1] A. Author. A useful paper title. Journal, 2020.", 680],
      ["[2] B. Author. Another useful paper. 2021.", 665]
    ];
    return {
      numPages: 1,
      async getPage() {
        return {
          async getTextContent() {
            return { items: lines.map(([str, y]) => ({ str, hasEOL: true, transform: [1, 0, 0, 1, 72, y] })) };
          },
          async getAnnotations() {
            return [{ subtype: "Link", url, rect: [200, 678, 300, 690] }];
          }
        };
      }
    };
  }

  it("appends a DOI that is only in the link to the reference it belongs to", async () => {
    const section = await new PdfSectionExtractor().extract(linkedPdf("https://doi.org/10.1234%2Fabc.def"));
    expect(section?.references).toHaveLength(2);
    expect(section!.references[0]!.raw).toContain("doi:10.1234/abc.def");
    expect(section!.references[1]!.raw).not.toContain("doi:");
    expect(new CitationParser().parse(section!.references[0]!).doi).toBe("10.1234/abc.def");
  });

  it("appends arXiv IDs from arxiv.org links", async () => {
    const section = await new PdfSectionExtractor().extract(linkedPdf("https://arxiv.org/abs/1706.03762v5"));
    expect(new CitationParser().parse(section!.references[0]!).arxiv).toBe("1706.03762");
  });
});

describe("ReaderIntegration across libraries and library changes", () => {
  function libraryItem(id: number, libraryID: number) {
    return {
      id,
      libraryID,
      itemTypeID: 1,
      isRegularItem: () => true,
      isAttachment: () => false,
      getField: (field: string) => ({ title: TITLE, date: "1859" } as Record<string, string>)[field] || "",
      getCreators: () => [{ lastName: "Darwin" }],
      getAttachments: () => []
    };
  }

  function setup(libraries: Record<number, number[]>) {
    const items = new Map<number, ReturnType<typeof libraryItem>>();
    for (const [libraryID, ids] of Object.entries(libraries)) {
      for (const id of ids) items.set(id, libraryItem(id, Number(libraryID)));
    }
    const indexed: number[] = [];
    const zotero = {
      Items: {
        getAll: async (libraryID: number) => {
          indexed.push(libraryID);
          return [...items.values()].filter(item => item.libraryID === libraryID);
        },
        get: (id: number) => items.get(id) || false
      },
      Libraries: {
        getAll: () => [
          { libraryID: 1, libraryType: "user", name: "My Library" },
          { libraryID: 2, libraryType: "group", name: "Lab group" },
          { libraryID: 3, libraryType: "feed", name: "A feed" }
        ],
        get: (id: number) => ({ libraryID: id, libraryType: "group", name: id === 2 ? "Lab group" : "My Library" })
      }
    } as unknown as ZoteroAPI;
    // private members are reached through a loose view, as in the ReferenceOverlay tests
    const integration = new ReaderIntegration(zotero, "test") as unknown as {
      getMatchers(libraryID: number): Promise<LibraryMatcher[]>;
      matchAcross(matchers: LibraryMatcher[], citation: unknown): { outcome: { match?: { record: { item: { id: number } } }; ambiguous: boolean } };
      displayedMatch(match: unknown, matcher: LibraryMatcher, ownLibraryID: number): Promise<{ record: { title: string } }>;
      onItemsChanged(event: string, ids: number[]): void;
      matcherCache: Map<number, unknown>;
    };
    return { integration, indexed };
  }

  it("falls back to group libraries and names them, skipping feeds", async () => {
    const { integration, indexed } = setup({ 2: [21] });
    const matchers = await integration.getMatchers(1);
    expect(indexed.sort()).toEqual([1, 2]);
    const { outcome } = integration.matchAcross(matchers, citation(1859));
    expect(outcome.match?.record.item.id).toBe(21);
    const shown = await integration.displayedMatch(outcome.match, matchers[1]!, 1);
    expect(shown.record.title).toContain("(in Lab group)");
  });

  it("prefers the reader's own library", async () => {
    const { integration } = setup({ 1: [11], 2: [21] });
    const { outcome } = integration.matchAcross(await integration.getMatchers(1), citation(1859));
    expect(outcome.match?.record.item.id).toBe(11);
  });

  it("drops the indexes when items change, but not for unknown ids (notes, annotations)", async () => {
    const { integration } = setup({ 1: [11] });
    await integration.getMatchers(1);
    integration.onItemsChanged("modify", [999]);
    expect(integration.matcherCache.size).toBe(2);
    integration.onItemsChanged("modify", [11]);
    expect(integration.matcherCache.size).toBe(0);
    await integration.getMatchers(1);
    integration.onItemsChanged("delete", [999]);
    expect(integration.matcherCache.size).toBe(0);
  });
});

describe("host actions for unmatched references", () => {
  it("are offered after the built-in ones and make a reference without metadata actionable", () => {
    const doc = {
      defaultView: { Element: class {} },
      addEventListener() {},
      getElementById: () => null,
      createElement: () => ({ id: "", textContent: "" }),
      head: { append() {} }
    } as unknown as Document;
    const overlay = new ReferenceOverlay(doc, () => {}) as unknown as {
      setExtraActions(provider: (citation: { raw: string; doi?: string }) => unknown[]): void;
      actionsFor(citation: { raw: string; doi?: string }): Array<{ kind: string; label: string }>;
    };
    expect(overlay.actionsFor({ raw: "" })).toHaveLength(0);
    overlay.setExtraActions(citation => citation.doi ? [{ kind: "run", label: "Add to Zotero", run() {} }] : []);
    const labels = overlay.actionsFor({ raw: "X. A paper. 2020.", doi: "10.1234/x" }).map(action => action.label);
    expect(labels).toEqual(["Open DOI", "Search", "Copy reference", "Add to Zotero"]);
  });
});
