import { afterEach, expect, test, vi } from "vite-plus/test";

import { settingsItem } from "../../core/settings.ts";
import { chromeStore } from "../../core/storage.ts";
import { SCRIPTS_KEY, type UserScript, type UserScriptsRequest } from "./protocol.ts";

afterEach(() => vi.unstubAllGlobals());

const stored = async () =>
  (await chromeStore("plugin:userscripts").get<UserScript[]>(SCRIPTS_KEY)) ?? [];

async function backgroundHarness() {
  vi.resetModules();
  const registrations = new Map<string, chrome.userScripts.RegisteredUserScript>();
  let listener: (
    request: UserScriptsRequest,
    sender: chrome.runtime.MessageSender,
    respond: (value: unknown) => void,
  ) => boolean | undefined;
  const event = () => ({ addListener: vi.fn<(event: (...args: unknown[]) => void) => void>() });
  const sender = { id: "relay-test", url: "chrome-extension://relay-test/sidepanel.html" };
  const browser = {
    sidePanel: { setPanelBehavior: vi.fn(async () => {}) },
    runtime: {
      id: sender.id,
      getURL: (path: string) => `chrome-extension://relay-test/${path}`,
      onConnect: event(),
      onMessage: {
        addListener: vi.fn((next: typeof listener) => {
          listener = next;
        }),
      },
      sendMessage: vi.fn(
        (request: UserScriptsRequest) =>
          new Promise((resolve) => listener(request, sender, resolve)),
      ),
    },
    userScripts: {
      getScripts: vi.fn(async () => structuredClone([...registrations.values()])),
      register: vi.fn(async (scripts: chrome.userScripts.RegisteredUserScript[]) => {
        for (const script of scripts) registrations.set(script.id, structuredClone(script));
      }),
      update: vi.fn(async (scripts: chrome.userScripts.RegisteredUserScript[]) => {
        for (const script of scripts) registrations.set(script.id, structuredClone(script));
      }),
      unregister: vi.fn(async ({ ids }: { ids: string[] }) => {
        for (const id of ids) registrations.delete(id);
      }),
    },
    permissions: { contains: vi.fn(async () => true), onAdded: event(), onRemoved: event() },
    tabs: { query: vi.fn(async () => [{ url: "https://example.com/current-page" }]) },
  };
  vi.stubGlobal("chrome", browser);
  await import("../../background.ts");
  const { userscripts } = await import("./client.ts");
  return { userscripts, registrations, sender, browser };
}

test("the LLM's client API reaches background storage and native script registrations", async () => {
  const { userscripts, registrations, browser } = await backgroundHarness();
  const script = await userscripts.save({
    name: "Page customization",
    code: "document.body.dataset.relay = 'yes';",
  });
  expect(script).toMatchObject({
    registered: true,
    siteAccess: true,
    matches: ["https://example.com/*"],
  });
  expect(await stored()).toMatchObject([{ id: script.id, code: script.code }]);
  expect((await userscripts.get(script.id)).code).toBe(script.code);
  expect(await userscripts.list()).toMatchObject([{ id: script.id, registered: true }]);
  // A fresh worker start (install, update, browser launch) restores lost registrations.
  registrations.clear();
  await userscripts.sync();
  expect(registrations.has(script.id)).toBe(true);
  browser.permissions.contains.mockResolvedValue(false);
  browser.permissions.onRemoved.addListener.mock.calls[0]![0]();
  await userscripts.status();
  expect(registrations.size).toBe(0);
  browser.permissions.contains.mockResolvedValue(true);
  browser.permissions.onAdded.addListener.mock.calls[0]![0]();
  await userscripts.status();
  expect(registrations.has(script.id)).toBe(true);
  await userscripts.setEnabled(script.id, false);
  expect(registrations.size).toBe(0);
  expect((await stored())[0]?.enabled).toBe(false);
  await userscripts.setEnabled(script.id, true);
  expect(registrations.has(script.id)).toBe(true);
  await userscripts.remove(script.id);
  expect(await stored()).toEqual([]);
  expect(registrations.size).toBe(0);
});

test("the background management endpoint refuses web pages and other extensions", async () => {
  const { userscripts, sender, browser } = await backgroundHarness();
  sender.url = "https://example.com/";
  await expect(userscripts.save({ name: "Untrusted", code: "alert('test')" })).rejects.toThrow(
    "only be managed from Relay",
  );
  sender.url = "chrome-extension://other-extension/page.html";
  sender.id = "other-extension";
  await expect(userscripts.list()).rejects.toThrow("only be managed from Relay");
  expect(await stored()).toEqual([]);
  // Unrelated extension messages must be left for other listeners.
  const callback = browser.runtime.onMessage.addListener.mock.calls[0]![0];
  const respond = vi.fn();
  expect(
    callback(
      { type: "unrelated", method: "list" } as unknown as UserScriptsRequest,
      sender,
      respond,
    ),
  ).toBeUndefined();
  expect(respond).not.toHaveBeenCalled();
});

test("turning the plugin off in settings unregisters its scripts until it is back on", async () => {
  const { userscripts, registrations } = await backgroundHarness();
  const script = await userscripts.save({ name: "Customization", code: "void 0;" });
  expect(registrations.has(script.id)).toBe(true);
  await settingsItem.setValue({ ...settingsItem.fallback, disabledPlugins: ["userscripts"] });
  await vi.waitFor(() => expect(registrations.size).toBe(0));
  await settingsItem.setValue(settingsItem.fallback);
  await vi.waitFor(() => expect(registrations.has(script.id)).toBe(true));
});
