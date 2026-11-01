import { errorMessage } from "../../core/errors.ts";
import { defineBackgroundPlugin } from "../../core/plugin.ts";
import { UserScriptManager } from "./manager.ts";
import { USERSCRIPTS_MESSAGE, type UserScriptsRequest } from "./protocol.ts";

// Chrome runs registered userscripts on future visits even when Relay's side panel is closed, so
// the service worker owns them: it saves scripts and keeps Chrome's registrations in step.
export default defineBackgroundPlugin({
  id: "userscripts",
  setup(relay) {
    const manager = new UserScriptManager({
      storage: relay.storage,
      enabled: () => relay.enabled(),
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type !== USERSCRIPTS_MESSAGE) return;
      // User scripts and web pages must never reach this management API.
      if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
        sendResponse({ ok: false, error: "Userscripts can only be managed from Relay." });
        return;
      }
      manager.handle(message as UserScriptsRequest).then(
        (value) => sendResponse({ ok: true, value }),
        (error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }),
      );
      return true;
    });

    // Registrations are reconciled whenever the worker starts (which covers install, update and
    // browser startup) and whenever site access or the plugin's enabled state changes.
    const sync = () => {
      void manager.handle({ type: USERSCRIPTS_MESSAGE, method: "sync" }).catch(console.error);
    };
    chrome.permissions.onAdded.addListener(sync);
    chrome.permissions.onRemoved.addListener(sync);
    relay.onEnabledChange(sync);
    sync();
  },
});
