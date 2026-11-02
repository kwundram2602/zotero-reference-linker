import { CitationParser } from "../core/CitationParser";
import { LibraryMatcher } from "../core/LibraryMatcher";
import { PdfSectionExtractor, type PdfDocument } from "../core/PdfSectionExtractor";
import type { MatchOutcome, MatchResult, ParsedCitation, ReferenceSection, ScanResult } from "../core/types";
import { ReferenceOverlay, type UnmatchedReferenceAction } from "./ReferenceOverlay";

/** Extra menu actions for an unmatched reference, given by the host plugin (setUnmatchedActions). */
export type UnmatchedActionProvider = (
  citation: ParsedCitation,
  context: { reader: ZoteroReader; attachment: ZoteroItem }
) => UnmatchedReferenceAction[];

interface ReaderState {
  outerObserver?: MutationObserver;
  viewerObserver?: MutationObserver;
  viewerDocument?: Document;
  overlay?: ReferenceOverlay;
  overlayDocument?: Document;
  timer?: number;
  scanning: boolean;
  fingerprint?: string;
  lastMatched?: number;
  summary?: HTMLElement;
  summaryTimer?: number;
  sectionPromise?: Promise<ReferenceSection | undefined>;
  unloadHandler?: () => void;
  result?: ScanResult;
}

export class ReaderIntegration {
  private readonly states = new WeakMap<ZoteroReader, ReaderState>();
  private readonly readers = new Set<ZoteroReader>();
  private readonly parser = new CitationParser();
  private readonly sectionExtractor = new PdfSectionExtractor();
  private readonly matcherCache = new Map<number, Promise<LibraryMatcher>>();
  private toolbarHandler = (event: ReaderEvent) => this.onToolbar(event);
  private notifierID?: string;
  private actionProvider?: UnmatchedActionProvider;

  constructor(private readonly zotero: ZoteroAPI, private readonly pluginID: string) {}

  start(): void {
    this.zotero.Reader.registerEventListener("renderToolbar", this.toolbarHandler, this.pluginID);
    this.notifierID = this.zotero.Notifier?.registerObserver(
      { notify: (event, _type, ids) => this.onItemsChanged(event, ids) },
      ["item"],
      "referenceLinker"
    );
  }

  stop(): void {
    this.zotero.Reader.unregisterEventListener("renderToolbar", this.toolbarHandler);
    if (this.notifierID) this.zotero.Notifier?.unregisterObserver(this.notifierID);
    this.notifierID = undefined;
    this.matcherCache.clear();
    for (const reader of this.readers) this.destroyReader(reader);
    this.readers.clear();
  }

  /** Let the host plugin add actions to the menu of unmatched references (e.g. "Add to Zotero"). */
  setUnmatchedActions(provider?: UnmatchedActionProvider): void {
    this.actionProvider = provider;
  }

  /** The references of the open PDF as last scanned; `rescan` scans first (e.g. after items were added). */
  async scanResult(reader: ZoteroReader, rescan = false): Promise<ScanResult | undefined> {
    const state = this.states.get(reader);
    if (!state) return undefined;
    if (rescan || !state.result) await this.scan(reader, true, true);
    return state.result;
  }

  /**
   * The library index is built once per library; items added, edited, trashed or deleted (or an attachment
   * relinked) afterwards would never be matched. Drop the indexes and rescan the open readers. Notes and
   * annotations (e.g. highlighting while reading) do not change what can be matched and are ignored.
   */
  private onItemsChanged(event: string, ids: Array<number | string>): void {
    const relevant = event === "delete" || ids.some(id => {
      const item = typeof id === "number" ? this.zotero.Items.get(id) : false;
      return item && (item.isRegularItem() || item.isAttachment());
    });
    if (!relevant) return;
    this.matcherCache.clear();
    for (const reader of this.readers) {
      const state = this.states.get(reader);
      if (state) state.fingerprint = undefined;
      this.scheduleScan(reader, 2000);
    }
  }

  private onToolbar({ reader, doc, append }: ReaderEvent): void {
    if (!doc || !append) return;
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "toolbar-button";
    button.title = "Scan References and link items in your library";
    button.setAttribute("aria-label", "Link library references");
    button.textContent = "Ref ↗";
    this.installToolbarStyle(doc);
    button.addEventListener("click", async () => {
      const original = button.textContent;
      button.textContent = "Scanning…";
      button.disabled = true;
      try {
        await this.scan(reader, true, true);
      } catch (error) {
        this.zotero.logError(error);
        button.title = error instanceof Error ? error.message : String(error);
      } finally {
        button.textContent = original;
        button.disabled = false;
      }
    });
    append(button);
    const summary = this.createSummary(doc, button);
    (doc.body || doc.documentElement).append(summary);
    const state = this.states.get(reader) || { scanning: false };
    if (state.summaryTimer) state.summary?.ownerDocument.defaultView?.clearTimeout(state.summaryTimer);
    state.summary?.remove();
    state.summary = summary;
    state.summaryTimer = undefined;
    this.states.set(reader, state);
    this.attach(reader);
  }

  private attach(reader: ZoteroReader): void {
    this.readers.add(reader);
    const state = this.states.get(reader) || { scanning: false };
    this.states.set(reader, state);
    const win = reader._iframeWindow;
    if (!win?.document?.documentElement || state.outerObserver) return;
    const Observer = (win as Window & { MutationObserver: typeof MutationObserver }).MutationObserver;
    const observer = new Observer(() => {
      const viewer = this.getViewerDocument(reader);
      if (viewer && viewer !== state.viewerDocument) {
        this.observeViewer(reader, viewer);
        this.scheduleScan(reader);
      }
    });
    observer.observe(win.document.documentElement, { childList: true, subtree: true });
    state.outerObserver = observer;
    if (!state.unloadHandler) {
      state.unloadHandler = () => {
        this.destroyReader(reader);
        this.readers.delete(reader);
      };
      win.addEventListener("unload", state.unloadHandler, { once: true });
    }
    this.scheduleScan(reader, 1200);
  }

  private scheduleScan(reader: ZoteroReader, delay = 500): void {
    const state = this.states.get(reader);
    const win = reader._iframeWindow;
    if (!state || !win) return;
    if (state.timer) win.clearTimeout(state.timer);
    state.timer = win.setTimeout(() => void this.scan(reader, false), delay);
  }

  private async scan(reader: ZoteroReader, reportEmpty: boolean, force = false): Promise<number | undefined> {
    const state = this.states.get(reader);
    const doc = this.getViewerDocument(reader);
    if (!state || !doc || state.scanning) return undefined;
    this.observeViewer(reader, doc);
    const fingerprint = this.pageFingerprint(doc);
    if (!force && state.fingerprint === fingerprint) return state.lastMatched;
    state.fingerprint = fingerprint;
    state.scanning = true;
    try {
      const section = await this.getReferenceSection(reader, state);
      if (!section) {
        if (reportEmpty) this.zotero.debug("Reference Linker: no rendered References section found. Scroll to the references pages and retry.");
        return undefined;
      }
      const attachment = this.getAttachment(reader);
      if (!attachment) return undefined;
      const currentItemID = typeof attachment.parentID === "number" ? attachment.parentID : undefined;
      const matchers = await this.getMatchers(attachment.libraryID);
      const internal = this.zotero.Utilities?.Internal;
      if (!state.overlay || state.overlayDocument !== doc) {
        state.overlay?.destroy();
        state.overlay = new ReferenceOverlay(
          doc,
          match => void this.open(match.record.item.id, match.record.pdfAttachmentID),
          url => this.zotero.launchURL(url),
          // the reader iframe's navigator.clipboard is not reliably available; Zotero's helper always is
          internal ? text => internal.copyTextToClipboard(text) : undefined
        );
        state.overlayDocument = doc;
      }
      const provider = this.actionProvider;
      state.overlay.setExtraActions(provider ? citation => provider(citation, { reader, attachment }) : undefined);
      const result: ScanResult = { libraryID: attachment.libraryID, itemID: currentItemID, matched: [], unmatched: [] };
      state.overlay.clear();
      state.overlay.indexPages(section.startPage, section.endPage, section.startHeading, section.endHeading);
      let matchedItems = 0;
      let ambiguousItems = 0;
      let unmatchedItems = 0;
      for (const [position, reference] of section.references.entries()) {
        const citation = this.parser.parse(reference);
        const { outcome, matcher } = this.matchAcross(matchers, citation);
        const found = outcome.match;
        const referenceKey = reference.index == null ? `reference:${position}` : `index:${reference.index}`;
        if (!found || !matcher) {
          if (outcome.ambiguous) ambiguousItems++;
          else unmatchedItems++;
          result.unmatched.push({ index: reference.index, citation, ambiguous: outcome.ambiguous });
          if (reference.index != null) {
            state.overlay.renderIndexedUnmatched(reference.index, citation, referenceKey);
          } else {
            state.overlay.renderTitleUnmatched(citation.title || reference.raw, citation, referenceKey);
          }
          continue;
        }
        matchedItems++;
        if (found.record.item.id === currentItemID) continue;
        const match = await this.displayedMatch(found, matcher, attachment.libraryID);
        result.matched.push({ index: reference.index, citation, match });
        reference.index != null
          ? state.overlay.renderIndexed(reference.index, match, referenceKey)
          : state.overlay.renderTitle(citation.title || reference.raw, match, referenceKey);
      }
      const linked = state.overlay.linkCount();
      this.updateSummary(state, {
        scanned: section.references.length,
        matched: matchedItems,
        ambiguous: ambiguousItems,
        unmatched: unmatchedItems
      });
      this.zotero.debug(`Reference Linker: ${linked} links rendered; ${matchedItems} library items matched; source=${section.source}`);
      state.lastMatched = linked;
      state.result = result;
      return linked;
    } catch (error) {
      this.zotero.logError(error);
      throw error;
    } finally {
      state.scanning = false;
    }
  }

  private getReferenceSection(reader: ZoteroReader, state: ReaderState): Promise<ReferenceSection | undefined> {
    if (!state.sectionPromise) {
      const pdf = this.getPdfDocument(reader);
      if (!pdf) return Promise.resolve(undefined);
      state.sectionPromise = this.sectionExtractor.extract(pdf);
      state.sectionPromise.catch(() => { state.sectionPromise = undefined; });
    }
    return state.sectionPromise;
  }

  private installToolbarStyle(doc: Document): void {
    if (doc.getElementById("reference-linker-toolbar-style")) return;
    const style = doc.createElement("style");
    style.id = "reference-linker-toolbar-style";
    style.textContent = `
      .reference-linker-summary {
        position: fixed; right: 0; z-index: 1000; display: none; min-width: 128px;
        box-sizing: border-box; padding: 8px 10px; border-radius: 6px;
        background: rgba(24, 119, 242, .5); color: white;
        font: 600 12px/1.55 system-ui, sans-serif; white-space: pre;
        pointer-events: none; box-shadow: 0 2px 8px rgba(0, 0, 0, .18);
      }
    `;
    (doc.head || doc.documentElement).append(style);
  }

  private createSummary(doc: Document, button: HTMLElement): HTMLElement {
    const summary = doc.createElement("div");
    summary.className = "reference-linker-summary";
    summary.setAttribute("role", "status");
    summary.setAttribute("aria-live", "polite");
    const position = () => {
      const rect = button.getBoundingClientRect();
      summary.style.top = `${rect.bottom + 6}px`;
      summary.style.right = "0";
    };
    position();
    return summary;
  }

  private updateSummary(state: ReaderState, counts: { scanned: number; matched: number; ambiguous: number; unmatched: number }): void {
    if (!state.summary) return;
    state.summary.textContent = `scanned : ${counts.scanned}\nmatched : ${counts.matched}\nambiguous : ${counts.ambiguous}\nunmatched : ${counts.unmatched}`;
    state.summary.style.display = "block";
    const summary = state.summary;
    const win = summary.ownerDocument.defaultView;
    if (!win) return;
    if (state.summaryTimer) win.clearTimeout(state.summaryTimer);
    state.summaryTimer = win.setTimeout(() => {
      if (state.summary === summary) summary.style.display = "none";
      state.summaryTimer = undefined;
    }, 30_000);
  }

  private pageFingerprint(doc: Document): string {
    return Array.from(doc.querySelectorAll<HTMLElement>(".page")).map(page => {
      const spans = page.querySelectorAll<HTMLElement>(".textLayer span");
      const first = spans.item(0)?.textContent || "";
      const last = spans.item(spans.length - 1)?.textContent || "";
      return `${page.dataset.pageNumber || "?"}:${spans.length}:${first}:${last}`;
    }).join("|");
  }

  private getPdfDocument(reader: ZoteroReader): PdfDocument | undefined {
    const internal = (reader as ZoteroReader & {
      _internalReader?: { _primaryView?: { _iframeWindow?: Window & { PDFViewerApplication?: { pdfDocument?: PdfDocument } } } };
    })._internalReader;
    return internal?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfDocument;
  }

  /**
   * Matchers for the reader's own library first, then every other (group) library; feeds are skipped. A library
   * that fails to index is left out rather than failing the scan.
   */
  private async getMatchers(libraryID: number): Promise<LibraryMatcher[]> {
    const others = (this.zotero.Libraries?.getAll() || [])
      .filter(library => library.libraryID !== libraryID && library.libraryType !== "feed")
      .map(library => library.libraryID);
    const own = await this.getMatcher(libraryID);
    const settled = await Promise.allSettled(others.map(id => this.getMatcher(id)));
    return [own, ...settled.flatMap(result => result.status === "fulfilled" ? [result.value] : [])];
  }

  /**
   * The first library with a match wins. An ambiguous result also stops the search: if the reader's own library
   * cannot decide, a single hit in some group library is no better evidence.
   */
  private matchAcross(matchers: LibraryMatcher[], citation: ParsedCitation): { outcome: MatchOutcome; matcher?: LibraryMatcher } {
    for (const matcher of matchers) {
      const outcome = matcher.matchWithOutcome(citation);
      if (outcome.match || outcome.ambiguous) return { outcome, matcher };
    }
    return { outcome: { ambiguous: false } };
  }

  /** The match as shown: "↗ PDF" only if a PDF file exists, the library named if it is another one. */
  private async displayedMatch(match: MatchResult, matcher: LibraryMatcher, ownLibraryID: number): Promise<MatchResult> {
    const pdfAttachmentID = await matcher.availablePdf(match.record);
    const libraryID = match.record.item.libraryID;
    const library = libraryID !== ownLibraryID ? this.zotero.Libraries?.get(libraryID) : undefined;
    const title = library ? `${match.record.title}\n(in ${library.name})` : match.record.title;
    return { ...match, record: { ...match.record, pdfAttachmentID, title } };
  }

  private getMatcher(libraryID: number): Promise<LibraryMatcher> {
    let pending = this.matcherCache.get(libraryID);
    if (!pending) {
      pending = (async () => {
        const matcher = new LibraryMatcher(this.zotero);
        await matcher.index(libraryID);
        return matcher;
      })();
      this.matcherCache.set(libraryID, pending);
      pending.catch(() => this.matcherCache.delete(libraryID));
    }
    return pending;
  }

  private getViewerDocument(reader: ZoteroReader): Document | undefined {
    const outer = reader._iframeWindow?.document;
    if (!outer) return undefined;
    const iframe = outer.querySelector<HTMLIFrameElement>("#primary-view > iframe, .primary-view > iframe");
    return iframe?.contentDocument || undefined;
  }

  private observeViewer(reader: ZoteroReader, doc: Document): void {
    const state = this.states.get(reader);
    const win = doc.defaultView;
    if (!state || !win || state.viewerDocument === doc) return;
    state.viewerObserver?.disconnect();
    const Observer = (win as Window & { MutationObserver: typeof MutationObserver }).MutationObserver;
    state.viewerObserver = new Observer(mutations => {
      const changedReaderContent = mutations.some(mutation =>
        Array.from(mutation.addedNodes).some(node => !this.isOwnNode(node))
        || Array.from(mutation.removedNodes).some(node => !this.isOwnNode(node))
      );
      if (changedReaderContent) this.scheduleScan(reader);
    });
    state.viewerObserver.observe(doc.documentElement, { childList: true, subtree: true });
    state.viewerDocument = doc;
  }

  private isOwnNode(node: Node): boolean {
    if (node.nodeType !== 1) return false;
    const element = node as Element;
    return element.matches(".reference-linker-badge, .reference-linker-menu, #reference-linker-style")
      || Boolean(element.closest(".reference-linker-badge, .reference-linker-menu"));
  }

  private getAttachment(reader: ZoteroReader): ZoteroItem | undefined {
    const item = reader._item || (reader.itemID ? this.zotero.Items.get(reader.itemID) : false);
    return item && item.isAttachment() ? item : undefined;
  }

  private async open(itemID: number, pdfAttachmentID?: number): Promise<void> {
    if (pdfAttachmentID) {
      await this.zotero.Reader.open(pdfAttachmentID);
      return;
    }
    const pane = this.zotero.getMainWindow().ZoteroPane;
    await pane?.selectItem(itemID);
  }

  private destroyReader(reader: ZoteroReader): void {
    const state = this.states.get(reader);
    state?.outerObserver?.disconnect();
    state?.viewerObserver?.disconnect();
    state?.overlay?.destroy();
    state?.summary?.remove();
    const win = reader._iframeWindow;
    if (state?.timer && win) win.clearTimeout(state.timer);
    if (state?.summaryTimer) state.summary?.ownerDocument.defaultView?.clearTimeout(state.summaryTimer);
    if (state?.unloadHandler && win) win.removeEventListener("unload", state.unloadHandler);
  }
}
