import { defineManifest } from "@crxjs/vite-plugin";

import pkg from "./package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "Relay",
  description: "An extensible AI agent in your browser sidebar.",
  version: pkg.version,
  minimum_chrome_version: "140",
  icons: {
    16: "icons/16x16.png",
    32: "icons/32x32.png",
    48: "icons/48x48.png",
    128: "icons/128x128.png",
  },
  action: { default_title: "Open Relay" },
  background: { service_worker: "src/background.ts", type: "module" },
  side_panel: { default_path: "sidepanel.html" },
  // SQLite (conversation storage) and QuickJS (the agent's scripts) are WebAssembly. Images and
  // media load only from the extension or inline data: the model's replies are untrusted, and a
  // remote image in one would carry whatever its URL holds to its server.
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:",
  },
  permissions: ["sidePanel", "debugger", "tabs", "storage", "unlimitedStorage", "userScripts"],
  // Model providers. Granted hosts are exempt from CORS, so a response without CORS headers (an
  // edge challenge or error page) reaches the provider code with its status instead of failing
  // as a bare "Connection error".
  host_permissions: [
    "https://api.openai.com/*",
    "https://auth.openai.com/*",
    "https://openrouter.ai/*",
  ],
  // Userscripts run only on sites the user grants, one at a time, in settings.
  optional_host_permissions: ["http://*/*", "https://*/*"],
});
