import type { RelayPlugin } from "../core/plugin.ts";
import browser from "./browser/index.ts";
import userscripts from "./userscripts/index.tsx";

/** Every plugin, in load order. A new plugin is added here. See README.md. */
export const plugins: RelayPlugin[] = [browser, userscripts];
