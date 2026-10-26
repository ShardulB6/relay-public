import { InlineCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import type { Extension } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import quickjsUrl from "quickjs-wasi/quickjs.wasm?url";

/**
 * pi's code mode: the model gets one `codemode` tool and writes scripts that call the tools
 * plugins register for scripts. QuickJS runs them, and a script resumes after a restart.
 */
export function codemodeExtension(): Extension {
  return createCodemodeExtension({
    sandbox: new InlineCodemodeSandbox({
      wasm: WebAssembly.compileStreaming(fetch(quickjsUrl)),
    }),
    models: false,
  });
}
