import "./style.css";

import { Provider } from "jotai";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import { createApp } from "../core/app.ts";
import { errorMessage } from "../core/errors.ts";
import { plugins } from "../plugins/index.ts";
import { App } from "./app.tsx";

const root = createRoot(document.getElementById("root")!);
root.render(<p className="p-4 text-sm text-muted-foreground">Starting…</p>);

try {
  const app = await createApp(plugins);
  root.render(
    <StrictMode>
      <Provider store={app.store}>
        <App app={app} />
      </Provider>
    </StrictMode>,
  );
} catch (error) {
  console.error(error);
  root.render(
    <Alert variant="destructive" className="m-3 w-auto">
      <AlertTitle>Relay failed to start</AlertTitle>
      <AlertDescription className="wrap-anywhere">{errorMessage(error)}</AlertDescription>
    </Alert>,
  );
}
