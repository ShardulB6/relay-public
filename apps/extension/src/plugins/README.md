# Relay plugins

A plugin gives the agent tools. Each plugin is a folder here whose `index.ts` default-exports it,
listed in `index.ts` next to this file. Plugins are bundled into the extension at build time;
nothing is loaded at runtime. To add one, create its folder, add it to the list, rebuild
(`vp build`, or keep `vp dev` running), and reload the extension. Plugins can be turned off in
settings.

```ts
// src/plugins/weather/index.ts
import { Type } from "@earendil-works/pi-ai";

import { definePlugin, defineTool } from "../../core/plugin.ts";

export default definePlugin({
  id: "weather",
  name: "Weather",
  setup(relay) {
    relay.registerTool(
      defineTool({
        name: "weather",
        description: "The forecast for a city.",
        parameters: Type.Object({ city: Type.String() }),
        execute: async ({ city }) => {
          const response = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3`);
          if (!response.ok) throw new Error(`No forecast for ${city}`);
          return response.text();
        },
      }),
    );
  },
});
```

A plugin's `id` is lowercase letters, digits, `-` and `_`, starting with a letter, and unique;
`relay` and `codemode` are taken by the core. Tool names are unique across all plugins and the
core. A plugin that breaks these rules or throws in `setup` is reported in settings and installs
nothing; the other plugins still load.

Browser control and userscripts are the built-in plugins, written against this same API. The core
is the agent with its code mode, model providers, settings and the chat view.

## What a plugin can do

| Call                                 | Purpose                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `relay.registerTool(tool)`           | Give the agent a tool.                                                  |
| `relay.registerPromptSection(text)`  | Add guidance to the system prompt, after the core's.                    |
| `relay.registerSettingsPage(render)` | Give the plugin a settings page (below).                                |
| `relay.on(event, handler)`           | Handle `before_agent_start` or `run_end` (below).                       |
| `relay.storage`                      | Storage private to the plugin: `get`, `set`, `delete`, `keys`, `watch`. |

## Tools

A tool is a function. `execute` gets the arguments, validated against `parameters` (a TypeBox
schema), an abort `signal`, and `files`: the files the user attached to the conversation, by
name (`files.get("resume.pdf")`). It returns the result, and throws to fail: the agent sees the
error's message.

- A string reaches the model as text, an image block (`{ type: "image", data, mimeType }`) as an
  image, and any other value as JSON.
- `callers` says who may call the tool: `"model"` directly, `"scripts"` the model writes, or both
  (the default). Scripts get the returned value itself; give its type as `returns` so the model
  knows what it gets back.

The model mostly works by writing scripts for the core's `codemode` tool, which call tools as
`await tools.<name>(args)`. A tool that is only useful in combination with others, like the
browser's `page_click`, should be `callers: ["scripts"]`, so one script can chain many calls.

## Settings

A plugin that keeps something for the user, like saved scripts, should let them see and manage
it. `registerSettingsPage(render)` gives the plugin a settings page, opened from a settings button
next to its toggle in the plugin list; a plugin without one has no button. `render` returns React
and is rendered as a component, so it can use hooks. Relay's UI components are in
`@/components/ui/*`. A page that throws shows an error in its place.

```tsx
relay.registerSettingsPage(() => <p className="text-sm">Forecasts come from wttr.in.</p>);
```

## Events

| Event                | Handler returns | Effect                                                |
| -------------------- | --------------- | ----------------------------------------------------- |
| `before_agent_start` | `{ context }`   | Tell the model something with the message being sent. |
| `run_end`            | nothing         | The agent finished working on the user's messages.    |

A handler that throws is reported to the user and does not stop the others.

## Background

Work that must happen while the side panel is closed goes in a `background.ts` next to
`index.ts`, listed in `background.ts` next to this file. It runs in the extension's service worker each time the worker starts, whether or not
the plugin is enabled, so check `relay.enabled()` before acting. Add `chrome.*` listeners
synchronously inside `setup`, so the event that woke the worker reaches them.

```ts
// src/plugins/weather/background.ts
import { defineBackgroundPlugin } from "../../core/plugin.ts";

export default defineBackgroundPlugin({
  id: "weather",
  setup(relay) {
    chrome.tabs.onCreated.addListener(async () => {
      if (!(await relay.enabled())) return;
      await relay.storage.set("lastTabOpenedAt", Date.now());
    });
  },
});
```

The background half gets `relay.enabled()`, `relay.onEnabledChange(callback)` for when the user
turns the plugin on or off, and the same `relay.storage` as the side-panel half. Use storage to
share state between them.

The built-in userscripts plugin (`userscripts/`) is a fuller example: its tools send
messages to its background half, which owns the saved scripts and Chrome's registrations.
