import { describe, expect, it } from "vitest";
import { findIndexedReferenceMarkers, ReferenceOverlay, unmatchedReferenceActions } from "../src/reader/ReferenceOverlay";

describe("findIndexedReferenceMarkers", () => {
  it("finds bracketed and plain numbered reference markers", () => {
    const text = "References 1. Mead, D. J. Paper one. 2) Sepahvand, K. Paper two. [3] Gu, M. Paper three.";
    expect(findIndexedReferenceMarkers(text).map(marker => marker.index)).toEqual([1, 2, 3]);
  });

  it("does not treat years or decimal values as reference markers", () => {
    expect(findIndexedReferenceMarkers("Paper. 1975, 40, 19-39. CFL = 1.1.")).toEqual([]);
  });

  it("marks an unmatched indexed reference with the gray-highlight class", () => {
    const page = {} as HTMLElement;
    const classes = [new Set<string>(), new Set<string>()];
    const spans = classes.map((values, index) => ({
      textContent: index ? "Missing library paper." : "1.",
      classList: { add: (...names: string[]) => names.forEach(name => values.add(name)) },
      closest: () => page
    })) as unknown as HTMLElement[];
    const style = { id: "", textContent: "" };
    const doc = {
      defaultView: { Element: class {} },
      addEventListener() {},
      getElementById: () => null,
      createElement: () => style,
      head: { append() {} }
    } as unknown as Document;
    const overlay = new ReferenceOverlay(doc, () => {});
    Object.assign(overlay, { pages: [{
      page,
      pageIndex: 0,
      spans,
      text: "1. Missing library paper.",
      offsets: [{ start: 0, end: 2 }, { start: 3, end: 25 }],
      searchableStart: 0,
      searchableEnd: 25,
      compact: { text: "", offsets: [] }
    }] });

    expect(overlay.renderIndexedUnmatched(1)).toBe(true);
    expect(classes.every(values => values.has("reference-linker-unmatched"))).toBe(true);
    expect(style.textContent).toContain(".reference-linker-unmatched");
  });
});

describe("indexed reference placement", () => {
  // one span per segment; returns the overlay page and the classes each span got
  function page(pageIndex: number, segments: string[], searchableFrom: string) {
    const element = {} as HTMLElement;
    const classes = segments.map(() => new Set<string>());
    const spans = segments.map((text, index) => ({
      textContent: text,
      classList: { add: (...names: string[]) => names.forEach(name => classes[index]!.add(name)) },
      closest: () => element
    })) as unknown as HTMLElement[];
    const offsets: Array<{ start: number; end: number }> = [];
    let text = "";
    for (const segment of segments) {
      if (text) text += " ";
      offsets.push({ start: text.length, end: text.length + segment.length });
      text += segment;
    }
    const indexed = {
      page: element, pageIndex, spans, text, offsets,
      searchableStart: text.indexOf(searchableFrom), searchableEnd: text.length, compact: { text: "", offsets: [] }
    };
    return { indexed, marked: () => segments.filter((_, index) => classes[index]!.size > 0) };
  }

  it("puts reference 1 on its entry, not on 'Volume 1.' inside reference 31 or a '1.' before the heading", () => {
    const first = page(0, ["1.", "Introduction", "References", "1.", "He, K.: Deep residual learning.", "2.", "Other, A.: Paper."], "References");
    const later = page(1, ["31.", "Lin, T.Y.: Feature pyramid networks. In: CVPR. Volume", "1.", "(2017) 4", "32.", "Next, B.: Paper."], "31.");
    const style = { id: "", textContent: "" };
    const doc = {
      defaultView: { Element: class {} },
      addEventListener() {},
      getElementById: () => null,
      createElement: () => style,
      head: { append() {} }
    } as unknown as Document;
    const overlay = new ReferenceOverlay(doc, () => {});
    Object.assign(overlay, { pages: [first.indexed, later.indexed] });
    // matched and unmatched references are placed by the same code; unmatched needs no badge geometry here
    expect(overlay.renderIndexedUnmatched(1)).toBe(true);
    expect(first.marked()).toEqual(["1.", "He, K.: Deep residual learning."]);
    expect(later.marked()).toEqual([]);
    // reference 31 is not cut at "Volume 1."
    expect(overlay.renderIndexedUnmatched(31)).toBe(true);
    expect(later.marked()).toEqual(["31.", "Lin, T.Y.: Feature pyramid networks. In: CVPR. Volume", "1.", "(2017) 4"]);
  });
});

describe("unmatchedReferenceActions", () => {
  it("offers DOI, Scholar search, and title copy when metadata is available", () => {
    expect(unmatchedReferenceActions({
      raw: "Example reference",
      doi: "10.1234/example",
      title: "A useful paper title"
    })).toEqual([
      { kind: "open", label: "Open DOI", value: "https://doi.org/10.1234/example" },
      { kind: "open", label: "Search", value: "https://scholar.google.com/scholar?q=A%20useful%20paper%20title" },
      { kind: "copy", label: "Copy title", value: "A useful paper title" }
    ]);
  });

  it("falls back to searching and copying the full reference when no title is available", () => {
    expect(unmatchedReferenceActions({ raw: "Author, Journal 10, 20–30 (2024)." })).toEqual([
      { kind: "open", label: "Search", value: "https://scholar.google.com/scholar?q=Author%2C%20Journal%2010%2C%2020%E2%80%9330%20(2024)." },
      { kind: "copy", label: "Copy reference", value: "Author, Journal 10, 20–30 (2024)." }
    ]);
  });

  it("does not offer actions for an empty reference", () => {
    expect(unmatchedReferenceActions({ raw: "  " })).toEqual([]);
  });
});
