declare const Zotero: ZoteroAPI;

interface ZoteroItem {
  id: number;
  key: string;
  libraryID: number;
  parentID?: number | false;
  itemTypeID: number;
  getField(field: string): string;
  getCreators(): Array<{ firstName?: string; lastName?: string; name?: string; creatorTypeID?: number }>;
  getAttachments(): number[];
  isRegularItem(): boolean;
  isAttachment(): boolean;
  attachmentContentType?: string;
  fileExists?(): Promise<boolean>;
}

interface ZoteroLibrary {
  libraryID: number;
  libraryType: string;
  name: string;
}

interface ZoteroNotifierObserver {
  notify(event: string, type: string, ids: Array<number | string>, extraData: unknown): void;
}

interface ZoteroReader {
  itemID?: number;
  _item?: ZoteroItem;
  _iframeWindow?: Window;
}

interface ZoteroAPI {
  debug(message: unknown, level?: number): void;
  logError(error: unknown): void;
  launchURL(url: string): void;
  getMainWindow(): Window & { ZoteroPane?: { viewAttachment(id: number): Promise<void> | void; selectItem(id: number): Promise<void> | void } };
  Items: {
    get(id: number): ZoteroItem | false;
    getAll(libraryID: number, onlyTopLevel?: boolean, includeDeleted?: boolean): Promise<ZoteroItem[]>;
  };
  ItemTypes?: {
    getName(itemTypeID: number): string;
  };
  Libraries?: {
    get(libraryID: number): ZoteroLibrary | false;
    getAll(): ZoteroLibrary[];
  };
  Notifier?: {
    registerObserver(observer: ZoteroNotifierObserver, types: string[], id?: string): string;
    unregisterObserver(id: string): void;
  };
  Utilities?: {
    Internal?: { copyTextToClipboard(text: string): void };
  };
  Reader: {
    registerEventListener(type: string, handler: (event: ReaderEvent) => void, pluginID: string): void;
    unregisterEventListener(type: string, handler: (event: ReaderEvent) => void): void;
    open(itemID: number): Promise<unknown>;
  };
}

interface ReaderEvent {
  reader: ZoteroReader;
  doc?: Document;
  append?: (node: Node) => void;
}
