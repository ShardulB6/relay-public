import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { storage } from "@wxt-dev/storage";
import { atom } from "jotai";

import { storageAtom } from "./storage.ts";

export interface Settings {
  model?: { provider: string; id: string };
  /** Names new conversations from their first message; without it, the message itself is used. */
  titleModel?: { provider: string; id: string };
  thinkingLevel: ModelThinkingLevel;
  /** Plugin ids that should not be loaded. Takes effect on reload. */
  disabledPlugins: string[];
}

export const settingsItem = storage.defineItem<Settings>("local:relay:settings", {
  fallback: {
    thinkingLevel: "medium",
    disabledPlugins: [],
  },
});

export const settingsAtom = storageAtom(settingsItem);

/** Merge a patch into the settings. */
export const updateSettingsAtom = atom(null, (get, set, patch: Partial<Settings>) =>
  set(settingsAtom, { ...get(settingsAtom), ...patch }),
);
