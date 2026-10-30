import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { AttachedFiles } from "../../core/plugin.ts";
import { AttachedTabs, detachedError } from "./tabs.ts";
import { browserTools, uploadInPage } from "./tools.ts";

const { connectTab } = vi.hoisted(() => ({ connectTab: vi.fn() }));
vi.mock("puppeteer-core/lib/puppeteer/puppeteer-core-browser.js", () => ({
  ExtensionTransport: { connectTab },
  connect: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  connectTab.mockReset();
});

const noFiles: AttachedFiles = { names: async () => [], get: async () => undefined };

const RELAY_PAGE = "chrome-extension://relay/sidepanel.html";

/** The browser tools over one tab at `url`, whose page has navigated to `pageUrl`. */
function harness(url: string, pageUrl = url, files = noFiles) {
  const keyboard = { down: vi.fn(), press: vi.fn(), up: vi.fn() };
  const fill = vi.fn();
  // An <input>, as far as the tools can tell.
  const handle = {
    evaluate: vi.fn(async () => true),
    asLocator: () => ({ fill }),
    type: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    frame: { page: () => ({ keyboard }) },
  };
  const page = {
    url: () => pageUrl,
    evaluate: vi.fn(async () => "evaluated"),
    goto: vi.fn(async () => null),
    waitForSelector: vi.fn(async (_selector: string, _options: { signal: AbortSignal }) => handle),
    keyboard,
  };
  const attach = vi.fn<(tabId: number, signal: AbortSignal) => Promise<unknown>>(async () => page);
  const lost = new AbortController();
  const tabs = { page: attach, lost: () => lost.signal } as unknown as AttachedTabs;
  vi.stubGlobal("chrome", {
    tabs: {
      get: vi.fn(async () => ({ id: 1, url })),
      create: vi.fn(async () => ({ id: 2 })),
      query: vi.fn(async () => [{ id: 1, url }]),
    },
  });
  const tools = new Map(browserTools(tabs).map((tool) => [tool.name, tool]));
  const run = (name: string, args: unknown) =>
    tools.get(name)!.execute(args as never, { signal: new AbortController().signal, files });
  return { run, page, handle, fill, keyboard, attach, lost };
}

test("scripts cannot control Relay's own pages, which can read its credentials", async () => {
  const relayTab = harness(RELAY_PAGE);
  await expect(relayTab.run("page_evaluate", { expression: "1", tabId: 1 })).rejects.toThrow(
    "cannot be controlled",
  );
  // Refused before attaching the debugger to the page at all.
  expect(relayTab.attach).not.toHaveBeenCalled();

  // A tab that navigated there after it was attached is refused too.
  const navigated = harness("https://example.com/", RELAY_PAGE);
  await expect(navigated.run("page_evaluate", { expression: "1" })).rejects.toThrow(
    "cannot be controlled",
  );
  expect(navigated.page.evaluate).not.toHaveBeenCalled();

  const web = harness("https://example.com/");
  await expect(web.run("tabs_open", { url: RELAY_PAGE })).rejects.toThrow("cannot be controlled");
  await expect(web.run("page_goto", { url: RELAY_PAGE })).rejects.toThrow("cannot be controlled");
  expect(chrome.tabs.create).not.toHaveBeenCalled();
  await expect(web.run("page_evaluate", { expression: "1" })).resolves.toBe("evaluated");
});

test("scripts cannot control about:blank, which a Relay page may have opened", async () => {
  const blank = harness("about:blank");
  await expect(blank.run("page_evaluate", { expression: "1", tabId: 1 })).rejects.toThrow(
    "cannot be controlled",
  );
  expect(blank.attach).not.toHaveBeenCalled();
  await expect(blank.run("page_goto", { url: "about:blank" })).rejects.toThrow(
    "cannot be controlled",
  );

  // tabs_open's own blank tab comes from Chrome, not a Relay page, so it is attached directly.
  await blank.run("tabs_open", { url: "https://example.com/" });
  expect(blank.attach).toHaveBeenCalledWith(2, expect.any(AbortSignal));
  expect(blank.page.goto).toHaveBeenCalledWith("https://example.com/", expect.anything());
});

test("a tool stopped before it attached does not attach after Stop detached every tab", async () => {
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  let showTab!: (tab: Partial<chrome.tabs.Tab>) => void;
  vi.stubGlobal("chrome", {
    debugger: { onDetach: { addListener: vi.fn() } },
    tabs: { get: vi.fn(() => new Promise((resolve) => (showTab = resolve))) },
  });
  const tabs = new AttachedTabs();
  const evaluate = browserTools(tabs).find((tool) => tool.name === "page_evaluate")!;
  const stop = new AbortController();
  const running = evaluate.execute(
    { expression: "1", tabId: 1 },
    { signal: stop.signal, files: noFiles },
  );

  stop.abort(new Error("Stopped"));
  tabs.detachAll(); // What the browser plugin does when the run ends.
  showTab({ id: 1, url: "https://example.com/" });

  await expect(running).rejects.toThrow("Stopped");
  expect(connectTab).not.toHaveBeenCalled();
});

test("an action on a tab Chrome detaches from fails at once with the reason", async () => {
  const web = harness("https://example.com/");
  // Puppeteer would keep waiting for the selector on the detached tab until its own timeout.
  web.page.waitForSelector.mockImplementationOnce(
    (_selector, { signal }) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
  );
  const waiting = web.run("page_wait_for", { selector: "#email" });
  await vi.waitFor(() => expect(web.page.waitForSelector).toHaveBeenCalled());
  web.lost.abort(detachedError(1, "target_closed"));
  await expect(waiting).rejects.toThrow("another extension");
});

test("a tab showing another extension's popup is reported as such", async () => {
  const web = harness("https://example.com/");
  web.attach.mockRejectedValue(
    new Error("Cannot access a chrome-extension:// URL of different extension"),
  );
  await expect(web.run("page_snapshot", {})).rejects.toThrow("ask the user to close that popup");
});

test("a line break is never typed into a single-line field, where it would submit the form", async () => {
  const web = harness("https://example.com/");
  const links = "https://github.com/me\nhttps://linkedin.com/in/me";
  await expect(web.run("page_fill", { selector: "#links", text: links })).rejects.toThrow(
    "single-line field",
  );
  await expect(web.run("page_type", { selector: "#links", text: links })).rejects.toThrow(
    "single-line field",
  );
  expect(web.fill).not.toHaveBeenCalled();
  expect(web.handle.type).not.toHaveBeenCalled();

  await web.run("page_fill", { selector: "#links", text: "https://github.com/me" });
  expect(web.fill).toHaveBeenCalledOnce();
  // A multi-line field takes line breaks.
  web.handle.evaluate.mockResolvedValue(false);
  await web.run("page_fill", { selector: "#bio", text: links });
  expect(web.fill).toHaveBeenLastCalledWith(links, expect.anything());
});

test("page_press holds the modifiers of a key combination", async () => {
  vi.stubGlobal("navigator", { platform: "Linux x86_64" });
  const web = harness("https://example.com/");
  await web.run("page_press", { selector: "#deadline", key: "ControlOrMeta+A" });
  expect(web.handle.focus).toHaveBeenCalled();
  expect(web.keyboard.down).toHaveBeenCalledWith("Control");
  expect(web.keyboard.press).toHaveBeenCalledWith("A", {});
  expect(web.keyboard.up).toHaveBeenCalledWith("Control");

  await web.run("page_press", { key: "Control++" });
  expect(web.keyboard.press).toHaveBeenLastCalledWith("+", {});
  await expect(web.run("page_press", { key: "Ctrl+A" })).rejects.toThrow('Unknown modifier "Ctrl"');

  // Chrome on macOS runs editing shortcuts only when they name their command.
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  await web.run("page_press", { key: "ControlOrMeta+a" });
  expect(web.keyboard.down).toHaveBeenLastCalledWith("Meta");
  expect(web.keyboard.press).toHaveBeenLastCalledWith("a", { commands: ["selectAll"] });
  await web.run("page_press", { key: "Shift+ControlOrMeta+Z" });
  expect(web.keyboard.press).toHaveBeenLastCalledWith("Z", { commands: ["redo"] });
  await web.run("page_press", { key: "Meta+Backspace" });
  expect(web.keyboard.press).toHaveBeenLastCalledWith("Backspace", {
    commands: ["deleteToBeginningOfLine"],
  });
});

test("page_upload puts an attached file into the page's upload field", async () => {
  const resume = new File(["%PDF-1.7"], "resume.pdf", { type: "application/pdf" });
  const files: AttachedFiles = {
    names: async () => ["resume.pdf"],
    get: async (name) => (name === "resume.pdf" ? resume : undefined),
  };
  const web = harness("https://example.com/", undefined, files);
  web.handle.evaluate.mockResolvedValue(undefined as never);

  await web.run("page_upload", { selector: "#resume", name: "resume.pdf" });
  expect(web.handle.evaluate).toHaveBeenCalledWith(uploadInPage, {
    name: "resume.pdf",
    type: "application/pdf",
    data: btoa("%PDF-1.7"),
  });

  await expect(web.run("page_upload", { selector: "#resume", name: "cv.pdf" })).rejects.toThrow(
    'No attached file is named "cv.pdf". Attached: resume.pdf.',
  );
  // The page reports when there is no upload field at the target.
  web.handle.evaluate.mockResolvedValue("No file upload field there." as never);
  await expect(web.run("page_upload", { selector: "#name", name: "resume.pdf" })).rejects.toThrow(
    "No file upload field there.",
  );
});

test("page_upload asks for the file when the user attached none", async () => {
  const web = harness("https://example.com/");
  await expect(web.run("page_upload", { selector: "#resume", name: "resume.pdf" })).rejects.toThrow(
    "has not attached any files",
  );
  expect(web.attach).not.toHaveBeenCalled();
});

describe("uploadInPage", () => {
  /** Just enough of the DOM for uploadInPage. */
  class Element {
    parentElement: Element | null = null;
    children: Element[] = [];
    constructor(...children: Element[]) {
      for (const child of children) {
        child.parentElement = this;
        this.children.push(child);
      }
    }
    querySelectorAll(): Element[] {
      return this.children.flatMap((child) => [
        ...(child instanceof Input ? [child] : []),
        ...child.querySelectorAll(),
      ]);
    }
  }
  class Input extends Element {
    type = "file";
    files: File[] = [];
    events: string[] = [];
    dispatchEvent(event: Event) {
      this.events.push(event.type);
    }
  }
  class Label extends Element {
    control: Element | null = null;
  }
  class Form extends Element {}
  class Transfer {
    files: File[] = [];
    items = { add: (file: File) => void this.files.push(file) };
  }

  const file = { name: "resume.pdf", type: "application/pdf", data: btoa("%PDF") };
  const upload = (target: Element) => uploadInPage(target as never, file);

  function page(...children: Element[]) {
    const body = new Element(...children);
    vi.stubGlobal("HTMLInputElement", Input);
    vi.stubGlobal("HTMLLabelElement", Label);
    vi.stubGlobal("HTMLFormElement", Form);
    vi.stubGlobal("DataTransfer", Transfer);
    vi.stubGlobal("document", { body });
  }

  test("fills the hidden field beside the button that opens it", async () => {
    const button = new Element();
    const input = new Input();
    page(new Form(new Element(new Element(button), input)));
    expect(upload(button)).toBeUndefined();
    expect(input.files.map((picked) => picked.name)).toEqual(["resume.pdf"]);
    expect(await input.files[0]!.text()).toBe("%PDF");
    expect(input.events).toEqual(["input", "change"]);
  });

  test("fills the field a label is for", () => {
    const input = new Input();
    const label = new Label();
    label.control = input;
    page(new Form(label), new Form(input));
    expect(upload(label)).toBeUndefined();
    expect(input.files).toHaveLength(1);
  });

  test("never reaches another form's field, or guesses between several", () => {
    const button = new Element();
    const elsewhere = new Input();
    page(new Form(new Element(button)), new Form(elsewhere));
    expect(upload(button)).toMatch("No file upload field there");
    expect(elsewhere.files).toHaveLength(0);

    const between = new Element();
    page(new Form(new Element(between, new Input(), new Input())));
    expect(upload(between)).toMatch("Several file upload fields");
  });
});
