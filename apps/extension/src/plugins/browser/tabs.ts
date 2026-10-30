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

/**
 * Why Chrome detached the debugger from a tab Relay was controlling. Besides the tab closing, Chrome
 * detaches when a frame of another extension appears in the page, such as the popup a password
 * manager shows when an email field gets focus. It also refuses to attach while that frame is there.
 */
export function detachedError(tabId: number, reason: string): Error {
  if (reason === "canceled_by_user") {
    return new Error(`The user stopped Relay from controlling tab ${tabId}.`);
  }
  return new Error(
    `Chrome stopped Relay from controlling tab ${tabId}. Either the tab closed, or another extension (often a password manager or autofill tool) opened its own popup inside the page, which Chrome does not allow Relay to control. Do not retry: ask the user to close that popup or turn the extension off for this site, then take a new snapshot.`,
  );
}

/** One Puppeteer connection per tab, attached through chrome.debugger on first use. */
export class AttachedTabs {
  #browsers = new Map<number, Promise<Browser>>();
  #lost = new Map<number, AbortController>();
  #onChange: (tabIds: number[]) => void;

  constructor(onChange: (tabIds: number[]) => void = () => {}) {
    this.#onChange = onChange;
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId === undefined) return;
      this.#lost.get(source.tabId)?.abort(detachedError(source.tabId, reason));
      this.#drop(source.tabId);
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
      this.#lost.set(tabId, new AbortController());
      browser.then(
        () => this.#changed(),
        () => {
          this.#browsers.delete(tabId);
          this.#lost.delete(tabId);
        },
      );
    }
    const [page] = await (await browser).pages();
    if (!page) throw new Error(`Tab ${tabId} exposes no page to control`);
    return page;
  }

  /**
   * Aborted with the reason when Chrome detaches from the tab. Tools pass it on, because Puppeteer
   * would otherwise keep retrying an action on the detached tab until its own timeout.
   */
  lost(tabId: number): AbortSignal {
    return (
      this.#lost.get(tabId)?.signal ?? AbortSignal.abort(detachedError(tabId, "target_closed"))
    );
  }

  /** Detach from every tab. Tools re-attach on demand. */
  detachAll(): void {
    for (const tabId of this.#browsers.keys()) this.#drop(tabId);
  }

  #drop(tabId: number) {
    const browser = this.#browsers.get(tabId);
    if (!browser) return;
    this.#browsers.delete(tabId);
    this.#lost.delete(tabId);
    void browser.then((connected) => connected.disconnect()).catch(() => {});
    this.#changed();
  }

  #changed() {
    this.#onChange([...this.#browsers.keys()]);
  }
}
