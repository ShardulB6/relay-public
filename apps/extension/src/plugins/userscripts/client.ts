import {
  USERSCRIPTS_MESSAGE,
  type SaveUserScript,
  type UserScriptDetails,
  type UserScriptSummary,
  type UserScriptsReply,
  type UserScriptsRequest,
  type UserScriptsStatus,
} from "./protocol.ts";

async function request<T>(message: UserScriptsRequest): Promise<T> {
  const reply: UserScriptsReply | undefined = await chrome.runtime.sendMessage(message);
  if (!reply)
    throw new Error("The userscript service did not respond. Reload Relay and try again.");
  if (!reply.ok) throw new Error(reply.error);
  return reply.value as T;
}

export const userscripts = {
  list: () => request<UserScriptSummary[]>({ type: USERSCRIPTS_MESSAGE, method: "list" }),
  status: () => request<UserScriptsStatus>({ type: USERSCRIPTS_MESSAGE, method: "status" }),
  sync: () => request<UserScriptsStatus>({ type: USERSCRIPTS_MESSAGE, method: "sync" }),
  get: (id: string) => request<UserScriptDetails>({ type: USERSCRIPTS_MESSAGE, method: "get", id }),
  save: (script: SaveUserScript) =>
    request<UserScriptDetails>({ type: USERSCRIPTS_MESSAGE, method: "save", script }),
  setEnabled: (id: string, enabled: boolean) =>
    request<UserScriptDetails>({ type: USERSCRIPTS_MESSAGE, method: "setEnabled", id, enabled }),
  remove: (id: string) =>
    request<{ removed: string; message: string }>({
      type: USERSCRIPTS_MESSAGE,
      method: "remove",
      id,
    }),
};
