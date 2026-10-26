import { afterEach, expect, test, vi } from "vite-plus/test";

import { chromeStore } from "../../core/storage.ts";
import { UserScriptManager, permissionOrigins, siteMatch, validateMatches } from "./manager.ts";
import {
  SCRIPTS_KEY,
  USERSCRIPTS_MESSAGE,
  type UserScript,
  type SaveUserScript,
  type UserScriptDetails,
  type UserScriptSummary,
} from "./protocol.ts";

afterEach(() => vi.unstubAllGlobals());

const storage = chromeStore("plugin:userscripts");
const stored = async () => (await storage.get<UserScript[]>(SCRIPTS_KEY)) ?? [];
let pluginEnabled = true;
/** A manager as the service worker would create it, e.g. after a restart. */
const newManager = () => new UserScriptManager({ storage, enabled: async () => pluginEnabled });

function harness() {
  pluginEnabled = true;
  const registrations = new Map<string, chrome.userScripts.RegisteredUserScript>();
  const origins = new Set<string>();
  const api = {
    getScripts: vi.fn(async () => structuredClone([...registrations.values()])),
    register: vi.fn(async (scripts: chrome.userScripts.RegisteredUserScript[]) => {
      for (const script of scripts) {
        if (script.js?.some((source) => source.code === "invalid code")) {
          throw new Error("Script parsing failed");
        }
        if (registrations.has(script.id)) throw new Error("Duplicate registration");
        registrations.set(script.id, structuredClone(script));
      }
    }),
    update: vi.fn(async (scripts: chrome.userScripts.RegisteredUserScript[]) => {
      for (const script of scripts) {
        if (script.js?.some((source) => source.code === "invalid code")) {
          throw new Error("Script parsing failed");
        }
        if (!registrations.has(script.id)) throw new Error("Unknown registration");
        registrations.set(script.id, structuredClone(script));
      }
    }),
    unregister: vi.fn(async ({ ids }: { ids: string[] }) => {
      for (const id of ids) registrations.delete(id);
    }),
  };
  const browser = {
    userScripts: api as typeof api | undefined,
    tabs: {
      query: vi.fn(async () => [{ url: "https://example.com/articles/123?q=test#heading" }]),
    },
    permissions: {
      contains: vi.fn(async (permissions: { origins: string[] }) =>
        permissions.origins.every((origin) => origins.has(origin)),
      ),
      request: vi.fn(),
    },
  };
  vi.stubGlobal("chrome", browser);
  const manager = newManager();
  const save = (script: SaveUserScript) =>
    manager.handle({
      type: USERSCRIPTS_MESSAGE,
      method: "save",
      script,
    }) as Promise<UserScriptDetails>;
  const list = () =>
    manager.handle({ type: USERSCRIPTS_MESSAGE, method: "list" }) as Promise<UserScriptSummary[]>;
  const sync = () => manager.handle({ type: USERSCRIPTS_MESSAGE, method: "sync" });
  return { registrations, origins, api, browser, manager, save, list, sync };
}

const input: SaveUserScript = {
  name: "Hide sidebar",
  code: "(() => { document.querySelector('.sidebar')?.remove(); })();",
};

test("defaults to the active site and saves even without site access", async () => {
  const { save, registrations, browser, list } = harness();
  const script = await save(input);
  expect(script).toMatchObject({
    name: input.name,
    code: input.code,
    matches: ["https://example.com/*"],
    runAt: "document_idle",
    enabled: true,
    siteAccess: false,
    registered: false,
  });
  expect(await stored()).toMatchObject([{ id: script.id, code: input.code }]);
  expect(registrations.size).toBe(0);
  expect(browser.permissions.request).not.toHaveBeenCalled();
  const summaries = await list();
  expect(summaries[0]).not.toHaveProperty("code");
});

test("registers scoped code in an isolated world once it has site access", async () => {
  const { save, origins, registrations, sync, list } = harness();
  const script = await save({ ...input, matches: ["https://example.com/articles/*"] });
  origins.add("https://example.com/*");
  await sync();
  expect(registrations.get(script.id)).toEqual({
    id: script.id,
    matches: ["https://example.com/articles/*"],
    js: [{ code: input.code }],
    runAt: "document_idle",
    world: "USER_SCRIPT",
    allFrames: false,
  });
  expect(await list()).toMatchObject([{ id: script.id, registered: true, siteAccess: true }]);
});

test("updates a script by id while retaining its scope and disabled state", async () => {
  const { save, origins, browser, manager, registrations } = harness();
  origins.add("https://example.com/*");
  const first = await save({ ...input, runAt: "document_end" });
  await manager.handle({
    type: USERSCRIPTS_MESSAGE,
    method: "setEnabled",
    id: first.id,
    enabled: false,
  });
  browser.tabs.query.mockResolvedValue([{ url: "https://other.example/page" }]);
  const updated = await save({
    id: first.id,
    name: "Updated",
    code: "document.body.dataset.custom = 'yes';",
  });
  expect(updated).toMatchObject({
    id: first.id,
    name: "Updated",
    matches: first.matches,
    runAt: "document_end",
    enabled: false,
    createdAt: first.createdAt,
    registered: false,
  });
  expect(registrations.size).toBe(0);
  await manager.handle({
    type: USERSCRIPTS_MESSAGE,
    method: "setEnabled",
    id: first.id,
    enabled: true,
  });
  expect(registrations.get(first.id)?.js).toEqual([{ code: updated.code }]);
});

test("preserves a working saved script when Chrome rejects an edit", async () => {
  const { save, origins, registrations } = harness();
  origins.add("https://example.com/*");
  const original = await save(input);
  await expect(save({ ...input, id: original.id, code: "invalid code" })).rejects.toThrow(
    "Script parsing failed",
  );
  expect(registrations.get(original.id)?.js).toEqual([{ code: input.code }]);
  expect(await stored()).toMatchObject([{ id: original.id, code: input.code }]);
  // A rejected request must not poison the service worker's queue.
  expect((await save({ ...input, id: original.id, name: "Renamed" })).name).toBe("Renamed");
});

test("saves when the userscript toggle is off and restores after it becomes available", async () => {
  const { browser, api, save, origins, sync, list, registrations } = harness();
  origins.add("https://example.com/*");
  browser.userScripts = undefined;
  const saved = await save(input);
  expect(saved.registered).toBe(false);
  expect(saved.error).toContain("Allow user scripts");
  browser.userScripts = api;
  await sync();
  expect(registrations.has(saved.id)).toBe(true);
  expect(await list()).toMatchObject([{ id: saved.id, registered: true, error: undefined }]);
  api.getScripts.mockRejectedValueOnce(new Error("Access revoked"));
  expect(
    await newManager().handle({
      type: USERSCRIPTS_MESSAGE,
      method: "status",
    }),
  ).toMatchObject({ available: false });
});

test("restores saved registrations after extension updates without restoring disabled scripts", async () => {
  const { save, origins, registrations } = harness();
  origins.add("https://example.com/*");
  const enabled = await save(input);
  await save({ ...input, name: "Disabled", enabled: false });
  registrations.clear();
  const restarted = newManager();
  await restarted.handle({ type: USERSCRIPTS_MESSAGE, method: "sync" });
  expect([...registrations.keys()]).toEqual([enabled.id]);
});

test("removes registrations when site access is withheld or the plugin is off, then restores them", async () => {
  const { save, origins, sync, registrations } = harness();
  origins.add("https://example.com/*");
  const saved = await save(input);
  origins.clear();
  await sync();
  expect(registrations.has(saved.id)).toBe(false);
  origins.add("https://example.com/*");
  await sync();
  expect(registrations.has(saved.id)).toBe(true);
  pluginEnabled = false;
  await sync();
  expect(registrations.has(saved.id)).toBe(false);
  pluginEnabled = true;
  await sync();
  expect(registrations.has(saved.id)).toBe(true);
});

test("changing scope to an ungranted site unregisters the previous version", async () => {
  const { save, origins, registrations } = harness();
  origins.add("https://example.com/*");
  const original = await save(input);
  const updated = await save({ ...input, id: original.id, matches: ["https://other.example/*"] });
  expect(updated).toMatchObject({
    registered: false,
    siteAccess: false,
    matches: ["https://other.example/*"],
  });
  expect(registrations.has(original.id)).toBe(false);
});

test("concurrent creates do not lose scripts and deletion removes persistence and registration", async () => {
  const { save, origins, registrations, manager } = harness();
  origins.add("https://example.com/*");
  const [first, second] = await Promise.all([save(input), save({ ...input, name: "Second" })]);
  expect(await stored()).toHaveLength(2);
  await manager.handle({ type: USERSCRIPTS_MESSAGE, method: "remove", id: first.id });
  expect(registrations.has(first.id)).toBe(false);
  expect(registrations.has(second.id)).toBe(true);
  expect(await stored()).toMatchObject([{ id: second.id }]);
  await expect(
    manager.handle({ type: USERSCRIPTS_MESSAGE, method: "get", id: first.id }),
  ).rejects.toThrow("Unknown userscript");
});

test("synchronization isolates parse failures and leaves other plugins' scripts alone", async () => {
  const { save, origins, registrations, list, api } = harness();
  const broken = await save({ ...input, code: "invalid code" });
  const working = await save(input);
  registrations.set("another-plugin", {
    id: "another-plugin",
    matches: ["https://example.com/*"],
    js: [{ code: "" }],
  });
  registrations.set("relay-userscript-orphan", {
    id: "relay-userscript-orphan",
    js: [{ code: "" }],
  });
  origins.add("https://example.com/*");
  const summaries = await list();
  expect(summaries.find((script) => script.id === broken.id)).toMatchObject({
    registered: false,
    error: "Script parsing failed",
  });
  expect(summaries.find((script) => script.id === working.id)?.registered).toBe(true);
  expect(registrations.has("another-plugin")).toBe(true);
  expect(registrations.has("relay-userscript-orphan")).toBe(false);
  api.update.mockClear();
  await list();
  expect(api.update).not.toHaveBeenCalled();
});

test("rejects unsupported sites and invalid inputs without saving", async () => {
  const { save, browser } = harness();
  browser.tabs.query.mockResolvedValue([{ url: "chrome://settings" }]);
  await expect(save(input)).rejects.toThrow("regular HTTP(S) page");
  await expect(save({ ...input, matches: [] })).rejects.toThrow("at least one");
  await expect(save({ ...input, matches: ["<all_urls>"] })).rejects.toThrow("Invalid HTTP(S)");
  await expect(save({ ...input, id: "missing" })).rejects.toThrow("Unknown userscript");
  await expect(save({ ...input, name: " " })).rejects.toThrow("needs a name");
  await expect(save({ ...input, code: " " })).rejects.toThrow("JavaScript code");
  expect(await stored()).toEqual([]);
});

test("match scopes and permission origins treat paths, wildcards, and ports correctly", () => {
  expect(siteMatch("http://localhost:3000/page")).toBe("http://localhost/*");
  expect(
    permissionOrigins([
      "https://example.com/a/*",
      "https://example.com/b/*",
      "*://*.example.org/page*",
    ]),
  ).toEqual(["https://example.com/*", "*://*.example.org/*"]);
  expect(
    validateMatches(["https://example.com/*", "https://example.com/*", "*://*.example.org/*"]),
  ).toEqual(["https://example.com/*", "*://*.example.org/*"]);
  for (const pattern of [
    "file:///tmp/*",
    "https://example.com",
    "https://exa*mple.com/*",
    "https://example.com:3000/*",
    "https://user@example.com/*",
    "https://*./*",
  ]) {
    expect(() => validateMatches([pattern])).toThrow();
  }
});
