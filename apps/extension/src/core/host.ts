import {
  defineExtension,
  section,
  type AgentEvent,
  type Extension,
  type Registry,
} from "@earendil-works/pi-durable";

import type { Attachments } from "./attachments.ts";
import type {
  RelayAPI,
  RelayEventHandler,
  RelayEventName,
  RelayEvents,
  RelayPlugin,
  SettingsPage,
  Tool,
} from "./plugin.ts";
import { chromeStore } from "./storage.ts";
import { toPiTool } from "./tools.ts";

/** Plugin ids name the plugin's pi extension and prompt sections, so they follow pi's key rules. */
const PLUGIN_ID = /^[a-z][a-z0-9_-]*$/;

export interface HostDependencies {
  /** Where plugins' tools and prompt sections are installed. */
  registry: Registry;
  /** Extensions installed after the plugins, whose names and tools plugins must not take. */
  reserved: readonly Extension[];
  /** Report a plugin failure to the user. */
  notify(message: string): void;
  /** The files tools get from the conversation they run in. */
  attachments: Attachments;
}

export interface LoadedPlugin {
  plugin: RelayPlugin;
  enabled: boolean;
  /** Set when `setup` threw. */
  error?: string;
  settings?: SettingsPage;
}

interface Handler {
  pluginId: string;
  // Handlers for different events have different signatures; the map key keeps them apart.
  run: (event: never) => unknown;
}

/** Loads plugins, installs what they register, and runs their event handlers. */
export class PluginHost {
  readonly plugins: LoadedPlugin[] = [];
  #handlers = new Map<RelayEventName, Handler[]>();
  #deps: HostDependencies;

  constructor(deps: HostDependencies) {
    this.#deps = deps;
  }

  async load(plugins: RelayPlugin[], disabled: readonly string[]): Promise<void> {
    for (const plugin of plugins) {
      const loaded: LoadedPlugin = { plugin, enabled: !disabled.includes(plugin.id) };
      this.plugins.push(loaded);
      if (loaded.enabled) await this.#setup(loaded);
    }
  }

  /** Run a plugin's setup; what it registered takes effect only if all of it can be installed. */
  async #setup(loaded: LoadedPlugin) {
    const { plugin } = loaded;
    const tools: Tool[] = [];
    const prompts: string[] = [];
    let settings: SettingsPage | undefined;
    const handlers: [RelayEventName, Handler][] = [];
    const api: RelayAPI = {
      registerTool: (tool) => void tools.push(tool as unknown as Tool),
      registerPromptSection: (text) => void prompts.push(text),
      registerSettingsPage: (render) => {
        if (settings) throw new Error("A plugin has at most one settings page.");
        settings = render;
      },
      on: <E extends RelayEventName>(event: E, handler: RelayEventHandler<E>) =>
        void handlers.push([event, { pluginId: plugin.id, run: handler as Handler["run"] }]),
      storage: chromeStore(`plugin:${plugin.id}`),
    };
    try {
      if (!PLUGIN_ID.test(plugin.id)) {
        throw new Error(
          `Invalid plugin id "${plugin.id}": use lowercase letters, digits, "-" and "_", starting with a letter.`,
        );
      }
      // Installing an extension under a taken name would replace the other plugin's.
      if (this.plugins.some((other) => other !== loaded && other.plugin.id === plugin.id)) {
        throw new Error(`Another plugin already has the id "${plugin.id}".`);
      }
      const others = [...this.#deps.registry.snapshot().installed(), ...this.#deps.reserved];
      // ...and so would taking the name of Relay's own extensions.
      if (others.some((extension) => extension.name === plugin.id)) {
        throw new Error(`The plugin id "${plugin.id}" is reserved.`);
      }
      await plugin.setup(api);
      // pi resolves a tool call by name, so two tools with one name would shadow each other.
      for (const tool of tools) {
        const owner = others.find((extension) =>
          extension.tools?.some((other) => other.name === tool.name),
        );
        if (owner) throw new Error(`The tool name "${tool.name}" is taken by "${owner.name}".`);
      }
      // Installation is all or nothing, and throws on, e.g., two tools with the same name.
      this.#deps.registry.install(
        defineExtension({
          name: plugin.id,
          tools: tools.map((tool) => toPiTool(tool, this.#deps.attachments)),
          sections: prompts.map((text, index) =>
            section(`${plugin.id}-${index}`, () => text, { tag: false }),
          ),
        }),
      );
    } catch (error) {
      loaded.error = error instanceof Error ? error.message : String(error);
      console.error(`[relay] plugin "${plugin.id}" failed to load`, error);
      return;
    }
    if (settings) loaded.settings = settings;
    for (const [event, handler] of handlers) {
      this.#handlers.set(event, [...(this.#handlers.get(event) ?? []), handler]);
    }
  }

  /** Run every handler for an event in load order; a failing plugin never stops the rest. */
  async #run<E extends RelayEventName>(
    name: E,
    event: RelayEvents[E]["event"],
    onResult?: (result: RelayEvents[E]["result"]) => void,
  ) {
    for (const handler of this.#handlers.get(name) ?? []) {
      try {
        const result = (await handler.run(event as never)) as RelayEvents[E]["result"] | undefined;
        if (result !== undefined) onResult?.(result);
      } catch (error) {
        console.error(`[relay] plugin "${handler.pluginId}" failed handling ${name}`, error);
        this.#deps.notify(
          `Plugin "${handler.pluginId}" failed handling ${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** Pass on the agent events plugins can handle. */
  async notify(event: AgentEvent): Promise<void> {
    if (event.type === "run_end") await this.#run("run_end", {});
  }

  /** Context plugins add to a message before it is sent. */
  async beforeAgentStart(prompt: string): Promise<string[]> {
    const context: string[] = [];
    await this.#run("before_agent_start", { prompt }, (result) => {
      if (result?.context) context.push(result.context);
    });
    return context;
  }
}
