import { afterEach, expect, test, vi } from "vite-plus/test";

import { AttachedTabs } from "./tabs.ts";
import { browserTools } from "./tools.ts";

const { connectTab } = vi.hoisted(() => ({ connectTab: vi.fn() }));
vi.mock("puppeteer-core/lib/puppeteer/puppeteer-core-browser.js", () => ({
  ExtensionTransport: { connectTab },
  connect: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  connectTab.mockReset();
});

const RELAY_PAGE = "chrome-extension://relay/sidepanel.html";

/** The browser tools over one tab at `url`, whose page has navigated to `pageUrl`. */
function harness(url: string, pageUrl = url) {
  const page = {
    url: () => pageUrl,
    evaluate: vi.fn(async () => "evaluated"),
    goto: vi.fn(async () => null),
  };
  const attach = vi.fn(async () => page);
  const tabs = { page: attach } as unknown as AttachedTabs;
  vi.stubGlobal("chrome", {
    tabs: {
      get: vi.fn(async () => ({ id: 1, url })),
      create: vi.fn(async () => ({ id: 2 })),
      query: vi.fn(async () => [{ id: 1, url }]),
    },
  });
  const tools = new Map(browserTools(tabs).map((tool) => [tool.name, tool]));
  const run = (name: string, args: unknown) =>
    tools.get(name)!.execute(args as never, { signal: new AbortController().signal });
  return { run, page, attach };
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
  const running = evaluate.execute({ expression: "1", tabId: 1 }, { signal: stop.signal });

  stop.abort(new Error("Stopped"));
  tabs.detachAll(); // What the browser plugin does when the run ends.
  showTab({ id: 1, url: "https://example.com/" });

  await expect(running).rejects.toThrow("Stopped");
  expect(connectTab).not.toHaveBeenCalled();
});
