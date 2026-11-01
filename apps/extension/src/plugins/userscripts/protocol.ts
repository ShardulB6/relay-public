import type { SaveUserScript } from "./schemas.ts";

export type {
  RunAt,
  SaveUserScript,
  UserScript,
  UserScriptDetails,
  UserScriptsStatus,
  UserScriptSummary,
} from "./schemas.ts";

export const USERSCRIPTS_MESSAGE = "relay-userscripts";

/** The plugin storage key holding every saved script. Written only by the service worker. */
export const SCRIPTS_KEY = "scripts";

export const RUN_AT = ["document_start", "document_end", "document_idle"] as const;

export type UserScriptsRequest =
  | { type: typeof USERSCRIPTS_MESSAGE; method: "list" | "status" | "sync" }
  | { type: typeof USERSCRIPTS_MESSAGE; method: "get" | "remove"; id: string }
  | { type: typeof USERSCRIPTS_MESSAGE; method: "save"; script: SaveUserScript }
  | { type: typeof USERSCRIPTS_MESSAGE; method: "setEnabled"; id: string; enabled: boolean };

export type UserScriptsReply = { ok: true; value: unknown } | { ok: false; error: string };
