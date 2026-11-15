// Wocher et al. 2022 (ISPRS J. Photogramm. Remote Sens.): Elsevier's short reference style without titles, two
// columns with hanging indents, DOI links wrapped over two lines, and organisations as authors.
import { describe, expect, it } from "vitest";
import { CitationParser } from "../src/core/CitationParser";
import { PdfSectionExtractor, type PdfDocument } from "../src/core/PdfSectionExtractor";
import { referenceSearchTexts } from "../src/reader/ReferenceOverlay";

const parser = new CitationParser();
const parse = (raw: string) => parser.parse({ raw, fragments: [] });

type Line = [text: string, x: number, y: number];
type Link = { url: string; rect: number[] };

function positionedPdf(lines: Line[], links: Link[] = []): PdfDocument {
  return {
    numPages: 1,
    async getPage() {
      return {
        async getTextContent() {
          return { items: lines.map(([str, x, y]) => ({ str, hasEOL: true, transform: [1, 0, 0, 1, x, y] })) };
        },
        async getAnnotations() {
          return links.map(link => ({ subtype: "Link", ...link }));
        }
      };
    }
  };
}

describe("Elsevier short references without a title", () => {
  it.each([
    ["Candiani, G., Tagliabue, G., Panigada, C., Verrelst, J., Picchi, V., Rivera Caicedo, J.P., Boschetti, M., 2022. Remote Sens. 14 (8), 1792. http://dx.doi.org/10.3390/rs14081792.",
      "Remote Sens", "14", "8", "1792"],
    ["Danner, M., Berger, K., Wocher, M., Mauser, W., Hank, T., 2021. ISPRS J. Photogramm. Remote Sens. 173, 278–296. http://dx.doi.org/10.1016/j.isprsjprs.2021.01.017.",
      "ISPRS J. Photogramm. Remote Sens", "173", undefined, "278–296"],
    ["Jolliffe, I.T., Cadima, J., 2016. Philos. Trans. Royal Soc. A 374 (2065), 20150202. http://dx.doi.org/10.1098/rsta.2015.0202.",
      "Philos. Trans. Royal Soc. A", "374", "2065", "20150202"],
    ["Glenn, E.P., Huete, A.R., Nagler, P.L., Nelson, S.G., 2008. Sensors (Basel). 8 (4), 2136–2160. http://dx.doi.org/10.3390/s8042136, arXiv:27879814.",
      "Sensors (Basel)", "8", "4", "2136–2160"],
    ["Welker, C.M., Balasubramanian, V.K., Petti, C., Rai, K.M., DeBolt, S., Mendu, V., 2015. Energies 8 (8), 7654–7676. http://dx.doi.org/10.3390/en8087654.",
      "Energies", "8", "8", "7654–7676"],
    ["Kumar, T.K., 1975. Rev. Econ. Stat. 57 (3), 365–366, URL https://www.jstor.org/stable/1923925.",
      "Rev. Econ. Stat", "57", "3", "365–366"],
    ["Verrelst, J., Berger, K., Rivera-Caicedo, J.P., 2020. IEEE Geosci. Remote Sens. Lett. 1–5. http://dx.doi.org/10.1109/LGRS.2020.3014676.",
      "IEEE Geosci. Remote Sens. Lett", undefined, undefined, "1–5"],
    ["Zhou, K., Cheng, T., Zhu, Y., Cao, W., Ustin, S.L., Zheng, H., Yao, X., Tian, Y., 2018. Front. Plant Sci. 9, http://dx.doi.org/10.3389/fpls.2018.00964.",
      "Front. Plant Sci", "9", undefined, undefined],
    ["Paustian, K., Larson, E., Kent, J., Marx, E., Swan, A., 2019. Front. Clim. http://dx.doi.org/10.3389/fclim.2019.00008.",
      "Front. Clim", undefined, undefined, undefined],
    ["Douak, F., Melgani, F., Benoudjit, N., 2013. Appl. Energy 103, 328–340. http://dx.doi.org/10.1016/j.apenergy.2012.09.055.",
      "Appl. Energy", "103", undefined, "328–340"],
    ["Mateo-Sanchis, A., Piles, M., Adsuara, J.E., MorenoMartínez, á., Camps-Valls, G., 2021. Int. J. Appl. Earth Obs. Geoinf. 104, 102574. http://dx.doi.org/10.1016/j.jag.2021.102574.",
      "Int. J. Appl. Earth Obs. Geoinf", "104", undefined, "102574"]
  ])("reads the journal, not a title: %s", (raw, containerTitle, volume, issue, pages) => {
    const result = parse(raw);
    expect(result.title).toBeUndefined();
    expect(result.containerTitle).toBe(containerTitle);
    expect(result.volume).toBe(volume);
    expect(result.issue).toBe(issue);
    expect(result.pages).toBe(pages);
  });

  it("keeps the title of a full Elsevier reference", () => {
    expect(parse("LeCun, Y., Bengio, Y., Hinton, G., 2015. Deep learning. Nature 521, 436–444.").title).toBe("Deep learning");
    // a title-case title is no journal abbreviation either (its title is still parsed wrongly, as before)
    expect(parse("LeCun, Y., Bengio, Y., Hinton, G., 2015. Deep Learning. Nature 521, 436–444.").containerTitle ?? "").not.toContain("Deep Learning");
    expect(parse("Meier, U., 2018. Growth stages of mono- and dicotyledonous plants: BBCH monograph. http://dx.doi.org/10.5073/20180906-074619.").title)
      .toBe("Growth stages of mono- and dicotyledonous plants: BBCH monograph");
    expect(parse("Fikes, A., 2010. Storage Architecture and Challenges. http://goo.gl/pF6kmz (accessed June 30, 2016).").title)
      .toBe("Storage Architecture and Challenges");
    // only an Elsevier author list before the year: not a title, initials first or a full name
    expect(parse("3. CULBERTSON, J. T. Some uneconomical robots. In C. E. Shannon & J. McCarthy (Eds.), Automata studies. Princeton: Princeton Univer. Press, 1956. Pp. 99-116.").containerTitle).not.toBe("Pp");
    expect(parse("Linda, O, Vollmer, T, and Manic, M. Neural network based intrusion detection system for critical infrastructures. In Neural Networks, 2009. IJCNN 2009. International Joint Conference on . IEEE, 2009.").title)
      .toBe("Neural network based intrusion detection system for critical infrastructures");
    expect(parse("[29] Z. Jin, C. Lin, C. Weigl, J. Obarowski, and D. Hale. 2021. Smallholder Cashew Plantations in Benin. https://doi.org/10.34911/rdnt.hfv20i Radiant MLHub.").title)
      .toBe("Smallholder Cashew Plantations in Benin");
    expect(parse("[60] Timu Sumisu. 2019. Canadian Building Footprints. https://github.com/microsoft/ CanadianBuildingFootprints").title)
      .toBe("Canadian Building Footprints");
    expect(parse("Rasmussen, C., Williams, C., 2006. Gaussian Processes for Machine Learning. In: Adaptive Computation and Machine Learning, MIT Press, Cambridge, MA, USA, p. 248.").title)
      .toBe("Gaussian Processes for Machine Learning");
  });
});

describe("DOIs broken at a line end", () => {
  it("prefers the full DOI from the link over the cut visible one", () => {
    const raw = "Berger, K., Verrelst, J., 2020. Int. J. Appl. Earth Obs. Geoinf. 92, 102174. http://dx.doi.org/10.1016/j.jag. doi:10.1016/j.jag.2020.102174 2020.102174.";
    expect(parse(raw).doi).toBe("10.1016/j.jag.2020.102174");
  });

  it("joins the visible parts when there is no link", () => {
    expect(parse("Lázaro-Gredilla, M., Titsias, M.K., 2013. IEEE Geosci. Remote Sens. Lett. 11 (4), 838–842. http://dx.doi.org/10.1109/LGRS.2013. 2279695.").doi)
      .toBe("10.1109/lgrs.2013.2279695");
    expect(parse("Candiani, G., Tagliabue, G., 2022. Remote Sens. 14 (8), 1792. http://dx.doi.org/10.3390/ rs14081792.").doi)
      .toBe("10.3390/rs14081792");
  });

  it("does not join a following year, link token, URL or page number", () => {
    expect(parse("Berger, K., 2018a. Remote Sens. 10 (1), 85. http://dx.doi.org/10.3390/rs10010085. 112 M. Wocher et al.").doi).toBe("10.3390/rs10010085");
    expect(parse("Smith, J., 2019. A title of a paper. Journal 3, 1–2. doi:10.1000/xyz. 2020. Reprinted.").doi).toBe("10.1000/xyz");
    expect(parse("Smith, J., 2019. A title of a paper. Journal 3, 1–2. doi:10.1000/xyz. http://example.org/a").doi).toBe("10.1000/xyz");
    expect(parse("[34] L. Mou, “Unsupervised feature learning,” IEEE Trans. Geosci. Remote Sens. doi:10.1109/ december 2017 ieee Geoscience").doi).toBeUndefined();
  });
});

describe("two-column reference pages", () => {
  // positions from the PDF: columns at x 37.6 and 306.6, hanging indent 12 pt
  const lines: Line[] = [
    ["References", 37.6, 160],
    ["Guanter, L., Kaufmann, H., Segl, K., 2015. Remote Sens. 7 (7), 8830.", 37.6, 150],
    ["http://dx.doi.org/10.3390/rs70708830.", 49.5, 141.4],
    ["Hank, T.B., Berger, K., Bach, H., Clevers, J.G.P.W., Gitelson, A., Zarco-Tejada, P.,", 37.6, 113.0],
    ["Mauser, W., 2019. Surv. Geophys. 40 (3), 515–551. http://dx.doi.org/10.1007/", 49.5, 104.4],
    ["s10712-018-9492-0.", 49.5, 95.8],
    ["Hank, T., Berger, K., Wocher, M., Danner, M., Mauser, W., 2021. Remote Sens. 9, 4.", 37.6, 87.5],
    ["Svendsen, D.H., Morales-álvarez, P., Ruescas, A.B., 2020. ISPRS J. Photogramm.", 306.6, 150],
    ["Remote Sens. 166, 68–81.", 318.6, 141.4],
    ["Tagliabue, G., Boschetti, M., Bramati, G., Candiani, G., Colombo, R., Nutini, F.,", 306.6, 131.7],
    ["Pompilio, L., Rivera-Caicedo, J.P., Rossi, M., Rossini, M., Verrelst, J., Panigada, C.,", 318.6, 123.1],
    ["2022. ISPRS J. Photogramm. Remote Sens. 187, 362–377. http://dx.doi.org/10.", 318.6, 114.5],
    ["1016/j.isprsjprs.2022.03.014.", 318.6, 106.0],
    ["Upreti, D., Huang, W., Kong, W., 2019. Remote Sens. 11 (5), 481.", 306.6, 97.0]
  ];
  // a link wrapped over two lines: its end of the first line, a zero-width rect at the column edge, the second line
  const wrapped = (url: string, firstEnd: number[], edge: number[], second: number[]) =>
    [firstEnd, edge, second].map(rect => ({ url, rect }));
  const links = [
    ...wrapped("http://dx.doi.org/10.1007/s10712-018-9492-0", [210.8, 103.0, 288.7, 108.9], [37.6, 103.0, 37.6, 104.4], [49.5, 94.3, 106.4, 100.4]),
    ...wrapped("http://dx.doi.org/10.1016/j.isprsjprs.2022.03.014", [497.3, 113.1, 557.7, 119.0], [306.6, 113.1, 306.6, 114.5], [318.6, 104.5, 400.9, 110.5])
  ];

  it("appends a wrapped link's DOI to its own reference, not to the one beside it", async () => {
    const section = await new PdfSectionExtractor().extract(positionedPdf(lines, links));
    const byAuthor = (name: string) => section!.references.find(reference => reference.raw.startsWith(name))!;
    expect(section!.references.map(reference => reference.raw.slice(0, 10))).toEqual([
      "Guanter, L", "Hank, T.B.", "Hank, T., ", "Svendsen, ", "Tagliabue,", "Upreti, D."
    ]);
    expect(byAuthor("Hank, T.B.").raw).not.toContain("isprsjprs");
    expect(parse(byAuthor("Hank, T.B.").raw).doi).toBe("10.1007/s10712-018-9492-0");
    expect(parse(byAuthor("Tagliabue").raw).doi).toBe("10.1016/j.isprsjprs.2022.03.014");
  });
});

describe("organisations as authors", () => {
  it("start a new reference on an unindented line when the list uses hanging indents", async () => {
    const section = await new PdfSectionExtractor().extract(positionedPdf([
      ["References", 37.6, 300],
      ["Fang, P., Yan, N., 2021. Remote Sens. 13 (14), 2755.", 37.6, 290],
      ["http://dx.doi.org/10.3390/rs13142755.", 49.5, 281],
      ["FAO, 2022. Land use in agriculture by the numbers. URL https://www.fao.org/", 37.6, 272],
      ["sustainability/news/detail/en/c/1274219.", 49.5, 263],
      ["National Academies of Sciences, E., 2018. Thriving on Our Changing Planet. National", 37.6, 254],
      ["Academies Press.", 49.5, 245],
      ["Settles, B., 2009. Active Learning Literature Survey. University of Wisconsin.", 37.6, 236],
      ["GCOS | WMO, 2022. Above-ground biomass - essential climate variable.", 37.6, 227]
    ]));
    expect(section!.references.map(reference => reference.raw.slice(0, 12))).toEqual([
      "Fang, P., Ya", "FAO, 2022. L", "National Aca", "Settles, B.,", "GCOS | WMO, "
    ]);
  });

  it("do not split a list without hanging indents", async () => {
    const section = await new PdfSectionExtractor().extract(positionedPdf([
      ["References", 72, 300],
      ["Smith, J., 2019. A paper on things that happen. Remote", 72, 290],
      ["Sensing Letters, 2019. 12, 1–5.", 72, 281],
      ["Zed, K., 2020. Another paper title here. Journal 3, 4–5.", 72, 272]
    ]));
    expect(section!.references).toHaveLength(2);
  });
});

describe("referenceSearchTexts", () => {
  it("searches the title first", () => {
    const raw = "Meier, U., 2018. Growth stages of plants: BBCH monograph. http://dx.doi.org/10.5073/20180906-074619.";
    expect(referenceSearchTexts(raw, parse(raw))[0]).toBe("Growth stages of plants: BBCH monograph");
  });

  it("searches the reference up to its link, then authors and year, when there is no title", () => {
    const raw = "Candiani, G., Tagliabue, G., Boschetti, M., 2022. Remote Sens. 14 (8), 1792. http://dx.doi.org/10.3390/ doi:10.3390/rs14081792 rs14081792.";
    expect(referenceSearchTexts(raw, parse(raw))).toEqual([
      "Candiani, G., Tagliabue, G., Boschetti, M., 2022. Remote Sens. 14 (8), 1792.",
      "Candiani, G., Tagliabue, G., Boschetti, M., 2022"
    ]);
  });

  it("drops identifiers appended from links", () => {
    const raw = "Hank, T.B., Berger, K., Bach, H., doi:10.1016/j.isprsjprs.2022.03.014 Mauser, W., 2019. Surv. Geophys. 40 (3), 515–551.";
    expect(referenceSearchTexts(raw, parse(raw))[0]).toBe("Hank, T.B., Berger, K., Bach, H., Mauser, W., 2019. Surv. Geophys. 40 (3), 515–551.");
  });
});
