import { defineBackgroundPlugin } from "../../core/plugin.ts";

/** The side panel reports the tabs it is debugging over a port with this name. */
export const LIFELINE_PORT = "browser-lifeline";

// If the side panel closes while attached, nothing else would detach its tabs and the
// "started debugging this browser" banner would stay.
export default defineBackgroundPlugin({
  id: "browser",
  setup() {
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== LIFELINE_PORT) return;
      let attached: number[] = [];
      port.onMessage.addListener((message: { attached?: number[] }) => {
        attached = message.attached ?? [];
      });
      port.onDisconnect.addListener(() => {
        for (const tabId of attached) chrome.debugger.detach({ tabId }).catch(() => {});
      });
    });
  },
});
