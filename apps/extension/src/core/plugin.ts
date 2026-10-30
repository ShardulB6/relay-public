import type { Static, TSchema } from "@earendil-works/pi-ai";
import type { ReactNode } from "react";

import type { KeyValueStore } from "./storage.ts";

type MaybePromise<T> = T | Promise<T>;

/**
 * A Relay plugin adds tools for the agent. The core is the durable agent (pi-durable, with its
 * code mode), model providers, settings and the chat view; browser control is a plugin too.
 */
export interface RelayPlugin {
  /**
   * Stable unique id, e.g. "browser": lowercase letters, digits, "-" and "_", starting with a
   * letter. Also namespaces the plugin's storage.
   */
  id: string;
  name: string;
  description?: string;
  /** Called once when the side panel starts, before the conversation opens. */
  setup(relay: RelayAPI): MaybePromise<void>;
}

/** Identity helper that gives plugin modules type checking. */
export function definePlugin(plugin: RelayPlugin): RelayPlugin {
  return plugin;
}

/**
 * The service-worker half of a plugin, default-exported from its `background.ts`. Use it for
 * work that must happen while the side panel is closed, such as cleaning up after the panel
 * or reacting to browser events.
 */
export interface BackgroundPlugin {
  /** The same id as the plugin's side-panel half. */
  id: string;
  /**
   * Called each time the service worker starts, whether or not the plugin is enabled. Add
   * chrome.* event listeners synchronously in here, so the event that woke the worker reaches
   * them.
   */
  setup(relay: BackgroundAPI): void;
}

export interface BackgroundAPI {
  /** Whether the user has the plugin enabled in settings. */
  enabled(): Promise<boolean>;
  /** Call `callback` when the user turns the plugin on or off. */
  onEnabledChange(callback: (enabled: boolean) => void): void;
  /** The plugin's storage, shared with its side-panel half. */
  readonly storage: KeyValueStore;
}

/** Identity helper that gives background modules type checking. */
export function defineBackgroundPlugin(plugin: BackgroundPlugin): BackgroundPlugin {
  return plugin;
}

/** A tool the agent can use. */
export interface Tool<P extends TSchema = TSchema> {
  /** Unique across plugins, e.g. "page_click". */
  name: string;
  description: string;
  parameters: P;
  /** The type of what `execute` returns, shown to scripts. */
  returns?: TSchema;
  /**
   * Who may call the tool: the model directly, scripts the model writes (`tools.<name>(args)`),
   * or both (the default).
   */
  callers?: readonly ("model" | "scripts")[];
  /**
   * Do the work and return the result: a string is text, an image block is an image, anything
   * else is sent as JSON (scripts get the value itself). Throw to fail; the agent sees the error.
   */
  execute(args: Static<P>, options: ToolOptions): Promise<unknown>;
}

export interface ToolOptions {
  signal: AbortSignal;
  /** The files the user attached to the conversation the tool runs in. */
  files: AttachedFiles;
}

/** Files the user attached to a conversation, by name. */
export interface AttachedFiles {
  names(): Promise<string[]>;
  get(name: string): Promise<File | undefined>;
}

/** Identity helper that infers `execute`'s argument types from `parameters`. */
export function defineTool<P extends TSchema>(tool: Tool<P>): Tool<P> {
  return tool;
}

/**
 * A plugin's settings page, opened from its entry in the settings view. Rendered as a React
 * component, so it may use hooks.
 */
export type SettingsPage = () => ReactNode;

/** Events a plugin can handle, with what its handler may return. */
export interface RelayEvents {
  /** A message is about to be sent. Return `{ context }` to tell the model something with it. */
  before_agent_start: { event: { prompt: string }; result: { context?: string } };
  /** The agent finished working on the user's messages. */
  run_end: { event: Record<string, never>; result: void };
}

export type RelayEventName = keyof RelayEvents;

export type RelayEventHandler<E extends RelayEventName> = (
  event: RelayEvents[E]["event"],
) => MaybePromise<RelayEvents[E]["result"] | void>;

export interface RelayAPI {
  /** Give the agent a tool. */
  registerTool<P extends TSchema>(tool: Tool<P>): void;
  /** Add guidance to the system prompt, after the core's own. */
  registerPromptSection(text: string): void;
  /**
   * Give the plugin a settings page, for letting the user see and manage what it keeps. A
   * plugin has at most one.
   */
  registerSettingsPage(render: SettingsPage): void;
  /** Handle an event. */
  on<E extends RelayEventName>(event: E, handler: RelayEventHandler<E>): void;
  /** Persistent storage private to this plugin. */
  readonly storage: KeyValueStore;
}
