import { Type, type ImageContent, type TSchema } from "@earendil-works/pi-ai";
import type {
  ElementHandle,
  KeyInput,
  Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";

import { defineTool, type Tool } from "../../core/plugin.ts";
import { resolveRefInPage, snapshotInPage } from "./snapshot.ts";
import { tabInfo, type AttachedTabs } from "./tabs.ts";

/** A browser tool: only scripts call it, so one script can chain many browser actions. */
function scriptTool<P extends TSchema>(tool: Omit<Tool<P>, "callers">): Tool<P> {
  return defineTool({ ...tool, callers: ["scripts"] });
}

/**
 * Scripts may only control web pages. Relay's own pages (chrome-extension://) can read its stored
 * credentials, so a script that reached one could too. So can an about:blank page one of them
 * opened, which shares its origin.
 */
function assertControllable(url: string): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (protocol === "http:" || protocol === "https:") return;
  throw new Error(
    `${url} cannot be controlled: scripts can only control http(s) pages. Open one with tools.tabs_open({ url }).`,
  );
}

const TabId = Type.Optional(
  Type.Integer({ description: "Tab from tools.tabs_*. Default: the active tab." }),
);
const Target = {
  ref: Type.Optional(Type.String({ description: 'Ref from the latest snapshot, e.g. "e12".' })),
  selector: Type.Optional(
    Type.String({ description: "CSS selector; waits up to 10s for a match." }),
  ),
  tabId: TabId,
};
const Navigation = Type.Optional(
  Type.Boolean({ description: "Wait for the navigation this action triggers." }),
);
/** An image block, which scripts show to the model with `image(block)`. */
const Image = Type.Object({
  type: Type.Literal("image"),
  data: Type.String(),
  mimeType: Type.String(),
});
const Tab = Type.Object({
  id: Type.Integer(),
  title: Type.String(),
  url: Type.String(),
  active: Type.Boolean(),
  windowId: Type.Integer(),
});

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) {
    throw new Error("There is no active tab. Open one with tools.tabs_open({ url }).");
  }
  return tab.id;
}

async function attach(tabs: AttachedTabs, tabId: number, signal: AbortSignal): Promise<Page> {
  try {
    return await tabs.page(tabId, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(
      `Tab ${tabId} cannot be controlled (${error instanceof Error ? error.message : String(error)}). Open a regular page with tools.tabs_open({ url }).`,
    );
  }
}

async function page(tabs: AttachedTabs, signal: AbortSignal, tabId?: number): Promise<Page> {
  const id = tabId ?? (await activeTabId());
  // Checked before attaching, and again after: the tab may have navigated since it was attached.
  const tab = await chrome.tabs.get(id);
  for (const url of [tab.url, tab.pendingUrl]) if (url) assertControllable(url);
  const target = await attach(tabs, id, signal);
  assertControllable(target.url());
  return target;
}

async function element(
  target: Page,
  { ref, selector }: { ref?: string; selector?: string },
  signal: AbortSignal,
): Promise<ElementHandle<Element>> {
  if (ref) {
    const handle = await target.evaluateHandle(resolveRefInPage, ref);
    const found = handle.asElement() as ElementHandle<Element> | null;
    if (found) return found;
    await handle.dispose();
    throw new Error(
      `Unknown or stale ref "${ref}". Refs only live until the next snapshot or navigation; take a new snapshot.`,
    );
  }
  if (selector) {
    const found = await target.waitForSelector(selector, { timeout: 10_000, signal });
    if (found) return found;
  }
  throw new Error(selector ? `No element matches ${selector}.` : "Pass a ref or a selector.");
}

/** Run `action` on the targeted element, optionally waiting for the navigation it causes. */
async function act<T>(
  tabs: AttachedTabs,
  input: { ref?: string; selector?: string; tabId?: number; navigation?: boolean },
  signal: AbortSignal,
  action: (handle: ElementHandle<Element>, target: Page) => Promise<T>,
): Promise<T> {
  const target = await page(tabs, signal, input.tabId);
  const handle = await element(target, input, signal);
  try {
    if (!input.navigation) return await action(handle, target);
    const [, result] = await Promise.all([
      target.waitForNavigation({ signal }),
      action(handle, target),
    ]);
    return result;
  } finally {
    await handle.dispose();
  }
}

/** The tools scripts use to inspect and control the user's tabs. */
export function browserTools(tabs: AttachedTabs): Tool[] {
  return [
    scriptTool({
      name: "tabs_list",
      description: "All open tabs.",
      parameters: Type.Object({}),
      returns: Type.Array(Tab),
      execute: async () => (await chrome.tabs.query({})).map(tabInfo),
    }),
    scriptTool({
      name: "tabs_current",
      description: "The tab the user is looking at.",
      parameters: Type.Object({}),
      returns: Type.Union([Tab, Type.Null()]),
      execute: async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return tab ? tabInfo(tab) : null;
      },
    }),
    scriptTool({
      name: "tabs_open",
      description: "Open a new tab and wait for it to load. Pass its id as tabId to page tools.",
      parameters: Type.Object({ url: Type.String(), active: Type.Optional(Type.Boolean()) }),
      returns: Tab,
      execute: async ({ url, active = true }, { signal }) => {
        assertControllable(url);
        // A blank tab Chrome opens has an opaque origin, unlike one a Relay page opens, so this
        // one is attached without the check that refuses about:blank.
        const tab = await chrome.tabs.create({ url: "about:blank", active });
        if (tab.id === undefined) throw new Error("Chrome did not return the new tab");
        await (await attach(tabs, tab.id, signal)).goto(url, { signal });
        return tabInfo(await chrome.tabs.get(tab.id));
      },
    }),
    scriptTool({
      name: "tabs_activate",
      description: "Bring a tab to the front.",
      parameters: Type.Object({ tabId: Type.Integer() }),
      execute: async ({ tabId }) => {
        const tab = await chrome.tabs.update(tabId, { active: true });
        if (tab) await chrome.windows.update(tab.windowId, { focused: true });
      },
    }),
    scriptTool({
      name: "tabs_close",
      description: "Close a tab.",
      parameters: Type.Object({ tabId: Type.Integer() }),
      execute: ({ tabId }) => chrome.tabs.remove(tabId),
    }),

    scriptTool({
      name: "page_snapshot",
      description:
        "A compact text view of the page: headings, text, and interactive elements labelled with refs such as [e12]. Refs go stale after a navigation or a new snapshot.",
      parameters: Type.Object({
        within: Type.Optional(
          Type.String({ description: "CSS selector that scopes the snapshot." }),
        ),
        interactiveOnly: Type.Optional(Type.Boolean()),
        maxChars: Type.Optional(Type.Integer({ description: "Default 12000." })),
        tabId: TabId,
      }),
      execute: async ({ tabId, ...options }, { signal }) =>
        (await page(tabs, signal, tabId)).evaluate(snapshotInPage, options),
    }),
    scriptTool({
      name: "page_goto",
      description: "Navigate and wait for the page to load.",
      parameters: Type.Object({ url: Type.String(), tabId: TabId }),
      returns: Type.Object({ url: Type.String(), title: Type.String() }),
      execute: async ({ url, tabId }, { signal }) => {
        assertControllable(url);
        const target = await page(tabs, signal, tabId);
        await target.goto(url, { signal });
        return { url: target.url(), title: await target.title() };
      },
    }),
    scriptTool({
      name: "page_click",
      description: "Click an element.",
      parameters: Type.Object({ ...Target, navigation: Navigation }),
      execute: (input, { signal }) => act(tabs, input, signal, (handle) => handle.click()),
    }),
    scriptTool({
      name: "page_fill",
      description: "Replace the value of a text field, select, or contenteditable element.",
      parameters: Type.Object({ ...Target, text: Type.String() }),
      execute: (input, { signal }) =>
        act(tabs, input, signal, (handle) => handle.asLocator().fill(input.text)),
    }),
    scriptTool({
      name: "page_type",
      description: "Type text into an element, after its current value.",
      parameters: Type.Object({ ...Target, text: Type.String() }),
      execute: (input, { signal }) => act(tabs, input, signal, (handle) => handle.type(input.text)),
    }),
    scriptTool({
      name: "page_press",
      description:
        'Press a key such as "Enter", "Tab" or "ArrowDown" on an element, or on the focused element when no target is given.',
      parameters: Type.Object({ ...Target, key: Type.String(), navigation: Navigation }),
      execute: async (input, { signal }) => {
        const key = input.key as KeyInput;
        if (input.ref || input.selector) {
          return act(tabs, input, signal, (handle) => handle.press(key));
        }
        const target = await page(tabs, signal, input.tabId);
        if (!input.navigation) return target.keyboard.press(key);
        await Promise.all([target.waitForNavigation({ signal }), target.keyboard.press(key)]);
      },
    }),
    scriptTool({
      name: "page_select",
      description: "Choose options of a <select> by value. Returns the selected values.",
      parameters: Type.Object({ ...Target, values: Type.Array(Type.String()) }),
      returns: Type.Array(Type.String()),
      execute: (input, { signal }) =>
        act(tabs, input, signal, (handle) => handle.select(...input.values)),
    }),
    scriptTool({
      name: "page_hover",
      description: "Move the mouse over an element.",
      parameters: Type.Object(Target),
      execute: (input, { signal }) => act(tabs, input, signal, (handle) => handle.hover()),
    }),
    scriptTool({
      name: "page_evaluate",
      description:
        "Evaluate a JavaScript expression in the page and return its JSON value. Promises are awaited. Use an IIFE for statements: (() => { ... })().",
      parameters: Type.Object({ expression: Type.String(), tabId: TabId }),
      returns: Type.Unknown(),
      execute: async ({ expression, tabId }, { signal }) =>
        (await page(tabs, signal, tabId)).evaluate(expression),
    }),
    scriptTool({
      name: "page_wait_for",
      description:
        "Wait until a selector matches a visible element, or for the next navigation. Default timeout 30000ms.",
      parameters: Type.Object({
        selector: Type.Optional(Type.String()),
        navigation: Type.Optional(Type.Boolean()),
        timeoutMs: Type.Optional(Type.Integer()),
        tabId: TabId,
      }),
      execute: async ({ selector, navigation, timeoutMs, tabId }, { signal }) => {
        const target = await page(tabs, signal, tabId);
        if (selector) {
          await (
            await target.waitForSelector(selector, { visible: true, timeout: timeoutMs, signal })
          )?.dispose();
        } else if (navigation) {
          await target.waitForNavigation({ timeout: timeoutMs, signal });
        } else {
          throw new Error("Pass a selector or navigation: true.");
        }
      },
    }),
    scriptTool({
      name: "page_screenshot",
      description:
        "Capture the viewport, the full page, or one element, as an image block. Show it to yourself with image(block). Prefer page_snapshot() or page_evaluate() for reading text.",
      parameters: Type.Object({ ...Target, fullPage: Type.Optional(Type.Boolean()) }),
      returns: Image,
      execute: async ({ ref, selector, tabId, fullPage }, { signal }): Promise<ImageContent> => {
        const target = await page(tabs, signal, tabId);
        const options = { type: "jpeg", quality: 70, encoding: "base64" } as const;
        let data: string;
        if (ref || selector) {
          const handle = await element(target, { ref, selector }, signal);
          try {
            data = await handle.screenshot(options);
          } finally {
            await handle.dispose();
          }
        } else {
          data = await target.screenshot({ ...options, fullPage });
        }
        return { type: "image", data, mimeType: "image/jpeg" };
      },
    }),
    scriptTool({
      name: "sleep",
      description: "Wait for some milliseconds, e.g. for a page to settle.",
      parameters: Type.Object({ ms: Type.Integer({ minimum: 0, maximum: 60_000 }) }),
      execute: ({ ms }, { signal }) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
        }),
    }),
  ];
}
