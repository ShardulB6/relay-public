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
import { Component, useState, type ReactNode } from "react";

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
import { USER_ENTRY, type UserEntryData } from "../core/session.ts";
import { CodemodeCall } from "./codemode.tsx";
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

function AssistantView({
  app,
  message,
  results,
  streaming,
}: {
  app: RelayApp;
  message: AssistantMessage;
  results: Map<string, ToolResultMessage>;
  streaming: boolean;
}) {
  return (
    <Message>
      <MessageContent>
        {message.content.map((block, index) => {
          if (block.type === "text") {
            return block.text.trim() ? (
              <Bubble key={index} variant="ghost">
                <BubbleContent>
                  <Markdown text={block.text} streaming={streaming} />
                </BubbleContent>
              </Bubble>
            ) : null;
          }
          if (block.type === "thinking") {
            return block.thinking.trim() ? (
              <Thinking key={index} text={block.thinking} streaming={streaming} />
            ) : null;
          }
          return (
            <ToolCallView key={block.id} app={app} call={block} result={results.get(block.id)} />
          );
        })}
        {message.stopReason === "error" ? (
          <Alert variant="destructive">
            <AlertDescription className="wrap-anywhere">
              {message.errorMessage ?? "The request failed."}
            </AlertDescription>
          </Alert>
        ) : null}
        {message.stopReason === "aborted" ? (
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

/** The conversation, with each tool result shown inside the call that produced it. */
export function Transcript({ app }: { app: RelayApp }) {
  const { session } = app;
  const { entries } = session.view;
  const { generation, compactions, compactionFailure } = session.live;
  const results = new Map<string, ToolResultMessage>();
  for (const entry of entries) {
    const message = entry.model?.[0];
    if (message?.role === "toolResult") results.set(message.toolCallId, message);
  }
  const streaming = generation?.message as AssistantMessage | undefined;

  const rows: { key: string; anchor?: boolean; node: ReactNode }[] = [];
  for (const entry of entries) {
    const message = entry.model?.[0];
    if (entry.kind === "pi.compaction") {
      rows.push({ key: String(entry.id), node: <Notice>Earlier messages were summarized</Notice> });
    } else if (message?.role === "user" && entry.kind !== "pi.reset") {
      rows.push({ key: String(entry.id), anchor: true, node: userView(entry, message) });
    } else if (message?.role === "assistant") {
      rows.push({
        key: String(entry.id),
        node: <AssistantView app={app} message={message} results={results} streaming={false} />,
      });
    }
    // Tool results render inside their call; system and reset entries are for the model.
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
            {session.isRunning && !streaming && !session.live.tools ? (
              <MessageScrollerItem key="working">
                <Marker role="status">
                  <MarkerIcon>
                    <Spinner />
                  </MarkerIcon>
                  <MarkerContent className="shimmer">Working…</MarkerContent>
                </Marker>
              </MessageScrollerItem>
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
