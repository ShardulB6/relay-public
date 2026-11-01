import { Type, type TSchema } from "@earendil-works/pi-ai";

import { definePlugin, defineTool, type Tool } from "../../core/plugin.ts";
import { userscripts } from "./client.ts";
import { USERSCRIPTS_PROMPT } from "./prompt.ts";
import {
  SaveUserScriptSchema,
  UserScriptDetailsSchema,
  UserScriptsStatusSchema,
  UserScriptSummarySchema,
} from "./schemas.ts";
import { UserScriptsSettings } from "./settings.tsx";

/** Userscript tools are called from scripts, next to the browser tools that inspect the page. */
function scriptTool<P extends TSchema>(tool: Omit<Tool<P>, "callers">): Tool<P> {
  return defineTool({ ...tool, callers: ["scripts"] });
}

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
        returns: Type.Array(UserScriptSummarySchema),
        execute: () => userscripts.list(),
      }),
      scriptTool({
        name: "userscripts_get",
        description: "One userscript, with its code.",
        parameters: Id,
        returns: UserScriptDetailsSchema,
        execute: ({ id }) => userscripts.get(id),
      }),
      scriptTool({
        name: "userscripts_save",
        description: "Create a userscript, or update the one with the given id.",
        parameters: SaveUserScriptSchema,
        returns: UserScriptDetailsSchema,
        execute: (script) => userscripts.save(script),
      }),
      scriptTool({
        name: "userscripts_set_enabled",
        description: "Turn a userscript on or off.",
        parameters: Type.Object({ id: Type.String(), enabled: Type.Boolean() }),
        returns: UserScriptDetailsSchema,
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
        returns: UserScriptsStatusSchema,
        execute: () => userscripts.status(),
      }),
    ];
    for (const tool of tools) relay.registerTool(tool);
    relay.registerPromptSection(USERSCRIPTS_PROMPT);
    relay.registerSettingsPage(() => <UserScriptsSettings storage={relay.storage} />);
  },
});
