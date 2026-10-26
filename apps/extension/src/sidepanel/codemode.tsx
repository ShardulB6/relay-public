import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { NestedToolSlot } from "@earendil-works/pi-durable";
import type { CodemodeToolDetails } from "@earendil-works/pi-durable/codemode";
import { useState } from "react";

import { ToolOutput } from "@/components/tool-output";
import {
  Attachment,
  AttachmentContent,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** A `codemode` call as the transcript has it. */
export interface CodemodeCallProps {
  args: unknown;
  /** Absent while the script runs. */
  result?: { content: (TextContent | ImageContent)[]; details?: unknown };
  /** While running: output the script has reported so far. */
  output?: string;
  /** While running: the tool calls the script is making. */
  nested: readonly NestedToolSlot[];
}

/** A screenshot the script showed: a thumbnail that opens the full image. */
function Screenshot({ image, title }: { image: ImageContent; title: string }) {
  const [open, setOpen] = useState(false);
  const src = `data:${image.mimeType};base64,${image.data}`;
  return (
    <>
      <Attachment orientation="vertical" size="sm">
        <AttachmentMedia variant="image">
          <img src={src} alt="" />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>{title}</AttachmentTitle>
        </AttachmentContent>
        <AttachmentTrigger aria-label={`View ${title}`} onClick={() => setOpen(true)} />
      </Attachment>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[calc(100%-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <img src={src} alt="Screenshot shown by the script" className="rounded-md border" />
        </DialogContent>
      </Dialog>
    </>
  );
}

const STATUS_MARK = { running: "…", ok: "✓", error: "✗", cancelled: "–" } as const;

/** The tool calls the script made: live while it runs, from its details once it is done. */
function calls({ result, nested }: CodemodeCallProps): string {
  const done = (result?.details as CodemodeToolDetails | undefined)?.calls;
  const lines = done
    ? done.map(
        (call) =>
          `${STATUS_MARK[call.status]} ${call.name}(${call.args})${call.error ? ` ${call.error}` : ""}`,
      )
    : nested.map((call) => {
        const status = call.status !== "done" ? "running" : call.summary?.isError ? "error" : "ok";
        return `${STATUS_MARK[status]} ${call.name}(${JSON.stringify(call.arguments)})${call.summary?.error ? ` ${call.summary.error}` : ""}`;
      });
  return lines.join("\n");
}

/** The script, the calls it made, its output and the images it showed. */
export function CodemodeCall(context: CodemodeCallProps) {
  const { code = "" } = (context.args ?? {}) as { code?: string };
  const content = context.result?.content ?? [];
  const output = context.result
    ? content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
    : context.output;
  const images = content.filter((block) => block.type === "image");
  const made = calls(context);
  return (
    <>
      <ToolOutput>{code}</ToolOutput>
      {made ? <ToolOutput>{made}</ToolOutput> : null}
      {output ? <ToolOutput>{output}</ToolOutput> : null}
      {images.length > 0 ? (
        <AttachmentGroup>
          {images.map((image, index) => (
            <Screenshot
              key={index}
              image={image}
              title={images.length > 1 ? `Screenshot ${index + 1}` : "Screenshot"}
            />
          ))}
        </AttachmentGroup>
      ) : null}
    </>
  );
}
