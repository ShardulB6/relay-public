import { errorMessage } from "../../core/errors.ts";
import type { KeyValueStore } from "../../core/storage.ts";
import {
  RUN_AT,
  SCRIPTS_KEY,
  type SaveUserScript,
  type UserScript,
  type UserScriptDetails,
  type UserScriptSummary,
  type UserScriptsRequest,
  type UserScriptsStatus,
} from "./protocol.ts";

const ID_PREFIX = "relay-userscript-";

type Registration = chrome.userScripts.RegisteredUserScript;

interface RegisteredState {
  status: UserScriptsStatus;
  scripts: Registration[];
}

export const USER_SCRIPTS_SETUP =
  'Enable "Allow user scripts" in Relay’s extension details (chrome://extensions), then reload Relay.';

export interface ManagerDependencies {
  /** The plugin's storage, where scripts are saved. */
  storage: KeyValueStore;
  /** Whether the plugin is enabled; a disabled plugin's scripts are unregistered. */
  enabled(): Promise<boolean>;
}

/** Only HTTP(S) match patterns are accepted; `<all_urls>` and other schemes are rejected. */
export function validateMatches(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Provide at least one HTTP(S) match pattern.");
  }
  for (const pattern of value) {
    if (typeof pattern !== "string") throw new Error("Match patterns must be strings.");
    const match = /^(https?|\*):\/\/([^/]+)(\/.*)$/.exec(pattern);
    if (!match) throw new Error(`Invalid HTTP(S) match pattern: ${pattern}`);
    const host = match[2]!;
    const domain = host.startsWith("*.") ? host.slice(2) : host;
    if (
      domain !== "*" &&
      (!domain || /[^a-zA-Z0-9.-]/.test(domain) || domain.includes("..") || domain.includes("*"))
    ) {
      throw new Error(`Invalid match-pattern host: ${host}`);
    }
  }
  return [...new Set(value as string[])];
}

export function siteMatch(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Open a regular HTTP(S) page before creating a userscript.");
  }
  return validateMatches([`${parsed.protocol}//${parsed.hostname}/*`])[0]!;
}

/** Host permissions apply to the whole origin, independently of the script's path scope. */
export function permissionOrigins(matches: readonly string[]): string[] {
  return [
    ...new Set(
      matches.map(
        (pattern) => pattern.slice(0, pattern.indexOf("/", pattern.indexOf("://") + 3)) + "/*",
      ),
    ),
  ];
}

function registration(script: UserScript): Registration {
  return {
    id: script.id,
    matches: script.matches,
    js: [{ code: script.code }],
    runAt: script.runAt,
    world: "USER_SCRIPT",
    allFrames: false,
  };
}

function sameRegistration(a: Registration, b: Registration): boolean {
  return (
    JSON.stringify(a.js) === JSON.stringify(b.js) &&
    JSON.stringify(a.matches) === JSON.stringify(b.matches) &&
    a.runAt === b.runAt &&
    a.world === b.world &&
    a.allFrames === b.allFrames
  );
}

/** All reads and writes run in the service worker, serialized across side panels. */
export class UserScriptManager {
  #queue: Promise<unknown> = Promise.resolve();
  #errors = new Map<string, string>();
  #deps: ManagerDependencies;

  constructor(deps: ManagerDependencies) {
    this.#deps = deps;
  }

  handle(request: UserScriptsRequest): Promise<unknown> {
    const task = this.#queue.then(() => this.#handle(request));
    this.#queue = task.catch(() => {});
    return task;
  }

  async #scripts(): Promise<UserScript[]> {
    return (await this.#deps.storage.get<UserScript[]>(SCRIPTS_KEY)) ?? [];
  }

  #store(scripts: UserScript[]): Promise<void> {
    return this.#deps.storage.set(SCRIPTS_KEY, scripts);
  }

  async #registered(): Promise<RegisteredState> {
    try {
      const scripts = await chrome.userScripts.getScripts();
      return { status: { available: true }, scripts };
    } catch {
      return { status: { available: false, error: USER_SCRIPTS_SETUP }, scripts: [] };
    }
  }

  #hasAccess(script: UserScript): Promise<boolean> {
    return chrome.permissions.contains({ origins: permissionOrigins(script.matches) });
  }

  async #shouldRun(script: UserScript, pluginEnabled: boolean): Promise<boolean> {
    return pluginEnabled && script.enabled && (await this.#hasAccess(script));
  }

  /** Register `script` with Chrome, or update it if the registration differs. Throws on bad code. */
  async #apply(script: UserScript, registered: readonly Registration[]): Promise<void> {
    const current = registered.find((item) => item.id === script.id);
    const next = registration(script);
    if (!current) await chrome.userScripts.register([next]);
    else if (!sameRegistration(current, next)) await chrome.userScripts.update([next]);
  }

  async #summary(script: UserScript, registered: RegisteredState): Promise<UserScriptSummary> {
    const { code: _code, ...summary } = script;
    return {
      ...summary,
      registered: registered.scripts.some((item) => item.id === script.id),
      siteAccess: await this.#hasAccess(script),
      error: this.#errors.get(script.id) ?? registered.status.error,
    };
  }

  async #details(script: UserScript, registered: RegisteredState): Promise<UserScriptDetails> {
    return { ...(await this.#summary(script, registered)), code: script.code };
  }

  /** Make Chrome's registrations match the saved scripts; returns the state afterwards. */
  async #sync(): Promise<RegisteredState> {
    const registered = await this.#registered();
    if (!registered.status.available) return registered;
    const pluginEnabled = await this.#deps.enabled();
    const desired: UserScript[] = [];
    for (const script of await this.#scripts()) {
      if (await this.#shouldRun(script, pluginEnabled)) desired.push(script);
    }
    const remove = registered.scripts
      .filter((item) => item.id.startsWith(ID_PREFIX) && !desired.some((s) => s.id === item.id))
      .map((item) => item.id);
    if (remove.length) await chrome.userScripts.unregister({ ids: remove });
    for (const script of desired) {
      try {
        await this.#apply(script, registered.scripts);
        this.#errors.delete(script.id);
      } catch (error) {
        this.#errors.set(script.id, errorMessage(error));
      }
    }
    return this.#registered();
  }

  async #save(input: SaveUserScript): Promise<UserScriptDetails> {
    if (!input || typeof input.name !== "string" || !input.name.trim()) {
      throw new Error("A userscript needs a name.");
    }
    if (typeof input.code !== "string" || !input.code.trim()) {
      throw new Error("A userscript needs JavaScript code.");
    }
    if (input.description !== undefined && typeof input.description !== "string") {
      throw new Error("The description must be a string.");
    }
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw new Error("enabled must be a boolean.");
    }
    if (input.runAt !== undefined && !RUN_AT.includes(input.runAt)) {
      throw new Error("runAt must be document_start, document_end, or document_idle.");
    }
    const scripts = await this.#scripts();
    const previous = input.id === undefined ? undefined : scripts.find((s) => s.id === input.id);
    if (input.id !== undefined && !previous) throw new Error(`Unknown userscript: ${input.id}`);
    let matches = input.matches ?? previous?.matches;
    if (matches === undefined) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      matches = [siteMatch(tab?.url ?? "")];
    }
    const now = Date.now();
    const script: UserScript = {
      id: previous?.id ?? `${ID_PREFIX}${crypto.randomUUID()}`,
      name: input.name.trim(),
      description: input.description ?? previous?.description ?? "",
      code: input.code,
      matches: validateMatches(matches),
      runAt: input.runAt ?? previous?.runAt ?? "document_idle",
      enabled: input.enabled ?? previous?.enabled ?? true,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    // Let Chrome parse the code before replacing a working saved script whenever possible.
    const registered = await this.#registered();
    if (
      registered.status.available &&
      (await this.#shouldRun(script, await this.#deps.enabled()))
    ) {
      await this.#apply(script, registered.scripts);
    }
    await this.#store(
      previous ? scripts.map((s) => (s.id === script.id ? script : s)) : [...scripts, script],
    );
    this.#errors.delete(script.id);
    // Sync drops the registration of a script that is now disabled or out of scope.
    return this.#details(script, await this.#sync());
  }

  async #find(id: string): Promise<UserScript> {
    const script = (await this.#scripts()).find((s) => s.id === id);
    if (!script) throw new Error(`Unknown userscript: ${id}`);
    return script;
  }

  async #handle(request: UserScriptsRequest): Promise<unknown> {
    switch (request.method) {
      case "status":
        return (await this.#registered()).status;
      case "sync":
        return (await this.#sync()).status;
      case "list": {
        const registered = await this.#sync();
        return Promise.all(
          (await this.#scripts()).map((script) => this.#summary(script, registered)),
        );
      }
      case "get":
        return this.#details(await this.#find(request.id), await this.#registered());
      case "save":
        return this.#save(request.script);
      case "setEnabled": {
        if (typeof request.enabled !== "boolean") throw new Error("enabled must be a boolean.");
        return this.#save({ ...(await this.#find(request.id)), enabled: request.enabled });
      }
      case "remove": {
        const scripts = await this.#scripts();
        if (!scripts.some((script) => script.id === request.id)) {
          throw new Error(`Unknown userscript: ${request.id}`);
        }
        const registered = await this.#registered();
        if (registered.scripts.some((script) => script.id === request.id)) {
          await chrome.userScripts.unregister({ ids: [request.id] });
        }
        await this.#store(scripts.filter((script) => script.id !== request.id));
        this.#errors.delete(request.id);
        return {
          removed: request.id,
          message: "Reload affected tabs to clear changes already applied.",
        };
      }
      default:
        throw new Error("Unknown userscript method.");
    }
  }
}
