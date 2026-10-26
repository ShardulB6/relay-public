import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InlineCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  Type,
  type Context,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { expect, test } from "vite-plus/test";

import { defineTool } from "./plugin.ts";
import { toPiTool } from "./tools.ts";

const context = BACKGROUND_CONTEXT;
const IMAGE = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };

/** Run `code` as the model's script, with a `value_of` tool, and return what the model got back. */
async function runScript(code: string) {
  const values = {
    text: "hello",
    object: { a: 1 },
    image: IMAGE,
    nothing: undefined,
  } as Record<string, unknown>;
  const tools = [
    defineTool({
      name: "value_of",
      description: "Returns a value of the given kind.",
      parameters: Type.Object({ kind: Type.String() }),
      callers: ["scripts"],
      execute: async ({ kind }) => {
        if (kind === "fail") throw new Error("value_of broke");
        return values[kind];
      },
    }),
  ];
  const registry = createRegistry();
  registry.install(defineExtension({ name: "test", tools: tools.map(toPiTool) }));
  const wasm = createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm");
  registry.install(
    createCodemodeExtension({
      sandbox: new InlineCodemodeSandbox({ wasm: WebAssembly.compile(await readFile(wasm)) }),
      models: false,
    }),
  );

  const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: Context[] = [];
  faux.setResponses([
    (request) => {
      requests.push(structuredClone(request));
      return fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
    },
    (request) => {
      requests.push(structuredClone(request));
      return fauxAssistantMessage(fauxText("ok"));
    },
  ]);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  const conversation = await harness.root(context);
  await conversation.configure({ model: { provider: "faux", modelId: "m" } }, context);
  await conversation.submit({ type: "input", content: "go" }, context);
  await harness.waitForIdle(context);

  const result = requests[1]!.messages.findLast(
    (message): message is ToolResultMessage => message.role === "toolResult",
  )!;
  return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

test("scripts get a plugin tool's value and can catch what it throws", async () => {
  const text = await runScript(`
const seen = {};
for (const kind of ["text", "object", "image", "nothing"]) seen[kind] = await tools.value_of({ kind });
try {
  await tools.value_of({ kind: "fail" });
} catch (error) {
  seen.error = error instanceof Error ? error.message : "not an Error";
}
return seen;`);

  const returned = JSON.parse(text.slice(text.indexOf("{")));
  expect(returned).toEqual({
    text: "hello",
    object: { a: 1 },
    image: IMAGE,
    nothing: null,
    error: "value_of broke",
  });
});

test("a tool's callers decide whether the model, scripts, or both may call it", () => {
  const tool = (callers?: ("model" | "scripts")[]) =>
    toPiTool(
      defineTool({
        name: "t",
        description: "",
        parameters: Type.Object({}),
        ...(callers ? { callers } : {}),
        execute: async () => "ok",
      }),
    );
  expect(tool(["scripts"]).callers).toEqual(["tools"]);
  expect(tool(["model"]).callers).toEqual(["model"]);
  expect(tool().callers).toEqual(["model", "tools"]);
});
