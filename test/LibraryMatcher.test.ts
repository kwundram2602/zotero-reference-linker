import { describe, expect, it } from "vitest";
import { CitationParser } from "../src/core/CitationParser";
import { LibraryMatcher } from "../src/core/LibraryMatcher";
import { normalizeTitle } from "../src/core/normalize";
import type { ParsedCitation } from "../src/core/types";

interface ItemData {
  id: number;
  title: string;
  author?: string;
  year?: number;
  doi?: string;
  arxiv?: string;
  bookTitle?: string;
  publicationTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  articleNumber?: string;
  itemType?: "book" | "bookSection" | "conferencePaper" | "journalArticle";
  pdf?: boolean;
}

function setup(data: ItemData[]): LibraryMatcher {
  const attachments = new Map<number, { attachmentContentType: string }>();
  const itemTypes = new Map<string, number>();
  const typeNames = new Map<number, string>();
  const items = data.map(entry => {
    const itemType = entry.itemType || "journalArticle";
    if (!itemTypes.has(itemType)) {
      const id = itemTypes.size + 1;
      itemTypes.set(itemType, id);
      typeNames.set(id, itemType);
    }
    const attachmentID = entry.id + 10_000;
    if (entry.pdf) attachments.set(attachmentID, { attachmentContentType: "application/pdf" });
    const fields: Record<string, string> = {
      title: entry.title,
      date: entry.year ? String(entry.year) : "",
      DOI: entry.doi || "",
      extra: entry.arxiv ? `arXiv: ${entry.arxiv}` : "",
      bookTitle: entry.bookTitle || "",
      publicationTitle: entry.publicationTitle || "",
      volume: entry.volume || "",
      issue: entry.issue || "",
      pages: entry.pages || "",
      articleNumber: entry.articleNumber || ""
    };
    return {
      id: entry.id,
      libraryID: 1,
      itemTypeID: itemTypes.get(itemType)!,
      isRegularItem: () => true,
      getField: (field: string) => fields[field] || "",
      getCreators: () => entry.author ? [{ lastName: entry.author }] : [],
      getAttachments: () => entry.pdf ? [attachmentID] : []
    };
  });
  const zotero = {
    Items: {
      getAll: async () => items,
      get: (id: number) => attachments.get(id) || false
    },
    ItemTypes: { getName: (id: number) => typeNames.get(id) || "" }
  } as unknown as ZoteroAPI;
  const matcher = new LibraryMatcher(zotero);
  void matcher.index(1);
  return matcher;
}

async function indexed(data: ItemData[]): Promise<LibraryMatcher> {
  const matcher = setup(data);
  await new Promise(resolve => setTimeout(resolve, 0));
  return matcher;
}

function citation(title: string, metadata: Partial<ParsedCitation> = {}): ParsedCitation {
  return { raw: title, title, normalizedTitle: normalizeTitle(title), ...metadata };
}

describe("LibraryMatcher", () => {
  it("matches a wording variant when author and year corroborate it", async () => {
    const matcher = await indexed([{
      id: 1,
      title: "Active Label Correction for Semantic Segmentation with Foundation Models",
      author: "Kim",
      year: 2024
    }]);
    expect(matcher.match(citation(
      "Active Label Correction for Semantic Segmentation using Foundation Models",
      { firstAuthor: "kim", year: 2024 }
    ))?.method).toBe("title-fuzzy");
  });

  it("prefers a complete title over a contained shorter title", async () => {
    const matcher = await indexed([
      { id: 1, title: "Principles of Vibration and Sound", author: "Rossing", year: 2004, itemType: "book" },
      { id: 2, title: "Vibration and Sound", author: "Different", year: 1995, itemType: "book" }
    ]);
    const result = matcher.match(citation("Principles of Vibration and Sound", { firstAuthor: "rossing", year: 2004 }));
    expect(result?.record.item.id).toBe(1);
  });

  it("rejects a contained shorter title when the complete item is absent", async () => {
    const matcher = await indexed([
      { id: 2, title: "Vibration and Sound", author: "Rossing", year: 2004, itemType: "book" }
    ]);
    expect(matcher.match(citation(
      "Principles of Vibration and Sound",
      { firstAuthor: "rossing", year: 2004 }
    ))).toBeUndefined();
  });

  it("uses metadata to resolve duplicate exact titles", async () => {
    const matcher = await indexed([
      { id: 1, title: "A Shared Research Title", author: "Lee", year: 2024 },
      { id: 2, title: "A Shared Research Title", author: "Smith", year: 2018 }
    ]);
    expect(matcher.match(citation(
      "A Shared Research Title",
      { firstAuthor: "lee", year: 2024 }
    ))?.record.item.id).toBe(1);
  });

  it("abstains when duplicate exact titles cannot be distinguished", async () => {
    const matcher = await indexed([
      { id: 1, title: "A Shared Research Title" },
      { id: 2, title: "A Shared Research Title" }
    ]);
    const parsed = citation("A Shared Research Title");
    expect(matcher.match(parsed)).toBeUndefined();
    expect(matcher.matchWithOutcome(parsed)).toEqual({ ambiguous: true });
  });

  it("prefers the PDF-bearing copy when exact-title duplicates share a DOI", async () => {
    const title = "Wave Propagation and Natural Modes in Periodic Systems: II. Multi-Coupled Systems, With and Without Damping";
    const matcher = await indexed([
      { id: 1, title, author: "Mead", year: 1975, doi: "10.1016/S0022-460X(75)80228-8" },
      { id: 2, title, author: "Mead", year: 1975, doi: "10.1016/S0022-460X(75)80228-8", pdf: true }
    ]);
    const result = matcher.match(citation(title, { firstAuthor: "mead", year: 1975 }));
    expect(result?.record.item.id).toBe(2);
  });

  it("distinguishes a book section from a same-title book", async () => {
    const matcher = await indexed([
      { id: 1, title: "A Shared Chapter Title", author: "Kim", year: 2022, itemType: "bookSection", bookTitle: "Collected Research Methods" },
      { id: 2, title: "A Shared Chapter Title", author: "Kim", year: 2022, itemType: "book" }
    ]);
    const result = matcher.match(citation("A Shared Chapter Title", {
      firstAuthor: "kim",
      year: 2022,
      itemTypeHint: "bookSection",
      containerTitle: "Collected Research Methods",
      normalizedContainerTitle: "collected research methods"
    }));
    expect(result?.record.item.id).toBe(1);
  });

  it("rejects a title made from the same tokens in a different order", async () => {
    const matcher = await indexed([{
      id: 1,
      title: "Robust Active Learning for Semantic Segmentation",
      author: "Kim",
      year: 2024
    }]);
    expect(matcher.match(citation(
      "Semantic Segmentation for Robust Active Learning",
      { firstAuthor: "kim", year: 2024 }
    ))).toBeUndefined();
  });

  it("prefers the PDF-bearing duplicate for an exact DOI", async () => {
    const matcher = await indexed([
      { id: 1, title: "Metadata Only", doi: "10.1000/example" },
      { id: 2, title: "With PDF", doi: "10.1000/example", pdf: true }
    ]);
    expect(matcher.match({ raw: "", doi: "10.1000/example" })?.record.item.id).toBe(2);
  });

  it("matches the VaB-AL proceedings citation to a conference item", async () => {
    const matcher = await indexed([{
      id: 1,
      title: "VaB-AL: Incorporating Class Imbalance and Difficulty with Variational Bayes for Active Learning",
      author: "Choi",
      year: 2020,
      itemType: "conferencePaper"
    }]);
    const parsed = new CitationParser().parse({
      raw: '[194] J. Choi, K. Yi et al., “Vab-al: Incorporating class imbalance and difficulty with variational bayes for active learning,” in Proc. of CVPR, 2021, pp. 6749–6758.',
      fragments: [],
      index: 194
    });
    expect(matcher.match(parsed)?.record.item.id).toBe(1);
  });

  it("allows exact-title matching when a citation type is unknown", async () => {
    const matcher = await indexed([{
      id: 1,
      title: "A Paper with Numbered Pages",
      author: "Smith",
      year: 2022,
      itemType: "conferencePaper"
    }]);
    expect(matcher.match(citation("A Paper with Numbered Pages", {
      firstAuthor: "smith",
      year: 2022
    }))?.record.item.id).toBe(1);
  });

  it("treats item type as supporting metadata for an otherwise exact match", async () => {
    const matcher = await indexed([{
      id: 1,
      title: "A Shared Chapter Title",
      author: "Kim",
      year: 2022,
      itemType: "conferencePaper"
    }]);
    expect(matcher.match(citation("A Shared Chapter Title", {
      firstAuthor: "kim",
      year: 2022,
      itemTypeHint: "bookSection",
      containerTitle: "Collected Research Methods",
      normalizedContainerTitle: "collected research methods"
    }))?.record.item.id).toBe(1);
  });

  it("rejects a book-section candidate with a conflicting container", async () => {
    const matcher = await indexed([{
      id: 1,
      title: "A Shared Chapter Title",
      author: "Kim",
      year: 2022,
      itemType: "bookSection",
      bookTitle: "A Different Edited Volume"
    }]);
    expect(matcher.match(citation("A Shared Chapter Title", {
      firstAuthor: "kim",
      year: 2022,
      itemTypeHint: "bookSection",
      containerTitle: "Collected Research Methods",
      normalizedContainerTitle: "collected research methods"
    }))).toBeUndefined();
  });

  it("matches an unnumbered ICML-style reference from the extracted metadata", async () => {
    const matcher = await indexed([{
      id: 1,
      title: "SLIC Superpixels Compared to State-of-the-Art Superpixel Methods",
      author: "Achanta",
      year: 2012,
      itemType: "journalArticle"
    }]);
    const parsed = new CitationParser().parse({
      raw: "Achanta, R., Shaji, A., Smith, K., Lucchi, A., Fua, P., and Süsstrunk, S. Slic superpixels compared to state-of-the-art superpixel methods. IEEE Transactions on Pattern Analysis and Machine Intelligence, 34(11):2274–2282, 2012.",
      fragments: []
    });
    expect(matcher.match(parsed)?.record.item.id).toBe(1);
  });

  it("matches a complete title when PDF line wrapping changes a word boundary", async () => {
    const matcher = await indexed([{
      id: 1,
      title: "SLIC Superpixels Compared to State-of-the-Art Superpixel Methods",
      author: "Achanta",
      year: 2012,
      itemType: "journalArticle"
    }]);
    expect(matcher.match(citation(
      "Slic superpixels compared to state-of-theart superpixel methods",
      { firstAuthor: "achanta", year: 2012 }
    ))?.record.item.id).toBe(1);
  });

  it.each([
    {
      domain: "astronomy",
      raw: "Krumholz, M. R., & Thompson, T. A. 2007, ApJ, 669, 289",
      item: { id: 10, title: "The Relationship Between Molecular Gas Tracers and Kennicutt-Schmidt Laws", author: "Krumholz", year: 2007, publicationTitle: "The Astrophysical Journal", volume: "669", pages: "289-298" }
    },
    {
      domain: "physics",
      raw: "[1] A. Einstein, Ann. Phys. 17, 891 (1905).",
      item: { id: 11, title: "On the Movement of Small Particles Suspended in Stationary Liquids Required by the Molecular-Kinetic Theory of Heat", author: "Einstein", year: 1905, publicationTitle: "Annalen der Physik", volume: "17", pages: "891-921" }
    }
  ])("connects a title-less $domain citation by bibliographic fingerprint", async ({ raw, item }) => {
    const matcher = await indexed([item]);
    const result = matcher.match(new CitationParser().parse({ raw, fragments: [] }));
    expect(result?.method).toBe("bibliographic");
    expect(result?.record.item.id).toBe(item.id);
  });

  it.each([
    {
      domain: "mathematics",
      raw: "[2] T. Tao, A quantitative ergodic theory proof of Szemeredi's theorem, Electron. J. Combin. 13 (2006), R99.",
      item: { id: 12, title: "A Quantitative Ergodic Theory Proof of Szemeredi's Theorem", author: "Tao", year: 2006 }
    },
    {
      domain: "biomedicine",
      raw: "Smith JA, Doe B. Biomarkers improve early disease detection in adults. J Med. 2020;12(3):100-110.",
      item: { id: 13, title: "Biomarkers Improve Early Disease Detection in Adults", author: "Smith", year: 2020 }
    }
  ])("connects a title-bearing $domain citation", async ({ raw, item }) => {
    const matcher = await indexed([item]);
    expect(matcher.match(new CitationParser().parse({ raw, fragments: [] }))?.record.item.id).toBe(item.id);
  });

  it("rejects an author-year candidate whose volume conflicts", async () => {
    const matcher = await indexed([{
      id: 14,
      title: "Wrong Paper",
      author: "Krumholz",
      year: 2007,
      publicationTitle: "The Astrophysical Journal",
      volume: "670",
      pages: "289"
    }]);
    const parsed = new CitationParser().parse({ raw: "Krumholz, M. R., & Thompson, T. A. 2007, ApJ, 669, 289", fragments: [] });
    expect(matcher.match(parsed)).toBeUndefined();
  });
});

describe("LibraryMatcher: versions and parse errors", () => {
  const parse = (raw: string) => new CitationParser().parse({ raw, fragments: [] });
  const alexnet = "A. Krizhevsky, I. Sutskever, and G. Hinton, \"Imagenet classification with deep convolutional neural networks,\" in Proc. Advances in Neural Information Processing Systems, 2012, pp. 1097–1105.";

  it("matches another version of the same work: same title and first author, other year", async () => {
    const matcher = await indexed([{ id: 1, title: "ImageNet classification with deep convolutional neural networks", author: "Krizhevsky", year: 2017 }]);
    expect(matcher.match(parse(alexnet))?.record.item.id).toBe(1);
  });

  it("keeps rejecting another year when the first author differs", async () => {
    const matcher = await indexed([{ id: 1, title: "ImageNet classification with deep convolutional neural networks", author: "Someone", year: 2017 }]);
    expect(matcher.match(parse(alexnet))).toBeUndefined();
  });

  it("dates an arXiv preprint also by its ID", async () => {
    const matcher = await indexed([{ id: 1, title: "Attention mechanisms are all you need for sequence transduction models", author: "Vaswani", year: 2023, arxiv: "1706.03762" }]);
    // a fuzzy title would reject 2017 vs 2023; the arXiv ID says 2017
    const result = matcher.match(citation("Attention mechanisms were all you need for sequence transduction models", { firstAuthor: "vaswani", year: 2017 }));
    expect(result?.record.item.id).toBe(1);
  });

  it("accepts the surname from the raw text when the parsed first author is wrong", async () => {
    const matcher = await indexed([{ id: 1, title: "Aggregated Residual Transformations for Deep Neural Networks", author: "Xie", year: 2017 }]);
    const parsed = parse("SainingXie, RossGirshick, Piotr Dollár, ZhuowenTu, and Kaiming He. Aggregated residual transformations for deep neural networks. In CVPR, 2017.");
    expect(matcher.match(parsed)?.record.item.id).toBe(1);
  });

  it("finds a library title inside a reference whose title was not parsed", async () => {
    const matcher = await indexed([{ id: 1, title: "YOLO9000: Better, Faster, Stronger", author: "Redmon", year: 2016 }]);
    const parsed = parse("Redmon, J.; Farhadi, A. YOLO9000: Better, Faster, Stronger. In Proceedings of the 30th IEEE Conference on Computer Vision and Pattern Recognition, Honolulu, HI, USA, 21–26 July 2017; pp. 6517–6525.");
    const result = matcher.match(parsed);
    expect(result?.record.item.id).toBe(1);
  });

  it("takes the longest contained title: DeepSORT, not SORT", async () => {
    const matcher = await indexed([
      { id: 1, title: "Simple Online and Realtime Tracking", author: "Wojke", year: 2016 },
      { id: 2, title: "Simple Online and Realtime Tracking with a Deep Association Metric", author: "Wojke", year: 2017 }
    ]);
    const parsed = parse("N. Wojke , A. Bewley , D. Paulus , Simple online and realtime tracking with a deep association metric, in: Proceedings of the 2017 IEEE International Conference on Image Processing (ICIP), IEEE, 2017, pp. 3645–3649.");
    expect(matcher.match(parsed)?.record.item.id).toBe(2);
  });

  it("matches a two-word title only with author and year", async () => {
    const matcher = await indexed([{ id: 1, title: "Network In Network", author: "Lin", year: 2014 }]);
    expect(matcher.match(parse("M. Lin, Q. Chen, and S. Yan. Network in network. In ICLR, 2014."))?.record.item.id).toBe(1);
    expect(matcher.match(parse("M. Lin, Q. Chen, and S. Yan. Network in network. In ICLR, 2019."))).toBeUndefined();
  });

  it("picks one of two versions of a work instead of calling it ambiguous", async () => {
    const matcher = await indexed([
      { id: 1, title: "You Only Look Once: Unified, Real-Time Object Detection", author: "Redmon", year: 2016, doi: "10.48550/arXiv.1506.02640", pdf: true },
      { id: 2, title: "You Only Look Once: Unified, Real-Time Object Detection", author: "Redmon", year: 2016, doi: "10.1109/cvpr.2016.91" }
    ]);
    const outcome = matcher.matchWithOutcome(parse("J. Redmon, S. Divvala, R. Girshick, and A. Farhadi, \"You only look once: Unified, real-time object detection,\" in Proc. CVPR, 2016, pp. 779–788."));
    expect(outcome.ambiguous).toBe(false);
    expect([1, 2]).toContain(outcome.match?.record.item.id);
  });

  it("does not link a longer title by another author to a contained library title", async () => {
    const matcher = await indexed([{ id: 1, title: "Generative Adversarial Networks", author: "Goodfellow", year: 2014 }]);
    expect(matcher.match(parse("A. Creswell, T. White, V. Dumoulin, K. Arulkumaran, B. Sengupta, and A. A. Bharath, \"Generative adversarial networks: An overview,\" IEEE Signal Process. Mag., vol. 35, no. 1, pp. 53–65, 2018."))).toBeUndefined();
    expect(matcher.match(parse("J. Li, X. Liang, Y. Wei, T. Xu, J. Feng, and S. Yan, \"Perceptual generative adversarial networks for small object detection,\" in Proc. CVPR, 2017, pp. 1222–1230."))).toBeUndefined();
    expect(matcher.match(parse("I. Goodfellow, \"Generative adversarial networks: An overview of my own work,\" 2018."))).toBeUndefined();
  });

  it("does not take a book for the same author's survey that adds a subtitle", async () => {
    const matcher = await indexed([{ id: 1, title: "Efficient Processing of Deep Neural Networks", author: "Sze", year: 2020, itemType: "book" }]);
    expect(matcher.match(parse("Vivienne Sze, Yu-Hsin Chen, Tien-Ju Yang, and Joel S. Emer. 2017. Efficient Processing of Deep Neural Networks: A Tutorial and Survey. Proc. IEEE 105, 12 (2017), 2295-2329."))).toBeUndefined();
  });
});
