import { createStore } from "jotai";
import { expect, test, vi } from "vite-plus/test";

import { settingsAtom, settingsItem, updateSettingsAtom } from "./settings.ts";
import { chromeStore } from "./storage.ts";

test("settings written in one side panel reach another", async () => {
  await settingsItem.setValue({ ...settingsItem.fallback, thinkingLevel: "high" });
  const first = createStore();
  const second = createStore();
  await first.set(settingsAtom.sync);
  const unwatch = await second.set(settingsAtom.sync);
  expect(second.get(settingsAtom).thinkingLevel).toBe("high");

  const changed = vi.fn();
  second.sub(settingsAtom, changed);
  const write = first.set(updateSettingsAtom, { disabledPlugins: ["notes"] });
  // The writer sees its change at once, before storage has it.
  expect(first.get(settingsAtom).disabledPlugins).toEqual(["notes"]);
  await write;
  expect(second.get(settingsAtom)).toMatchObject({
    disabledPlugins: ["notes"],
    thinkingLevel: "high",
  });
  expect(changed).toHaveBeenCalled();

  unwatch();
  await first.set(updateSettingsAtom, { disabledPlugins: [] });
  expect(second.get(settingsAtom).disabledPlugins).toEqual(["notes"]);
});

test("namespaced stores list and watch only their own keys", async () => {
  const notes = chromeStore("plugin:notes");
  const other = chromeStore("plugin:other");
  const seen: unknown[] = [];
  const unwatch = notes.watch("list", (value) => seen.push(value));

  await notes.set("list", ["a"]);
  await other.set("list", ["b"]);
  await notes.set("draft", "c");
  expect((await notes.keys()).toSorted()).toEqual(["draft", "list"]);
  expect(await notes.get("list")).toEqual(["a"]);

  await notes.delete("list");
  expect(await notes.get("list")).toBeUndefined();
  expect(seen).toEqual([["a"], undefined]);
  unwatch();
});
