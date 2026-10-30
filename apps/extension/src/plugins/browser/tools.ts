import { Type, type ImageContent, type TSchema } from "@earendil-works/pi-ai";
import type {
  ElementHandle,
  Keyboard,
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
    const message = error instanceof Error ? error.message : String(error);
    if (/different extension/i.test(message)) {
      throw new Error(
        `Tab ${tabId} cannot be controlled: another extension (often a password manager or autofill tool) has its own popup open inside the page, which Chrome does not allow Relay to control. Do not retry: ask the user to close that popup or turn the extension off for this site.`,
      );
    }
    throw new Error(
      `Tab ${tabId} cannot be controlled (${message}). Open a regular page with tools.tabs_open({ url }).`,
    );
  }
}

/**
 * Run `action` on the tab's page. Its signal also aborts when Chrome detaches from the tab, and
 * an action that fails after that reports why the tab was lost.
 */
async function withPage<T>(
  tabs: AttachedTabs,
  signal: AbortSignal,
  tabId: number | undefined,
  action: (target: Page, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const id = tabId ?? (await activeTabId());
  // Checked before attaching, and again after: the tab may have navigated since it was attached.
  const tab = await chrome.tabs.get(id);
  for (const url of [tab.url, tab.pendingUrl]) if (url) assertControllable(url);
  const target = await attach(tabs, id, signal);
  assertControllable(target.url());
  const lost = tabs.lost(id);
  try {
    return await action(target, AbortSignal.any([signal, lost]));
  } catch (error) {
    if (lost.aborted && !signal.aborted) throw lost.reason;
    throw error;
  }
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

/**
 * Typing a line break into a single-line field presses Enter, which submits its form. The field
 * could not hold the line break anyway.
 */
async function assertFits(handle: ElementHandle<Element>, text: string): Promise<void> {
  if (!/[\r\n]/.test(text)) return;
  if (await handle.evaluate((el) => el instanceof HTMLInputElement)) {
    throw new Error(
      "This is a single-line field: typing a line break into it presses Enter, which can submit the form. Join the lines with a separator instead, and use page_press to press Enter on purpose.",
    );
  }
}

const MODIFIERS = new Set(["Alt", "Control", "Meta", "Shift"]);
/**
 * Editing shortcuts Chrome on macOS only runs when CDP names their command, by modifiers (in
 * Alt, Control, Meta, Shift order) and key.
 */
const MAC_COMMANDS: Record<string, string> = {
  "Meta+a": "selectAll",
  "Meta+c": "copy",
  "Meta+x": "cut",
  "Meta+v": "paste",
  "Meta+z": "undo",
  "Meta+Shift+z": "redo",
  "Meta+Backspace": "deleteToBeginningOfLine",
  "Meta+Delete": "deleteToEndOfLine",
  "Alt+Backspace": "deleteWordBackward",
  "Alt+Delete": "deleteWordForward",
  "Meta+ArrowLeft": "moveToBeginningOfLine",
  "Meta+ArrowRight": "moveToEndOfLine",
  "Meta+ArrowUp": "moveToBeginningOfDocument",
  "Meta+ArrowDown": "moveToEndOfDocument",
  "Alt+ArrowLeft": "moveWordLeft",
  "Alt+ArrowRight": "moveWordRight",
  "Meta+Shift+ArrowLeft": "moveToBeginningOfLineAndModifySelection",
  "Meta+Shift+ArrowRight": "moveToEndOfLineAndModifySelection",
  "Meta+Shift+ArrowUp": "moveToBeginningOfDocumentAndModifySelection",
  "Meta+Shift+ArrowDown": "moveToEndOfDocumentAndModifySelection",
  "Alt+Shift+ArrowLeft": "moveWordLeftAndModifySelection",
  "Alt+Shift+ArrowRight": "moveWordRightAndModifySelection",
};

/** Press a key or a combination such as "Control+A", "ControlOrMeta+A" or "Shift+Tab". */
async function pressKeys(keyboard: Keyboard, combo: string): Promise<void> {
  const parts = combo.split("+");
  // A "+" key splits into two empty parts: "Control++" is Control and "+".
  if (combo.endsWith("+")) parts.splice(-2, 2, "+");
  const key = parts.pop() as KeyInput;
  const mac = navigator.platform.startsWith("Mac");
  const modifiers = parts.map((part) => {
    const modifier = part === "ControlOrMeta" ? (mac ? "Meta" : "Control") : part;
    if (!MODIFIERS.has(modifier)) throw new Error(`Unknown modifier "${part}" in "${combo}".`);
    return modifier as KeyInput;
  });
  const command = mac
    ? MAC_COMMANDS[[...modifiers.toSorted(), key.length === 1 ? key.toLowerCase() : key].join("+")]
    : undefined;
  for (const modifier of modifiers) await keyboard.down(modifier);
  try {
    await keyboard.press(key, command ? { commands: [command] } : {});
  } finally {
    for (const modifier of modifiers.toReversed()) await keyboard.up(modifier);
  }
}

/** A file on its way into the page, its bytes in base64. */
interface UploadedFile {
  name: string;
  type: string;
  data: string;
}

/**
 * Put `file` into the file upload field at `target`, as if the user had picked it. The field is
 * often hidden behind a button, so `target` may also be its label, or an element beside it: the
 * one upload field within a few levels of `target`, never one further away, in another form.
 * Returns an error message when there is no such field, or several.
 *
 * Runs inside the page (serialized by `evaluate`), so it must stay self-contained.
 */
export function uploadInPage(target: Element, file: UploadedFile): string | undefined {
  const isFileInput = (el: unknown): el is HTMLInputElement =>
    el instanceof HTMLInputElement && el.type === "file";
  let input = isFileInput(target)
    ? target
    : target instanceof HTMLLabelElement && isFileInput(target.control)
      ? target.control
      : undefined;
  const LEVELS = 3;
  let scope: Element | null = target;
  for (let level = 0; !input && scope && level <= LEVELS; level++) {
    const found = scope.querySelectorAll('input[type="file"]');
    if (found.length > 1) {
      return 'Several file upload fields are there. Target the right <input type="file"> with a selector.';
    }
    if (found.length === 1) input = found[0] as HTMLInputElement;
    // Not past the form, whose other upload fields are not this one's.
    if (scope instanceof HTMLFormElement || scope === document.body) break;
    scope = scope.parentElement;
  }
  if (!input) {
    return 'No file upload field there. Target the <input type="file"> itself; it is often hidden, so find it with page_evaluate and pass a selector.';
  }
  const transfer = new DataTransfer();
  transfer.items.add(new File([Uint8Array.fromBase64(file.data)], file.name, { type: file.type }));
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return undefined;
}

/** Run `action` on the targeted element, optionally waiting for the navigation it causes. */
function act<T>(
  tabs: AttachedTabs,
  input: { ref?: string; selector?: string; tabId?: number; navigation?: boolean },
  signal: AbortSignal,
  action: (handle: ElementHandle<Element>, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return withPage(tabs, signal, input.tabId, async (target, signal) => {
    const handle = await element(target, input, signal);
    try {
      if (!input.navigation) return await action(handle, signal);
      const [, result] = await Promise.all([
        target.waitForNavigation({ signal }),
        action(handle, signal),
      ]);
      return result;
    } finally {
      await handle.dispose();
    }
  });
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
      execute: ({ tabId, ...options }, { signal }) =>
        withPage(tabs, signal, tabId, (target) => target.evaluate(snapshotInPage, options)),
    }),
    scriptTool({
      name: "page_goto",
      description: "Navigate and wait for the page to load.",
      parameters: Type.Object({ url: Type.String(), tabId: TabId }),
      returns: Type.Object({ url: Type.String(), title: Type.String() }),
      execute: async ({ url, tabId }, { signal }) => {
        assertControllable(url);
        return withPage(tabs, signal, tabId, async (target, signal) => {
          await target.goto(url, { signal });
          return { url: target.url(), title: await target.title() };
        });
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
        act(tabs, input, signal, async (handle, signal) => {
          await assertFits(handle, input.text);
          await handle.asLocator().fill(input.text, { signal });
        }),
    }),
    scriptTool({
      name: "page_type",
      description: "Type text into an element, after its current value.",
      parameters: Type.Object({ ...Target, text: Type.String() }),
      execute: (input, { signal }) =>
        act(tabs, input, signal, async (handle) => {
          await assertFits(handle, input.text);
          await handle.type(input.text);
        }),
    }),
    scriptTool({
      name: "page_press",
      description:
        'Press a key such as "Enter", "Tab" or "ArrowDown", or a combination such as "ControlOrMeta+A" (Command on macOS, Control elsewhere), on an element, or on the focused element when no target is given.',
      parameters: Type.Object({ ...Target, key: Type.String(), navigation: Navigation }),
      execute: (input, { signal }) => {
        if (input.ref || input.selector) {
          return act(tabs, input, signal, async (handle) => {
            await handle.focus();
            await pressKeys(handle.frame.page().keyboard, input.key);
          });
        }
        return withPage(tabs, signal, input.tabId, async (target, signal) => {
          if (!input.navigation) return pressKeys(target.keyboard, input.key);
          await Promise.all([
            target.waitForNavigation({ signal }),
            pressKeys(target.keyboard, input.key),
          ]);
        });
      },
    }),
    scriptTool({
      name: "page_upload",
      description:
        'Upload a file the user attached into a file upload field, as if they had picked it. Target the <input type="file">, or the button or label that opens it.',
      parameters: Type.Object({
        ...Target,
        name: Type.String({ description: 'The attached file\'s name, e.g. "resume.pdf".' }),
      }),
      execute: async (input, { signal, files }) => {
        const file = await files.get(input.name);
        if (!file) {
          const names = await files.names();
          throw new Error(
            names.length > 0
              ? `No attached file is named "${input.name}". Attached: ${names.join(", ")}.`
              : "The user has not attached any files. Ask them to attach the file to a message.",
          );
        }
        const upload = {
          name: file.name,
          type: file.type,
          data: new Uint8Array(await file.arrayBuffer()).toBase64(),
        };
        return act(tabs, input, signal, async (handle) => {
          const error = await handle.evaluate(uploadInPage, upload);
          if (error) throw new Error(error);
        });
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
      execute: ({ expression, tabId }, { signal }) =>
        withPage(tabs, signal, tabId, (target) => target.evaluate(expression)),
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
      execute: ({ selector, navigation, timeoutMs, tabId }, { signal }) =>
        withPage(tabs, signal, tabId, async (target, signal) => {
          if (selector) {
            await (
              await target.waitForSelector(selector, { visible: true, timeout: timeoutMs, signal })
            )?.dispose();
          } else if (navigation) {
            await target.waitForNavigation({ timeout: timeoutMs, signal });
          } else {
            throw new Error("Pass a selector or navigation: true.");
          }
        }),
    }),
    scriptTool({
      name: "page_screenshot",
      description:
        "Capture the viewport, the full page, or one element, as an image block. Show it to yourself with image(block). Prefer page_snapshot() or page_evaluate() for reading text.",
      parameters: Type.Object({ ...Target, fullPage: Type.Optional(Type.Boolean()) }),
      returns: Image,
      execute: ({ ref, selector, tabId, fullPage }, { signal }): Promise<ImageContent> =>
        withPage(tabs, signal, tabId, async (target, signal) => {
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
        }),
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
