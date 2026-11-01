import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type MutableModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { storage } from "@wxt-dev/storage";
import { createStore, type Store } from "jotai";

import { Attachments } from "./attachments.ts";
import { StoredCredentials } from "./credentials.ts";
import { openConversationStorage } from "./durable/open.ts";
import { Emitter } from "./events.ts";
import { historyAtom } from "./history.ts";
import { PluginHost } from "./host.ts";
import { codemodeExtension } from "./codemode.ts";
import type { RelayPlugin } from "./plugin.ts";
import { registerProviders } from "./providers/index.ts";
import { Questions } from "./questions.ts";
import { AgentSession, coreExtension } from "./session.ts";
import { settingsAtom } from "./settings.ts";
import { chromeStore } from "./storage.ts";

const deviceIdItem = storage.defineItem<string>("local:relay:deviceId");

export interface Notice {
  message: string;
  level: "info" | "error";
}

/** Notices for the UI to show, such as a plugin failing. */
export class UiBridge {
  readonly onNotice = new Emitter<Notice>();

  notify(message: string, level: Notice["level"] = "info"): void {
    this.onNotice.emit({ message, level });
  }
}

export interface RelayApp {
  /** Jotai store holding the settings (`settingsAtom`), kept in sync with extension storage. */
  store: Store;
  credentials: StoredCredentials;
  models: MutableModels;
  host: PluginHost;
  session: AgentSession;
  ui: UiBridge;
  /** Stable id of this installation; some providers want one when signing in. */
  deviceId: string;
}

/** Build the object graph and load plugins. The UI renders from the returned app. */
export async function createApp(plugins: RelayPlugin[]): Promise<RelayApp> {
  // First, so a second window's panel stops before plugins start.
  const conversations = await openConversationStorage();
  const store = createStore();
  await store.set(settingsAtom.sync);
  await store.set(historyAtom.sync);
  let deviceId = await deviceIdItem.getValue();
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await deviceIdItem.setValue(deviceId);
  }

  const credentials = new StoredCredentials(chromeStore("credential"));
  const models = createModels({
    credentials,
    // No process environment or filesystem in a browser: auth comes from stored credentials.
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  registerProviders(models);
  const ui = new UiBridge();
  const registry = createRegistry();
  const questions = new Questions();
  registry.install(coreExtension(questions));
  const codemode = codemodeExtension();

  const attachments = new Attachments(chromeStore("attachments"));
  const host = new PluginHost({
    attachments,
    registry,
    reserved: [codemode],
    notify: (message) => ui.notify(message, "error"),
  });
  await host.load(plugins, store.get(settingsAtom).disabledPlugins);
  // After the plugins, so their guidance precedes code mode's list of the tools scripts can call.
  registry.install(codemode);

  const harness = await Harness.open(
    conversations,
    {
      models,
      registry,
      // Browser actions must not interleave.
      settings: { toolExecution: "sequential" },
      onReport: (error) => console.error("[relay]", error),
    },
    BACKGROUND_CONTEXT,
  );
  const session = new AgentSession({ attachments, harness, host, models, questions, store });
  await session.start();
  return { store, credentials, models, host, session, ui, deviceId };
}
