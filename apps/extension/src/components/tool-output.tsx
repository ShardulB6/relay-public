import type { ReactNode } from "react";

/** Monospace block for what a tool was given and what it returned. */
export function ToolOutput({ children }: { children: ReactNode }) {
  return (
    <pre className="max-h-60 overflow-auto rounded-md bg-muted p-2 font-mono text-xs wrap-anywhere whitespace-pre-wrap">
      {children}
    </pre>
  );
}
