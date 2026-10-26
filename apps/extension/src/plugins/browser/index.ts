import { definePlugin } from "../../core/plugin.ts";
import { LIFELINE_PORT } from "./background.ts";
import { BROWSER_PROMPT } from "./prompt.ts";
import { AttachedTabs } from "./tabs.ts";
import { browserTools } from "./tools.ts";

/**
 * Browser control through scripts: instead of one model turn per action, the model writes a
 * script (pi's code mode, in the core) that calls these tools.
 */
export default definePlugin({
  id: "browser",
  name: "Browser scripting",
  description: "Lets the agent read and control your tabs from its scripts.",
  setup(relay) {
    // If the side panel closes mid-run, nothing in this page gets to detach the debugger, so
    // the service worker is told which tabs are attached and detaches them when the port drops.
    let lifeline: chrome.runtime.Port | undefined;
    let attached: number[] = [];
    const report = () => {
      if (!lifeline) {
        const port = chrome.runtime.connect({ name: LIFELINE_PORT });
        port.onDisconnect.addListener(() => {
          if (lifeline === port) lifeline = undefined;
        });
        lifeline = port;
      }
      lifeline.postMessage({ attached });
    };
    // An idle service worker is stopped after ~30s, which would drop the port and its record of
    // attached tabs. Re-reporting while tabs are attached keeps both alive.
    setInterval(() => {
      if (attached.length > 0) report();
    }, 20_000);

    const tabs = new AttachedTabs((tabIds) => {
      attached = tabIds;
      report();
    });
    window.addEventListener("pagehide", () => tabs.detachAll());

    for (const tool of browserTools(tabs)) relay.registerTool(tool);
    relay.registerPromptSection(BROWSER_PROMPT);

    relay.on("before_agent_start", async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;
      return { context: `Active tab: "${tab.title ?? ""}" at ${tab.url ?? "(unknown URL)"}` };
    });

    // Stop debugging tabs once the agent is idle so the browser's debugging banner goes away.
    relay.on("run_end", () => tabs.detachAll());
  },
});
