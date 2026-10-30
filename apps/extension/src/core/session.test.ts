import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  Type,
  type Context,
  type Message,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { createStore } from "jotai";
import { describe, expect, test, vi } from "vite-plus/test";

import { Attachments } from "./attachments.ts";
import { historyAtom } from "./history.ts";
import { PluginHost } from "./host.ts";
import { definePlugin, defineTool, type RelayAPI, type RelayPlugin } from "./plugin.ts";
import { Questions, type Question } from "./questions.ts";
import {
  AgentSession,
  coreExtension,
  documentBudget,
  DOCUMENTS_TOO_LONG,
  USER_ENTRY,
  WORKED_ENTRY,
} from "./session.ts";
import { updateSettingsAtom } from "./settings.ts";
import { chromeStore } from "./storage.ts";
import { toPiTool } from "./tools.ts";

const context = BACKGROUND_CONTEXT;

/** A session on in-memory storage, wired to a scripted model, with the given plugins loaded. */
async function setup(plugins: RelayPlugin[] = [], storage = new MemoryStorage()) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const store = createStore();
  await store.set(updateSettingsAtom, { model: { provider: "faux", id: "faux-1" } });
  const registry = createRegistry();
  const questions = new Questions();
  registry.install(coreExtension(questions));

  const notices: string[] = [];
  const requests: Context[] = [];
  const host = new PluginHost({
    attachments,
    registry,
    reserved: [lateExtension],
    notify: (message) => void notices.push(message),
  });
  await host.load(plugins, []);
  const harness = await Harness.open(storage, { models, registry }, context);
  const session = new AgentSession({ attachments, harness, host, models, questions, store });
  await session.start();

  /** Script the model's replies and record each request it receives. */
  const respond = (...replies: Parameters<typeof fauxAssistantMessage>[]) =>
    faux.setResponses(
      replies.map((reply) => (request) => {
        requests.push(structuredClone(request));
        return fauxAssistantMessage(...reply);
      }),
    );
  /** Send a message and wait until the agent is done with it. */
  const send = async (...args: Parameters<AgentSession["prompt"]>) => {
    await session.prompt(...args);
    await harness.waitForIdle(context);
  };
  return {
    session,
    host,
    harness,
    registry,
    models,
    questions,
    store,
    notices,
    requests,
    respond,
    send,
  };
}

const echoTool = defineTool({
  name: "echo",
  description: "Returns its input",
  parameters: Type.Object({ value: Type.String() }),
  execute: async ({ value }) => {
    if (value === "fail") throw new Error("echo broke");
    return value === "object" ? { echoed: true } : `echo:${value}`;
  },
});

const attachments = new Attachments(chromeStore("attachments"));

/** Stands in for code mode: installed after the plugins, so the host must reserve its names. */
const lateExtension = defineExtension({
  name: "late",
  tools: [toPiTool({ ...echoTool, name: "late_tool" }, attachments)],
});

function withPlugin(setup: (relay: RelayAPI) => void): RelayPlugin {
  return definePlugin({ id: "test", name: "Test", setup });
}

function pdf(name: string): File {
  return new File(["%PDF"], name, { type: "application/pdf" });
}

function lastToolResult(messages: readonly Message[]) {
  return messages.findLast((message) => message.role === "toolResult");
}

function lastUser(messages: readonly Message[]) {
  return messages.findLast((message) => message.role === "user")!;
}

describe("AgentSession", () => {
  test("runs plugin tools and feeds their results back to the model", async () => {
    const { session, respond, requests, send } = await setup([
      withPlugin((relay) => relay.registerTool(echoTool)),
    ]);
    respond(
      [fauxToolCall("echo", { value: "ping" }), { stopReason: "toolUse" }],
      [fauxToolCall("echo", { value: "object" }), { stopReason: "toolUse" }],
      [fauxToolCall("echo", { value: "fail" }), { stopReason: "toolUse" }],
      [fauxText("done")],
    );

    await send("go");

    expect(session.error).toBeUndefined();
    expect(lastToolResult(requests[1]!.messages)).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "echo:ping" }],
    });
    expect(lastToolResult(requests[2]!.messages)).toMatchObject({
      isError: false,
      content: [{ type: "text", text: JSON.stringify({ echoed: true }, null, 2) }],
    });
    const failed = lastToolResult(requests[3]!.messages);
    expect(failed).toMatchObject({ isError: true });
    expect(JSON.stringify(failed!.content)).toContain("echo broke");
    expect(session.view.entries.at(-1)?.model?.[0]).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });
    expect(session.isRunning).toBe(false);
  });

  test("sends prompt sections and before_agent_start context, and shows only the typed text", async () => {
    const { session, respond, requests, send } = await setup([
      withPlugin((relay) => {
        relay.registerPromptSection("SECTION-EXTRA");
        relay.on("before_agent_start", () => ({ context: "Active tab: example.com" }));
      }),
    ]);
    respond([fauxText("ok")]);

    await send("hello");

    const prompt = JSON.stringify(requests[0]);
    expect(prompt.indexOf("You are Relay")).toBeLessThan(prompt.indexOf("SECTION-EXTRA"));
    const user = lastUser(requests[0]!.messages);
    expect(user.content).toContain("Active tab: example.com");
    expect(user.content).toMatch(/\n\nhello$/);
    expect(session.view.entries.find((entry) => entry.kind === USER_ENTRY)?.data).toEqual({
      text: "hello",
      documents: [],
    });
  });

  test("sends attached images when the model accepts them, and refuses them otherwise", async () => {
    const { session, respond, requests, send, models } = await setup();
    respond([fauxText("a cat")]);
    const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };

    await send("what is this?", [image]);

    expect(session.error).toBeUndefined();
    expect(lastUser(requests[0]!.messages).content).toEqual([
      { type: "text", text: expect.stringMatching(/^<context>[\s\S]*\n\nwhat is this\?$/) },
      image,
    ]);

    const textOnly = fauxProvider({
      provider: "faux",
      models: [{ id: "faux-1", input: ["text"] }],
    });
    models.setProvider(textOnly.provider);
    textOnly.setResponses([fauxAssistantMessage(fauxText("never"))]);
    await send("look", [image]);
    expect(session.error).toContain("does not accept images");
    expect(textOnly.state.callCount).toBe(0);
  });

  test("a failing plugin handler is reported and does not stop the run", async () => {
    const { session, respond, notices, send } = await setup([
      withPlugin((relay) => {
        relay.on("before_agent_start", () => {
          throw new Error("plugin bug");
        });
      }),
    ]);
    respond([fauxText("still works")]);

    await send("hello");

    expect(notices.join()).toContain("plugin bug");
    expect(session.view.entries.at(-1)?.model?.[0]).toMatchObject({ stopReason: "stop" });
  });

  test("tells plugins when a run ends", async () => {
    let runs = 0;
    const { respond, send } = await setup([
      withPlugin((relay) => relay.on("run_end", () => void runs++)),
    ]);
    respond([fauxText("ok")]);

    await send("hello");
    // Events are delivered after their commit; give the stream a moment to drain.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runs).toBe(1);
  });

  test("notes how long the run worked, from the message to the answer", async () => {
    const { session, respond, send } = await setup([
      withPlugin((relay) => relay.registerTool(echoTool)),
    ]);
    respond(
      [fauxToolCall("echo", { value: "ping" }), { stopReason: "toolUse" }],
      [fauxText("done")],
    );

    await send("go");
    await vi.waitFor(() =>
      expect(session.view.entries.some((entry) => entry.kind === WORKED_ENTRY)).toBe(true),
    );

    const answer = session.view.entries.findLast(
      (entry) => entry.model?.[0]?.role === "assistant",
    )!;
    const notes = session.view.entries.filter((entry) => entry.kind === WORKED_ENTRY);
    expect(notes).toHaveLength(1);
    const input = session.view.entries.find((entry) => entry.kind === USER_ENTRY)!;
    expect(notes[0]!.data).toEqual({
      durationMs: expect.any(Number),
      input: input.id,
      answer: answer.id,
    });
    expect(notes[0]!.model).toBeUndefined();
  });

  test("knows which message the running run started with", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const waitTool = defineTool({
      name: "wait",
      description: "Waits",
      parameters: Type.Object({}),
      execute: async () => {
        await held;
        return "waited";
      },
    });
    const { session, harness, respond } = await setup([
      withPlugin((relay) => relay.registerTool(waitTool)),
    ]);
    respond([fauxToolCall("wait", {}), { stopReason: "toolUse" }], [fauxText("done")]);

    await session.prompt("go");
    const input = session.view.entries.find((entry) => entry.kind === USER_ENTRY)!;
    await vi.waitFor(() => expect(session.runStart).toBe(input.id));

    release();
    await harness.waitForIdle(context);
    await vi.waitFor(() => expect(session.runStart).toBeUndefined());
  });

  test("falls back to an available model when the selected one is unknown", async () => {
    const { session, store, respond, send } = await setup();
    respond([fauxText("ok")]);
    await store.set(updateSettingsAtom, { model: { provider: "nope", id: "nope" } });
    await send("hello");
    expect(session.model?.id).toBe("faux-1");
  });

  test("switches model when the provider's credential is not served the selected one", async () => {
    const { session, models, send } = await setup();
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }, { id: "faux-2" }] });
    models.setProvider({
      ...faux.provider,
      filterModels: (list) => list.filter((model) => model.id !== "faux-1"),
    });
    faux.setResponses([fauxAssistantMessage(fauxText("ok"))]);

    await send("hello");

    expect(session.error).toBeUndefined();
    expect(session.model?.id).toBe("faux-2");
    expect(faux.state.callCount).toBe(1);
  });

  test("reset opens a new conversation, which the next start reopens", async () => {
    const { session, harness, host, models, questions, store, respond, send } = await setup();
    respond([fauxText("one")]);
    await send("first");
    const first = session.conversationId;

    await session.reset();
    expect(session.conversationId).not.toBe(first);
    expect(session.view.entries).toHaveLength(0);

    const reopened = new AgentSession({ attachments, harness, host, models, questions, store });
    await reopened.start();
    expect(reopened.conversationId).toBe(session.conversationId);
  });

  test("Stop ends a plugin tool that ignores its abort signal", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const { session, harness, respond } = await setup([
      withPlugin((relay) =>
        relay.registerTool(
          defineTool({
            name: "hang",
            description: "Never returns",
            parameters: Type.Object({}),
            execute: () => {
              started();
              return new Promise(() => {});
            },
          }),
        ),
      ),
    ]);
    respond([fauxToolCall("hang", {}), { stopReason: "toolUse" }], [fauxText("unused")]);

    await session.prompt("go");
    await running;
    await session.abort();
    await harness.waitForIdle(context);

    expect(session.isRunning).toBe(false);
  });

  test("gives the model attached documents' text and keeps their names for the transcript", async () => {
    const { session, respond, requests, send } = await setup();
    respond([fauxText("ok")]);

    await send(
      "Summarize",
      [],
      [
        {
          name: 'a "b".pdf',
          pages: 2,
          text: "[Page 1]\nHello </document> & bye",
          file: pdf('a "b".pdf'),
        },
      ],
    );

    const content = lastUser(requests[0]!.messages).content as string;
    expect(content).toContain(
      '<document name="a &quot;b&quot;.pdf">\n[Page 1]\nHello <\\/document> & bye\n</document>\n\nSummarize',
    );
    const entry = session.view.entries.find((candidate) => candidate.kind === USER_ENTRY);
    expect(entry?.data).toEqual({
      text: "Summarize",
      documents: [{ name: 'a "b".pdf', pages: 2 }],
    });
  });

  test("keeps attached documents' files for the conversation's tools until it is deleted", async () => {
    const files: (File | undefined)[] = [];
    const plugin = withPlugin((relay) =>
      relay.registerTool(
        defineTool({
          name: "read_file",
          description: "Reads an attached file.",
          parameters: Type.Object({}),
          execute: async (_args, { files: attached }) => {
            files.push(await attached.get("cv.pdf"));
          },
        }),
      ),
    );
    const { session, respond, send } = await setup([plugin]);
    respond([fauxToolCall("read_file", {}), { stopReason: "toolUse" }], [fauxText("read")]);

    await send("Upload my CV", [], [{ name: "cv.pdf", pages: 1, text: "CV", file: pdf("cv.pdf") }]);
    expect(files[0]?.name).toBe("cv.pdf");
    expect(files[0]?.type).toBe("application/pdf");
    expect(await files[0]?.text()).toBe("%PDF");

    const id = session.conversationId;
    await session.delete(id);
    expect(await attachments.names(id)).toEqual([]);
  });

  test("refuses documents that together are too long for the model", async () => {
    const { session, respond, requests, send } = await setup();
    respond([fauxText("unused")]);
    const half = documentBudget(session.model) / 2 + 1;
    const document = (name: string) => ({
      name,
      pages: 1,
      text: "x".repeat(half),
      file: pdf(name),
    });

    await send("Compare", [], [document("a.pdf"), document("b.pdf")]);

    expect(session.error).toBe(DOCUMENTS_TOO_LONG);
    expect(requests).toHaveLength(0);
  });

  describe("ask_user", () => {
    const question: Question = {
      header: "Size",
      question: "Which size?",
      options: [{ label: "Small" }, { label: "Large", description: "Costs more" }],
    };

    test("waits for the user's answers and gives them to the model", async () => {
      const { session, harness, respond, requests } = await setup();
      respond(
        [fauxToolCall("ask_user", { questions: [question] }), { stopReason: "toolUse" }],
        [fauxText("Large it is")],
      );

      await session.prompt("Order a coffee");
      await vi.waitFor(() => expect(session.questions).toBeDefined());
      expect(session.isRunning).toBe(true);
      expect(session.questions!.questions).toEqual([question]);
      session.questions!.answer([{ question: "Which size?", answers: ["Large"] }]);
      await harness.waitForIdle(context);

      expect(session.questions).toBeUndefined();
      expect(lastToolResult(requests[1]!.messages)).toMatchObject({
        isError: false,
        content: [{ type: "text", text: "The user answered:\n- Which size?\n  Large" }],
        details: { answers: [{ question: "Which size?", answers: ["Large"] }] },
      });
    });

    test("asks a question without options for an answer the user types", async () => {
      const { session, harness, respond, requests } = await setup();
      const gpa: Question = { header: "GPA", question: "What is your GPA?", options: [] };
      respond(
        [fauxToolCall("ask_user", { questions: [gpa] }), { stopReason: "toolUse" }],
        [fauxText("Entered")],
      );

      await session.prompt("Fill the form");
      await vi.waitFor(() => expect(session.questions).toBeDefined());
      session.questions!.answer([{ question: "What is your GPA?", answers: ["2.81"] }]);
      await harness.waitForIdle(context);

      expect(lastToolResult(requests[1]!.messages)).toMatchObject({
        isError: false,
        content: [{ type: "text", text: "The user answered:\n- What is your GPA?\n  2.81" }],
      });
    });

    test("tells the model when the user dismissed the questions", async () => {
      const { session, harness, respond, requests } = await setup();
      respond(
        [fauxToolCall("ask_user", { questions: [question] }), { stopReason: "toolUse" }],
        [fauxText("ok")],
      );

      await session.prompt("Order a coffee");
      await vi.waitFor(() => expect(session.questions).toBeDefined());
      session.questions!.dismiss();
      await harness.waitForIdle(context);

      expect(lastToolResult(requests[1]!.messages)).toMatchObject({
        isError: false,
        details: { dismissed: true },
      });
    });

    test("Stop withdraws the questions", async () => {
      const { session, harness, respond } = await setup();
      respond([fauxToolCall("ask_user", { questions: [question] }), { stopReason: "toolUse" }]);

      await session.prompt("Order a coffee");
      await vi.waitFor(() => expect(session.questions).toBeDefined());
      await session.abort();
      await harness.waitForIdle(context);

      expect(session.questions).toBeUndefined();
      expect(session.isRunning).toBe(false);
    });

    test("asks again after the panel reopens", async () => {
      const storage = new MemoryStorage();
      // Closing the first Harness must leave the stored conversation for the second.
      storage.close = async () => {};
      const first = await setup([], storage);
      first.respond([
        fauxToolCall("ask_user", { questions: [question] }),
        { stopReason: "toolUse" },
      ]);
      await first.session.prompt("Order a coffee");
      await vi.waitFor(() => expect(first.session.questions).toBeDefined());
      await first.harness.close(context);

      const second = await setup([], storage);
      second.respond([fauxText("Small, then")]);
      await vi.waitFor(() => expect(second.session.questions).toBeDefined());
      second.session.questions!.answer([{ question: "Which size?", answers: ["Small"] }]);
      await second.harness.waitForIdle(context);

      expect(second.requests).toHaveLength(1);
      expect(lastToolResult(second.requests[0]!.messages)).toMatchObject({ isError: false });
    });
  });

  test("drops a message whose conversation was replaced while it was being prepared", async () => {
    let release!: () => void;
    const preparing = new Promise<void>((resolve) => (release = resolve));
    const plugin = withPlugin((relay) =>
      relay.on("before_agent_start", async () => {
        await preparing;
        return { context: "slow context" };
      }),
    );
    const { session, harness, respond, requests } = await setup([plugin]);
    respond([fauxText("never sent")]);
    const first = session.conversationId;

    const sending = session.prompt("for the first conversation");
    await session.reset();
    release();
    await sending;
    await harness.waitForIdle(context);

    expect(session.conversationId).not.toBe(first);
    expect(session.view.entries).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });
});

describe("PluginHost", () => {
  test("a plugin whose tools or prompt cannot be installed fails alone", async () => {
    const { host, registry } = await setup();
    const tool = (name: string) => ({ ...echoTool, name });
    await host.load(
      [
        definePlugin({
          id: "twice",
          name: "Twice",
          setup(relay) {
            relay.registerTool(tool("same"));
            relay.registerTool(tool("same"));
          },
        }),
        definePlugin({
          id: "camelCase",
          name: "Camel case",
          setup: (relay) => relay.registerPromptSection("Guidance."),
        }),
        definePlugin({
          id: "twice",
          name: "Same id",
          setup: (relay) => relay.registerTool(tool("other")),
        }),
        definePlugin({
          id: "after",
          name: "After",
          setup: (relay) => relay.registerTool(tool("after")),
        }),
      ],
      [],
    );
    expect(host.plugins.map(({ plugin, error }) => [plugin.id, error])).toEqual([
      ["twice", "Extension twice has two tools named same"],
      ["camelCase", expect.stringContaining('Invalid plugin id "camelCase"')],
      ["twice", 'Another plugin already has the id "twice".'],
      ["after", undefined],
    ]);
    expect(
      registry
        .snapshot()
        .tools()
        .map((registered) => registered.tool.name),
    ).toEqual(["ask_user", "after"]);
  });

  test("a plugin cannot take the name or tools of another extension", async () => {
    const { host, registry } = await setup();
    const tool = (name: string) => ({ ...echoTool, name });
    const plugin = (id: string, toolName: string) =>
      definePlugin({ id, name: id, setup: (relay) => relay.registerTool(tool(toolName)) });
    await host.load(
      [
        plugin("relay", "core_tool"),
        plugin("late", "late_plugin_tool"),
        plugin("first", "shared"),
        plugin("second", "shared"),
        plugin("third", "late_tool"),
      ],
      [],
    );
    expect(host.plugins.map(({ plugin, error }) => [plugin.id, error])).toEqual([
      ["relay", 'The plugin id "relay" is reserved.'],
      ["late", 'The plugin id "late" is reserved.'],
      ["first", undefined],
      ["second", 'The tool name "shared" is taken by "first".'],
      ["third", 'The tool name "late_tool" is taken by "late".'],
    ]);
    expect(
      registry
        .snapshot()
        .installed()
        .map((extension) => extension.name),
    ).toEqual(["relay", "first"]);
  });

  test("skips disabled plugins and keeps nothing from a plugin whose setup throws", async () => {
    const { host, registry } = await setup();
    const tool = (name: string) => ({ ...echoTool, name });
    await host.load(
      [
        definePlugin({ id: "off", name: "Off", setup: (relay) => relay.registerTool(tool("off")) }),
        definePlugin({
          id: "broken",
          name: "Broken",
          setup(relay) {
            relay.registerTool(tool("broken"));
            relay.registerSettingsPage(() => null);
            throw new Error("bad setup");
          },
        }),
        definePlugin({
          id: "good",
          name: "Good",
          setup(relay) {
            relay.registerTool(tool("good"));
            relay.registerSettingsPage(() => null);
          },
        }),
      ],
      ["off"],
    );

    expect(
      registry
        .snapshot()
        .tools()
        .map((registered) => registered.tool.name),
    ).toEqual(["ask_user", "good"]);
    expect(
      host.plugins.map(({ plugin, enabled, error, settings }) => [
        plugin.id,
        enabled,
        error,
        settings !== undefined,
      ]),
    ).toEqual([
      ["off", false, undefined, false],
      ["broken", true, "bad setup", false],
      ["good", true, undefined, true],
    ]);
  });

  describe("history", () => {
    test("lists conversations by last message, named after the first one", async () => {
      const { session, store, respond, send } = await setup();
      respond([fauxText("ok")], [fauxText("ok")], [fauxText("ok")]);

      await send("Plan a trip to Lisbon\nwith details");
      const first = session.conversationId;
      await session.reset();
      await send("Compare laptops");
      expect(store.get(historyAtom).map((entry) => entry.title)).toEqual([
        "Compare laptops",
        "Plan a trip to Lisbon",
      ]);

      await session.open(first);
      await send("And hotels?");
      expect(store.get(historyAtom).map((entry) => entry.title)).toEqual([
        "Plan a trip to Lisbon",
        "Compare laptops",
      ]);
      expect(session.conversationId).toBe(first);
    });

    test("names a new conversation with the title model", async () => {
      const { store, models, respond, send } = await setup();
      const titler = fauxProvider({ provider: "titler", models: [{ id: "small" }] });
      models.setProvider(titler.provider);
      titler.setResponses([fauxAssistantMessage(fauxText('"Lisbon trip plan."'))]);
      await store.set(updateSettingsAtom, { titleModel: { provider: "titler", id: "small" } });
      respond([fauxText("ok")]);

      await send("Plan a trip to Lisbon");

      await vi.waitFor(() => expect(store.get(historyAtom)[0]?.title).toBe("Lisbon trip plan"));
      expect(titler.state.callCount).toBe(1);
    });

    test("keeps the first message as the title when the title model fails", async () => {
      const { store, models, respond, send } = await setup();
      const titler = fauxProvider({ provider: "titler", models: [{ id: "small" }] });
      models.setProvider(titler.provider);
      titler.setResponses([fauxAssistantMessage([], { stopReason: "error" })]);
      await store.set(updateSettingsAtom, { titleModel: { provider: "titler", id: "small" } });
      respond([fauxText("ok")]);

      await send("Plan a trip to Lisbon");

      await vi.waitFor(() => expect(titler.state.callCount).toBe(1));
      expect(store.get(historyAtom)[0]?.title).toBe("Plan a trip to Lisbon");
    });

    test("renames and deletes conversations; deleting the open one starts another", async () => {
      const { session, store, respond, send } = await setup();
      respond([fauxText("ok")], [fauxText("ok")]);
      await send("First");
      const first = session.conversationId;
      await session.reset();
      await send("Second");
      const second = session.conversationId;

      await session.rename(first, "  Renamed  ");
      await session.rename(first, "   ");
      expect(store.get(historyAtom).find((entry) => entry.id === first)?.title).toBe("Renamed");

      await session.delete(first);
      expect(store.get(historyAtom).map((entry) => entry.id)).toEqual([second]);
      expect(session.conversationId).toBe(second);

      await session.delete(second);
      expect(store.get(historyAtom)).toEqual([]);
      expect(session.conversationId).not.toBe(second);
    });

    test("overlapping opens show the last one, never one's transcript under another's id", async () => {
      const { session, respond, send } = await setup();
      respond([fauxText("ok")], [fauxText("ok")], [fauxText("ok")]);
      const texts = new Map<ConversationId, string>();
      for (const text of ["A", "B", "C"]) {
        await session.reset();
        await send(text);
        texts.set(session.conversationId, text);
      }
      const [a, b] = [...texts.keys()];

      const shownText = () =>
        (session.view.entries.find((entry) => entry.kind === USER_ENTRY)?.data as { text: string })
          ?.text;
      const mismatches: (string | undefined)[] = [];
      const off = session.onChange.on(() => {
        if (shownText() !== texts.get(session.conversationId)) mismatches.push(shownText());
      });
      await Promise.all([session.open(a!), session.open(b!)]);
      off();

      expect(mismatches).toEqual([]);
      expect(session.conversationId).toBe(b);
      expect(shownText()).toBe("B");
    });

    test("deleting a conversation while its message is being stored keeps it deleted", async () => {
      const storage = new MemoryStorage();
      const { session, store, respond, send } = await setup([], storage);
      respond([fauxText("ok")], [fauxText("ok")]);
      await send("First");
      const id = session.conversationId;

      // Hold the next commit until the conversation has been deleted.
      const commit = storage.commit.bind(storage);
      const held = Promise.withResolvers<void>();
      let holding = true;
      storage.commit = async (...args) => {
        if (holding) {
          holding = false;
          await held.promise;
        }
        return commit(...args);
      };
      const pending = session.prompt("Second");
      await vi.waitFor(() => expect(holding).toBe(false));
      const deleted = session.delete(id);
      held.resolve();
      await Promise.all([pending, deleted]);

      expect(store.get(historyAtom).some((entry) => entry.id === id)).toBe(false);
    });
  });
});
