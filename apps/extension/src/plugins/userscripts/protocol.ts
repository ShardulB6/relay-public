export const USERSCRIPTS_MESSAGE = "relay-userscripts";

/** The plugin storage key holding every saved script. Written only by the service worker. */
export const SCRIPTS_KEY = "scripts";

export type RunAt = "document_start" | "document_end" | "document_idle";

export interface UserScript {
  id: string;
  name: string;
  description: string;
  code: string;
  matches: string[];
  runAt: RunAt;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SaveUserScript {
  /** Omit to create a script; supply an existing id to update it. */
  id?: string;
  name: string;
  description?: string;
  code: string;
  /** Defaults to the active tab's site for a new script. */
  matches?: readonly string[];
  runAt?: RunAt;
  enabled?: boolean;
}

export interface UserScriptsStatus {
  available: boolean;
  error?: string;
}

export interface UserScriptSummary extends Omit<UserScript, "code"> {
  registered: boolean;
  siteAccess: boolean;
  error?: string;
}

export type UserScriptDetails = UserScriptSummary & Pick<UserScript, "code">;

export type UserScriptsRequest =
  | { type: typeof USERSCRIPTS_MESSAGE; method: "list" | "status" | "sync" }
  | { type: typeof USERSCRIPTS_MESSAGE; method: "get" | "remove"; id: string }
  | { type: typeof USERSCRIPTS_MESSAGE; method: "save"; script: SaveUserScript }
  | { type: typeof USERSCRIPTS_MESSAGE; method: "setEnabled"; id: string; enabled: boolean };

export type UserScriptsReply = { ok: true; value: unknown } | { ok: false; error: string };
