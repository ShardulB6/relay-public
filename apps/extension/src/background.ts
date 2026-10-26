import { settingsItem, type Settings } from "./core/settings.ts";
import { chromeStore } from "./core/storage.ts";
import { backgroundPlugins } from "./plugins/background.ts";

// The agent lives in the side panel; the service worker opens it and runs plugins' background
// halves.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// Set up synchronously, so listeners exist before the event that woke the worker is dispatched.
for (const plugin of backgroundPlugins) {
  const isEnabled = (settings: Settings) => !settings.disabledPlugins.includes(plugin.id);
  try {
    plugin.setup({
      enabled: async () => isEnabled(await settingsItem.getValue()),
      onEnabledChange: (callback) =>
        void settingsItem.watch((next, previous) => {
          if (isEnabled(next) !== isEnabled(previous)) callback(isEnabled(next));
        }),
      storage: chromeStore(`plugin:${plugin.id}`),
    });
  } catch (error) {
    console.error(`[relay] background of plugin "${plugin.id}" failed to load`, error);
  }
}
