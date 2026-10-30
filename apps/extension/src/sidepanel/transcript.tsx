import type {
  AssistantMessage,
  ImageContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { EntryRecord, NestedToolSlot, ToolSlot } from "@earendil-works/pi-durable";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  CircleXIcon,
  FileTextIcon,
  MessageCircleQuestionIcon,
  RotateCwIcon,
} from "lucide-react";
import { Component, useEffect, useState, type ReactNode } from "react";

import { ToolOutput } from "@/components/tool-output";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";

import type { RelayApp } from "../core/app.ts";
import { ASK_USER_TOOL, type Question } from "../core/questions.ts";
import {
  USER_ENTRY,
  WORKED_ENTRY,
  type UserEntryData,
  type WorkedEntryData,
} from "../core/session.ts";
import { CodemodeCall } from "./codemode.tsx";
import { formatDuration } from "./duration.ts";
import { Markdown } from "./markdown.tsx";
import { AskUserCall } from "./questions.tsx";

function text(content: ToolResultMessage["content"]): string {
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** Keeps a tool view that throws from taking the transcript down with it. */
class RendererBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};

  static getDerivedStateFromError(error: unknown) {
    return { error: String(error) };
  }

  render() {
    if (this.state.error === undefined) return this.props.children;
    return <ToolOutput>Renderer failed: {this.state.error}</ToolOutput>;
  }
}

const STATUS_ICON = {
  running: <Spinner />,
  done: <CheckIcon />,
  error: <CircleXIcon className="text-destructive" />,
  stopped: <CircleSlashIcon />,
};

function ToolCallView({
  app,
  call,
  result,
}: {
  app: RelayApp;
  call: ToolCall;
  result: ToolResultMessage | undefined;
}) {
  const { session } = app;
  const live = session.live;
  const slot: ToolSlot | undefined = live.tools?.find((candidate) => candidate.callId === call.id);
  const isRunning = !result && session.isRunning && (slot === undefined || slot.status !== "done");
  const isError = result?.isError ?? false;
  const status = isRunning ? "running" : isError ? "error" : result ? "done" : "stopped";
  // Details stay open while there is something to watch or fix, unless the user chose otherwise.
  const [chosen, setChosen] = useState<boolean>();
  const open = chosen ?? (isRunning || isError);
  const nested: NestedToolSlot[] = (live.nestedTools ?? []).filter(
    (candidate) => candidate.parentCallId === call.id,
  );

  const isScript = call.name === "codemode";
  const isQuestion = call.name === ASK_USER_TOOL;
  let label: ReactNode = isScript ? "Run script" : call.name;
  let body: ReactNode;
  if (isQuestion) {
    const { questions = [] } = (call.arguments ?? {}) as { questions?: Question[] };
    label = isRunning
      ? "Waiting for your answer"
      : questions.length === 1
        ? `Asked: ${questions[0]!.header}`
        : `Asked ${questions.length} questions`;
    body = isError ? (
      <ToolOutput>{text(result!.content)}</ToolOutput>
    ) : (
      <AskUserCall args={call.arguments} details={result?.details} />
    );
  } else if (isScript) {
    body = (
      <CodemodeCall
        args={call.arguments}
        result={result && { content: result.content, details: result.details }}
        output={slot?.output}
        nested={nested}
      />
    );
  } else {
    const output = result ? text(result.content) : slot?.output;
    body = (
      <>
        <ToolOutput>{JSON.stringify(call.arguments ?? {}, null, 2)}</ToolOutput>
        {output ? <ToolOutput>{output}</ToolOutput> : null}
      </>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setChosen}>
      <CollapsibleTrigger
        render={<Marker render={<button type="button" />} className="group/tool cursor-pointer" />}
      >
        <MarkerIcon>
          {isQuestion && status === "done" ? <MessageCircleQuestionIcon /> : STATUS_ICON[status]}
        </MarkerIcon>
        <MarkerContent className={isRunning ? "shimmer" : undefined}>
          {label}
          <span className="sr-only">: {status}</span>
        </MarkerContent>
        <ChevronRightIcon className="size-3.5! transition-transform group-data-panel-open/tool:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex flex-col gap-2 border-l pl-3">
        <RendererBoundary>{body}</RendererBoundary>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Collapsible>
      <CollapsibleTrigger
        render={<Marker render={<button type="button" />} className="group/tool cursor-pointer" />}
      >
        <MarkerContent className={streaming ? "shimmer" : undefined}>Thinking</MarkerContent>
        <ChevronRightIcon className="size-3.5! transition-transform group-data-panel-open/tool:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 border-l pl-3 text-muted-foreground">
        <Markdown text={text} streaming={streaming} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Whether an assistant message thought or called tools. */
function hasWork(message: AssistantMessage): boolean {
  return message.content.some(
    (block) =>
      block.type === "toolCall" || (block.type === "thinking" && block.thinking.trim() !== ""),
  );
}

/** Whether an assistant message has text to show, or ended badly. */
function hasText(message: AssistantMessage): boolean {
  if (message.stopReason === "error" || message.stopReason === "aborted") return true;
  return message.content.some((block) => block.type === "text" && block.text.trim() !== "");
}

/** Which of an assistant message to show: all of it, its work (thinking, tools), or its text. */
type AssistantPart = "all" | "work" | "text";

function AssistantView({
  app,
  message,
  results,
  streaming,
  part = "all",
}: {
  app: RelayApp;
  message: AssistantMessage;
  results: Map<string, ToolResultMessage>;
  streaming: boolean;
  part?: AssistantPart;
}) {
  const showsWork = part !== "text";
  const showsText = part !== "work";
  return (
    <Message>
      <MessageContent>
        {message.content.map((block, index) => {
          if (block.type === "text") {
            if (!showsText) return null;
            return block.text.trim() ? (
              <Bubble key={index} variant="ghost">
                <BubbleContent>
                  <Markdown text={block.text} streaming={streaming} />
                </BubbleContent>
              </Bubble>
            ) : null;
          }
          if (!showsWork) return null;
          if (block.type === "thinking") {
            return block.thinking.trim() ? (
              <Thinking key={index} text={block.thinking} streaming={streaming} />
            ) : null;
          }
          return (
            <ToolCallView key={block.id} app={app} call={block} result={results.get(block.id)} />
          );
        })}
        {showsText && message.stopReason === "error" ? (
          <Alert variant="destructive">
            <AlertDescription className="wrap-anywhere">
              {message.errorMessage ?? "The request failed."}
            </AlertDescription>
          </Alert>
        ) : null}
        {showsText && message.stopReason === "aborted" ? (
          <Marker>
            <MarkerIcon>
              <CircleSlashIcon />
            </MarkerIcon>
            <MarkerContent>Stopped</MarkerContent>
          </Marker>
        ) : null}
      </MessageContent>
    </Message>
  );
}

function UserView({
  text,
  images,
  documents = [],
  queued = false,
}: {
  text: string;
  images: readonly ImageContent[];
  documents?: UserEntryData["documents"];
  queued?: boolean;
}) {
  return (
    <Message align="end" className={queued ? "opacity-60" : undefined}>
      <MessageContent>
        {documents.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {documents.map((document, index) => (
              <div
                key={index}
                className="flex max-w-[60%] items-center gap-2 rounded-xl border bg-muted px-2.5 py-2"
              >
                <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-xs font-medium">{document.name}</span>
                  <span className="text-xs text-muted-foreground">
                    PDF · {document.pages} {document.pages === 1 ? "page" : "pages"}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {images.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {images.map((image, index) => (
              <img
                key={index}
                src={`data:${image.mimeType};base64,${image.data}`}
                alt={`Attached image ${index + 1}`}
                className="max-h-40 max-w-[60%] rounded-xl border object-contain"
              />
            ))}
          </div>
        ) : null}
        {text.trim() ? (
          <Bubble variant="secondary" align="end" className="max-w-[90%]">
            <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
          </Bubble>
        ) : null}
      </MessageContent>
    </Message>
  );
}

function images(content: UserMessage["content"]): ImageContent[] {
  return typeof content === "string" ? [] : content.filter((block) => block.type === "image");
}

/** What to show of a user entry: what the user typed, without the ambient context. */
function userView(entry: EntryRecord, message: UserMessage): ReactNode {
  if (entry.kind === USER_ENTRY) {
    const data = entry.data as unknown as UserEntryData;
    return (
      <UserView text={data.text} images={images(message.content)} documents={data.documents} />
    );
  }
  const content = message.content;
  const plain =
    typeof content === "string"
      ? content
      : content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  return <UserView text={plain} images={images(content)} />;
}

function Notice({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <Marker role="status">
      {icon ? <MarkerIcon>{icon}</MarkerIcon> : null}
      <MarkerContent>{children}</MarkerContent>
    </Marker>
  );
}

/** How long a finished run worked, heading it; opens below its divider to its thinking and tools. */
function Worked({ durationMs, children }: { durationMs: number; children: ReactNode[] }) {
  const label = <MarkerContent>Worked for {formatDuration(durationMs)}</MarkerContent>;
  if (children.length === 0) return <Marker variant="border">{label}</Marker>;
  return (
    <Collapsible>
      <CollapsibleTrigger
        render={
          <Marker
            variant="border"
            render={<button type="button" />}
            className="group/worked cursor-pointer"
          />
        }
      >
        {label}
        <ChevronRightIcon className="size-3.5! transition-transform group-data-panel-open/worked:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 flex flex-col gap-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** Time since `since`, ticking every second. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatDuration(Math.max(0, now - since))}</>;
}

/** The conversation, with each tool result shown inside the call that produced it. */
export function Transcript({ app }: { app: RelayApp }) {
  const { session } = app;
  const { entries } = session.view;
  const { generation, compactions, compactionFailure } = session.live;
  const results = new Map<string, ToolResultMessage>();
  /** Each finished run's note, by the first message it answered. */
  const worked = new Map<number, { data: WorkedEntryData; id: number }>();
  for (const entry of entries) {
    const message = entry.model?.[0];
    if (message?.role === "toolResult") results.set(message.toolCallId, message);
    if (entry.kind === WORKED_ENTRY) {
      const data = entry.data as unknown as WorkedEntryData;
      worked.set(data.input, { data, id: entry.id });
    }
  }
  const streaming = generation?.message as AssistantMessage | undefined;
  const runStart = session.isRunning ? session.runStart : undefined;
  const running = entries.find((entry) => entry.id === runStart);
  const working = (
    <Marker role="status" variant="border">
      {/* A streaming answer or running tool shows its own progress. */}
      {!streaming && !session.live.tools ? (
        <MarkerIcon>
          <Spinner />
        </MarkerIcon>
      ) : null}
      <MarkerContent className="shimmer">
        Working…
        {running?.model?.[0] === undefined ? null : (
          // Not announced: it changes every second.
          <span aria-hidden="true">
            {" "}
            <Elapsed since={running.model[0].timestamp} />
          </span>
        )}
      </MarkerContent>
    </Marker>
  );

  /** What to show of an entry, if anything. */
  const view = (entry: EntryRecord, part: AssistantPart = "all"): ReactNode => {
    const message = entry.model?.[0];
    if (entry.kind === "pi.compaction") return <Notice>Earlier messages were summarized</Notice>;
    if (message?.role === "user" && entry.kind !== "pi.reset") return userView(entry, message);
    if (message?.role === "assistant") {
      return (
        <AssistantView
          app={app}
          message={message}
          results={results}
          streaming={false}
          part={part}
        />
      );
    }
    // Tool results render inside their call; system, reset and worked entries are for the model
    // or are shown with the run they belong to.
    return undefined;
  };

  /** Whether a run starts with entry `id`: a finished one with a note, or the running one. */
  const startsRun = (id: number) => worked.has(id) || id === runStart;

  const rows: { key: string; anchor?: boolean; node: ReactNode }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const node = view(entry);
    if (node === undefined) continue;
    const isUser = entry.model?.[0]?.role === "user";
    rows.push({ key: String(entry.id), anchor: isUser, node });
    if (entry === running) rows.push({ key: "working", node: working });
    const run = isUser ? worked.get(entry.id) : undefined;
    if (!run) continue;

    // A finished run: its note heads it, with its thinking and tools folded under the note, and the
    // rest follows. A run that ended without an answer (stopped, or failed) ends at its note.
    // The run ends at its answer, or at its note; a note can land after the next run started,
    // so the run also ends where another begins.
    const end = run.data.answer ?? run.id;
    let last = i;
    while (
      last + 1 < entries.length &&
      entries[last + 1]!.id <= end &&
      !startsRun(entries[last + 1]!.id)
    ) {
      last++;
    }
    const span = entries.slice(i + 1, last + 1);
    const work: ReactNode[] = [];
    for (const candidate of span) {
      const message = candidate.model?.[0];
      if (message?.role === "assistant" && hasWork(message)) {
        work.push(<div key={candidate.id}>{view(candidate, "work")}</div>);
      }
    }
    rows.push({
      key: `worked-${run.id}`,
      node: <Worked durationMs={run.data.durationMs}>{work}</Worked>,
    });
    for (const candidate of span) {
      const message = candidate.model?.[0];
      if (message?.role === "assistant" && !hasText(message)) continue;
      const shown = view(candidate, "text");
      if (shown === undefined) continue;
      rows.push({ key: String(candidate.id), anchor: message?.role === "user", node: shown });
    }
    i = last;
  }
  for (const item of session.inbox) {
    if (item.mode === "write") continue;
    const data = item.entry?.data as UserEntryData | undefined;
    const content = item.content as UserMessage["content"];
    rows.push({
      key: `queued-${item.id}`,
      node: (
        <UserView
          text={data?.text ?? ""}
          images={images(content)}
          documents={data?.documents}
          queued
        />
      ),
    });
  }

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-4 p-3">
            {rows.map((row) => (
              <MessageScrollerItem key={row.key} messageId={row.key} scrollAnchor={row.anchor}>
                {row.node}
              </MessageScrollerItem>
            ))}
            {streaming ? (
              <MessageScrollerItem key="streaming" messageId="streaming">
                <AssistantView app={app} message={streaming} results={results} streaming />
              </MessageScrollerItem>
            ) : null}
            {generation?.retry ? (
              <MessageScrollerItem key="retry">
                <Notice icon={<RotateCwIcon />}>Retrying: {generation.retry.error}</Notice>
              </MessageScrollerItem>
            ) : null}
            {compactions?.some((compaction) => compaction.blocking) ? (
              <MessageScrollerItem key="compacting">
                <Notice icon={<Spinner />}>Summarizing earlier messages…</Notice>
              </MessageScrollerItem>
            ) : null}
            {session.isRunning && running === undefined ? (
              // Before the run's first message shows, there is nothing to head.
              <MessageScrollerItem key="working">{working}</MessageScrollerItem>
            ) : null}
            {compactionFailure ? (
              <MessageScrollerItem key="compaction-failure">
                <Alert variant="destructive">
                  <AlertDescription className="wrap-anywhere">
                    Summarizing earlier messages failed: {compactionFailure.error}
                  </AlertDescription>
                </Alert>
              </MessageScrollerItem>
            ) : null}
            {session.error ? (
              <MessageScrollerItem key="error">
                <Alert variant="destructive">
                  <AlertDescription className="wrap-anywhere">{session.error}</AlertDescription>
                </Alert>
              </MessageScrollerItem>
            ) : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
