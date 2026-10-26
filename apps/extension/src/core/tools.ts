import type { JsonValue } from "@earendil-works/chord";
import { Type, type ImageContent } from "@earendil-works/pi-ai";
import {
  defineTool as definePiTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";

import type { Tool } from "./plugin.ts";

const NEVER_ABORTED = new AbortController().signal;

function isImage(value: unknown): value is ImageContent {
  return (value as ImageContent | null | undefined)?.type === "image";
}

/** What the model reads of a returned value. */
function forModel(value: unknown): ToolExecutionResult["output"] {
  if (value === undefined) return [];
  if (isImage(value)) return [value];
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return [{ type: "text", text }];
}

/**
 * Settle as `work` does, or reject as soon as `signal` aborts. pi waits for a running tool before
 * an abort completes, so Stop must not wait on a tool that ignores its signal.
 */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * A plugin's tool as pi-durable runs it. A thrown error becomes pi's error result; a returned
 * value becomes both the output the model reads and the value scripts get. pi hands each caller
 * only its own: the model never sees `structuredOutput`, and scripts never see `output`.
 */
export function toPiTool(tool: Tool): ToolRegistration {
  return definePiTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    callers: (tool.callers ?? ["model", "scripts"]).map((caller) =>
      caller === "scripts" ? "tools" : "model",
    ),
    structuredOutputSchema: tool.returns ?? Type.Unknown(),
    async execute(args, _api, context) {
      const signal = context.abortSignal ?? NEVER_ABORTED;
      const value = await abortable(tool.execute(args, { signal }), signal);
      return { output: forModel(value), structuredOutput: (value ?? null) as JsonValue };
    },
  }) as ToolRegistration;
}
