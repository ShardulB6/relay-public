import {
  connect,
  ExtensionTransport,
  type Browser,
  type Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
  windowId: number;
}

export function tabInfo(tab: chrome.tabs.Tab): TabInfo {
  return {
    id: tab.id ?? -1,
    title: tab.title ?? "",
    url: tab.url ?? tab.pendingUrl ?? "",
    active: tab.active,
    windowId: tab.windowId,
  };
}

/** One Puppeteer connection per tab, attached through chrome.debugger on first use. */
export class AttachedTabs {
  #browsers = new Map<number, Promise<Browser>>();
  #onChange: (tabIds: number[]) => void;

  constructor(onChange: (tabIds: number[]) => void = () => {}) {
    this.#onChange = onChange;
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined) this.#drop(source.tabId);
    });
    // Disconnecting always calls chrome.debugger.detach, which rejects when the user or the
    // browser already detached. That rejection is expected.
    window.addEventListener("unhandledrejection", (event) => {
      if (/not attached|No tab with given id/i.test(String(event.reason?.message))) {
        event.preventDefault();
      }
    });
  }

  /**
   * The tab's page, attaching first if needed. Stop detaches every tab, so a stopped tool must not
   * attach again: nothing would detach it.
   */
  async page(tabId: number, signal: AbortSignal): Promise<Page> {
    signal.throwIfAborted();
    let browser = this.#browsers.get(tabId);
    if (!browser) {
      browser = ExtensionTransport.connectTab(tabId).then((transport) =>
        connect({ transport, defaultViewport: null }),
      );
      this.#browsers.set(tabId, browser);
      browser.then(
        () => this.#changed(),
        () => this.#browsers.delete(tabId),
      );
    }
    const [page] = await (await browser).pages();
    if (!page) throw new Error(`Tab ${tabId} exposes no page to control`);
    return page;
  }

  /** Detach from every tab. Tools re-attach on demand. */
  detachAll(): void {
    for (const tabId of this.#browsers.keys()) this.#drop(tabId);
  }

  #drop(tabId: number) {
    const browser = this.#browsers.get(tabId);
    if (!browser) return;
    this.#browsers.delete(tabId);
    void browser.then((connected) => connected.disconnect()).catch(() => {});
    this.#changed();
  }

  #changed() {
    this.#onChange([...this.#browsers.keys()]);
  }
}
