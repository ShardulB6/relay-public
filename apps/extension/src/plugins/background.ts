import type { BackgroundPlugin } from "../core/plugin.ts";
import browser from "./browser/background.ts";
import userscripts from "./userscripts/background.ts";

/** The background halves of the plugins that have one. See README.md. */
export const backgroundPlugins: BackgroundPlugin[] = [browser, userscripts];
