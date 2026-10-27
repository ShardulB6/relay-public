import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { storage } from "@wxt-dev/storage";

import { storageAtom } from "./storage.ts";

/** A conversation the user can return to. */
export interface HistoryEntry {
  id: ConversationId;
  title: string;
  /** When the user last sent a message in it, in milliseconds since the epoch. */
  updatedAt: number;
}

/**
 * Conversations the user has sent a message in, most recent first. pi-durable keeps the messages;
 * this is the index the conversation list shows.
 */
export const historyItem = storage.defineItem<HistoryEntry[]>("local:relay:history", {
  fallback: [],
});

export const historyAtom = storageAtom(historyItem);

const TITLE_LENGTH = 80;

const TITLE_PROMPT = `Write a short title for a conversation that starts with the user's message below.
Use at most six words, in the language of the message. Reply with the title only: no quotes, no punctuation at the end.`;

function clip(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : line;
}

/** A title from the first message, used until (or instead of) a generated one. */
export function fallbackTitle(text: string): string {
  return clip(text) || "New conversation";
}

/** The title in a model's reply, or `undefined` when it failed or wrote none. */
export function titleFromReply(reply: AssistantMessage): string | undefined {
  if (reply.stopReason === "error" || reply.stopReason === "aborted") return undefined;
  const text = reply.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim()
    .replace(/^["'“‘]+|["'”’.]+$/g, "");
  return clip(text) || undefined;
}

/** Ask `model` to title a conversation that starts with `text`. */
export async function generateTitle(
  models: Models,
  model: Model<Api>,
  text: string,
): Promise<string | undefined> {
  const reply = await models.completeSimple(model, {
    systemPrompt: TITLE_PROMPT,
    messages: [{ role: "user", content: text, timestamp: Date.now() }],
  });
  return titleFromReply(reply);
}
