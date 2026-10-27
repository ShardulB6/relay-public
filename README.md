# Relay

An AI agent in your browser's sidebar, built to be extended. Relay follows the design of
[pi](https://pi.dev): a small core, and everything else as plugins.

- **Code mode.** The agent works mainly through one tool, `codemode`. It writes scripts that call
  plugin tools, such as the browser's `tools.page_click(...)` and `tools.tabs_open(...)`, so one
  call can chain many actions instead of one model turn per click.
- **The agent runs in the side panel**, on pi's `pi-durable` and `pi-ai` packages. Conversations
  are stored in SQLite in the extension's private file system, and a run the side panel closed
  during continues when it reopens. Relay runs in one side panel at a time.
- **Plugins** add tools, system prompt text, a settings page, and handlers for when a message is
  sent and when the agent finishes, plus background work in the service worker. Browser control
  and userscripts are plugins too; the core is the durable agent with its code mode, model
  providers, settings and the chat view.

```text
┌──────────────── Chromium browser ─────────────────┐
│ side panel (extension page)                       │
│   agent loop · plugins · credentials · UI ────────┼──▶ provider APIs
│   script interpreter → tools → Puppeteer          │
│        │ CDP through chrome.debugger              │
│        ▼                                          │
│   your tabs                                       │
└───────────────────────────────────────────────────┘
```

## Layout

| Path                         | What                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `apps/extension`             | The MV3 extension: side panel (React with shadcn/ui). Vite+ with CRXJS.                    |
| `apps/extension/src/plugins` | The plugins, bundled at build time. See [README.md](apps/extension/src/plugins/README.md). |

## Getting started

Requirements: Node, pnpm, and a Chromium-family browser (Chrome 138 or newer).

```bash
pnpm install
pnpm build        # builds the extension into apps/extension/dist
```

1. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked** and select
   `apps/extension/dist`.
2. Click the Relay toolbar button to open the side panel.
3. Open **Settings** and connect a provider. Then pick a model below the message box and start asking.
   With a model that accepts images, paste, drop or attach PNG, JPEG, GIF or WebP files to
   send them along with your message. Large images are downscaled before sending.
4. The clock button in the header lists past conversations: search, reopen, rename or delete
   them. Each is named after its first message, or by the **Title model** chosen in settings,
   which offers only models your connected providers serve. Deleting removes a conversation
   from the list; pi-durable cannot delete it, so its messages stay in the local database.

| Command      | Does                                                                         |
| ------------ | ---------------------------------------------------------------------------- |
| `pnpm dev`   | Rebuilds the extension on every change. Reload the side panel to pick it up. |
| `pnpm build` | Production build of the extension.                                           |
| `pnpm check` | Format, lint and type-check (`vp check`).                                    |
| `pnpm test`  | Unit tests (`vp test`).                                                      |

GitHub Actions runs CI on pull requests and pushes to `main`. Feature branch pushes
are checked through their pull request, so they do not trigger a second CI run.
It checks formatting, lint and types, runs unit tests, and builds the extension.

To publish a release, set the new `version` in `apps/extension/package.json` (the extension
manifest uses it) and merge that to `main`. Then open **Actions → Release → Run workflow**. It
builds the extension and publishes a GitHub release tagged `v<version>` with the extension ZIP
attached and the pull requests merged since the previous release listed in its notes. It fails
if that version is already released. Releases are immutable once published, so a broken release
is fixed by releasing a new version.

## Providers

Credentials are stored in the extension's local storage, per browser profile.

| Provider   | How to connect                                                                          |
| ---------- | --------------------------------------------------------------------------------------- |
| OpenAI     | API key, or **Sign in with ChatGPT** to use a ChatGPT subscription (Codex models only). |
| OpenRouter | API key.                                                                                |

Relay calls both directly from the side panel.

Providers are part of the core, not plugins: Relay registers pi-ai's factories for the ones it
supports.

## How browser control works

Chrome extension pages may not evaluate strings as code, so Relay does not run model-written
scripts with `eval`. pi-durable's code mode runs them in QuickJS compiled to WebAssembly instead,
whose only way out is the `tools.*` functions the host provides, plus `text()`, `image()` and
`console.log()` to report back. Values cross that boundary as JSON, and tool inputs are validated
against their schemas.

The browser tools run in the side panel on `puppeteer-core`, connected to each tab through
`chrome.debugger`: `tools.tabs_*` lists and opens tabs, and `tools.page_*` takes a text
`page_snapshot()` whose refs (`e12`) other tools target, clicks, fills, presses keys, evaluates an
expression in the page, waits, and takes screenshots. The model sees signatures generated from
the tool schemas, next to the guidance in [`src/plugins/browser/prompt.ts`](apps/extension/src/plugins/browser/prompt.ts).

A script can do only what those tools allow, so it cannot read your stored credentials. While
the agent works, Chrome shows its "started debugging this browser" banner; Relay detaches when
the agent is idle.

## Userscripts

Ask Relay to change a site for good ("always hide the sidebar on example.com") and the
userscripts plugin saves a script that Chrome runs on every matching page load, Tampermonkey-style,
even with the side panel closed. Scripts run in Chrome's isolated `USER_SCRIPT` world, not with
Relay's own access, and only on HTTP(S) sites.

In settings, the settings button next to the Userscripts plugin opens a page listing every saved
script, where it runs and whether it is running, and lets you edit, disable or delete it. A script runs only once you allow its site there; Relay asks
for no site access at install. Chrome also requires **Allow User Scripts** to be on in Relay's
details on `chrome://extensions`. Until both are done the agent can still save scripts, and tells
you they are not running yet.

## Security notes

Relay acts in your real browser with your logged-in sessions. Treat it like handing someone your
keyboard:

- The agent is told to ask before purchases, sending messages, or deleting data, and to ignore
  instructions found in web pages. Those are instructions to a model, not guarantees; a hard
  rule belongs in the tool itself, which can throw instead of acting.
- API keys and tokens are stored unencrypted in extension storage.
- Saved userscripts run on every matching page load until disabled, with the same access to the
  page as the page's own scripts.
