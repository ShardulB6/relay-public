import { Type, type TSchema } from "@earendil-works/pi-ai";

import { definePlugin, defineTool, type Tool } from "../../core/plugin.ts";
import { userscripts } from "./client.ts";
import { USERSCRIPTS_PROMPT } from "./prompt.ts";
import { UserScriptsSettings } from "./settings.tsx";

/** Userscript tools are called from scripts, next to the browser tools that inspect the page. */
function scriptTool<P extends TSchema>(tool: Omit<Tool<P>, "callers">): Tool<P> {
  return defineTool({ ...tool, callers: ["scripts"] });
}

const RunAt = Type.Union(
  [Type.Literal("document_start"), Type.Literal("document_end"), Type.Literal("document_idle")],
  { description: "When the script runs on a page load. Default: document_idle." },
);
const Summary = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  matches: Type.Array(Type.String()),
  runAt: RunAt,
  enabled: Type.Boolean(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  registered: Type.Boolean({ description: "Whether Chrome runs it on matching page loads." }),
  siteAccess: Type.Boolean({
    description:
      "Whether the user let Relay run scripts on its sites, on the userscripts settings page.",
  }),
  error: Type.Optional(Type.String()),
});
const Details = Type.Object({ ...Summary.properties, code: Type.String() });
const Id = Type.Object({ id: Type.String() });

export default definePlugin({
  id: "userscripts",
  name: "Userscripts",
  description: "Lets the agent save scripts that customize the sites you visit.",
  setup(relay) {
    const tools = [
      scriptTool({
        name: "userscripts_list",
        description: "Every saved userscript, without its code.",
        parameters: Type.Object({}),
        returns: Type.Array(Summary),
        execute: () => userscripts.list(),
      }),
      scriptTool({
        name: "userscripts_get",
        description: "One userscript, with its code.",
        parameters: Id,
        returns: Details,
        execute: ({ id }) => userscripts.get(id),
      }),
      scriptTool({
        name: "userscripts_save",
        description: "Create a userscript, or update the one with the given id.",
        parameters: Type.Object({
          id: Type.Optional(Type.String({ description: "Omit to create a script." })),
          name: Type.String(),
          description: Type.Optional(Type.String()),
          code: Type.String({ description: "Plain browser JavaScript." }),
          matches: Type.Optional(
            Type.Array(Type.String(), {
              description:
                "HTTP(S) match patterns. Default for a new script: the active tab's site.",
            }),
          ),
          runAt: Type.Optional(RunAt),
          enabled: Type.Optional(Type.Boolean({ description: "Default: true." })),
        }),
        returns: Details,
        execute: (script) => userscripts.save(script),
      }),
      scriptTool({
        name: "userscripts_set_enabled",
        description: "Turn a userscript on or off.",
        parameters: Type.Object({ id: Type.String(), enabled: Type.Boolean() }),
        returns: Details,
        execute: ({ id, enabled }) => userscripts.setEnabled(id, enabled),
      }),
      scriptTool({
        name: "userscripts_remove",
        description: "Delete a userscript.",
        parameters: Id,
        returns: Type.Object({ removed: Type.String(), message: Type.String() }),
        execute: ({ id }) => userscripts.remove(id),
      }),
      scriptTool({
        name: "userscripts_status",
        description: "Whether Chrome lets Relay run userscripts.",
        parameters: Type.Object({}),
        returns: Type.Object({ available: Type.Boolean(), error: Type.Optional(Type.String()) }),
        execute: () => userscripts.status(),
      }),
    ];
    for (const tool of tools) relay.registerTool(tool);
    relay.registerPromptSection(USERSCRIPTS_PROMPT);
    relay.registerSettingsPage(() => <UserScriptsSettings storage={relay.storage} />);
  },
});
