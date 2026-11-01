import { Type, type Static } from "@earendil-works/pi-ai";

import { RUN_AT } from "./protocol.ts";

// The tools' schemas, kept out of protocol.ts so the service worker does not bundle TypeBox.

export const RunAtSchema = Type.Enum(RUN_AT, {
  description: "When the script runs on a page load. Default: document_idle.",
});

const ScriptFields = {
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  matches: Type.Array(Type.String()),
  runAt: RunAtSchema,
  enabled: Type.Boolean(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
};

/** A script as stored. */
const UserScriptSchema = Type.Object({ ...ScriptFields, code: Type.String() });

export const UserScriptSummarySchema = Type.Object({
  ...ScriptFields,
  registered: Type.Boolean({ description: "Whether Chrome runs it on matching page loads." }),
  siteAccess: Type.Boolean({
    description:
      "Whether the user let Relay run scripts on its sites, on the userscripts settings page.",
  }),
  error: Type.Optional(Type.String()),
});

export const UserScriptDetailsSchema = Type.Object({
  ...UserScriptSummarySchema.properties,
  code: Type.String(),
});

export const SaveUserScriptSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Omit to create a script." })),
  name: Type.String(),
  description: Type.Optional(Type.String()),
  code: Type.String({ description: "Plain browser JavaScript." }),
  matches: Type.Optional(
    Type.Array(Type.String(), {
      description: "HTTP(S) match patterns. Default for a new script: the active tab's site.",
    }),
  ),
  runAt: Type.Optional(RunAtSchema),
  enabled: Type.Optional(Type.Boolean({ description: "Default: true." })),
});

export const UserScriptsStatusSchema = Type.Object({
  available: Type.Boolean(),
  error: Type.Optional(Type.String()),
});

export type RunAt = Static<typeof RunAtSchema>;
export type UserScript = Static<typeof UserScriptSchema>;
export type UserScriptSummary = Static<typeof UserScriptSummarySchema>;
export type UserScriptDetails = Static<typeof UserScriptDetailsSchema>;
export type SaveUserScript = Static<typeof SaveUserScriptSchema>;
export type UserScriptsStatus = Static<typeof UserScriptsStatusSchema>;
