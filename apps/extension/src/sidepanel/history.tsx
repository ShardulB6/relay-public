import type { ConversationId } from "@earendil-works/pi-durable";
import { useAtomValue } from "jotai";
import { CheckIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { RelayApp } from "../core/app.ts";
import { historyAtom, type HistoryEntry } from "../core/history.ts";

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "5 minutes ago", "yesterday", or a date for anything older than a week. */
function when(time: number): string {
  const seconds = (time - Date.now()) / 1000;
  if (seconds > -60) return "just now";
  if (seconds > -3600) return relative.format(Math.round(seconds / 60), "minute");
  if (seconds > -86_400) return relative.format(Math.round(seconds / 3600), "hour");
  if (seconds > -7 * 86_400) return relative.format(Math.round(seconds / 86_400), "day");
  return new Date(time).toLocaleDateString();
}

function IconAction({
  label,
  onClick,
  children,
  className,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            className={className}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Row({
  entry,
  current,
  open,
  rename,
  remove,
}: {
  entry: HistoryEntry;
  current: boolean;
  open: () => void;
  rename: (title: string) => void;
  remove: () => void;
}) {
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [title, setTitle] = useState(entry.title);

  if (mode === "rename") {
    const save = () => {
      if (title.trim() && title.trim() !== entry.title) rename(title);
      setMode("view");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter") save();
      if (event.key === "Escape") setMode("view");
    };
    return (
      <li className="flex items-center gap-1 px-1 py-1">
        <Input
          autoFocus
          aria-label="Conversation title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={(event) => event.target.select()}
          className="h-7"
        />
        <IconAction label="Save" onClick={save}>
          <CheckIcon />
        </IconAction>
        <IconAction label="Cancel" onClick={() => setMode("view")}>
          <XIcon />
        </IconAction>
      </li>
    );
  }

  if (mode === "delete") {
    return (
      <li className="flex items-center gap-2 rounded-lg bg-destructive/10 py-1.5 pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate text-sm">Delete “{entry.title}”?</span>
        <Button variant="destructive" size="xs" onClick={remove}>
          Delete
        </Button>
        <Button variant="ghost" size="xs" onClick={() => setMode("view")}>
          Cancel
        </Button>
      </li>
    );
  }

  return (
    <li
      className={cn(
        "group/row flex items-center gap-1 rounded-lg pr-1 hover:bg-muted focus-within:bg-muted",
        current && "bg-muted/60",
      )}
    >
      <button
        type="button"
        onClick={open}
        aria-current={current || undefined}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-lg py-2 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="w-full truncate text-sm">{entry.title}</span>
        <span className="text-xs text-muted-foreground">{when(entry.updatedAt)}</span>
      </button>
      <div className="flex opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100">
        <IconAction
          label="Rename"
          onClick={() => {
            setTitle(entry.title);
            setMode("rename");
          }}
        >
          <PencilIcon />
        </IconAction>
        <IconAction
          label="Delete"
          className="hover:text-destructive"
          onClick={() => setMode("delete")}
        >
          <Trash2Icon />
        </IconAction>
      </div>
    </li>
  );
}

/** Past conversations: search, open, rename and delete them. */
export function HistoryView({ app, close }: { app: RelayApp; close: () => void }) {
  const entries = useAtomValue(historyAtom);
  const [query, setQuery] = useState("");
  const { session, ui } = app;
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle
    ? entries.filter((entry) => entry.title.toLocaleLowerCase().includes(needle))
    : entries;

  const report = (error: unknown) =>
    ui.notify(error instanceof Error ? error.message : String(error), "error");
  const open = (id: ConversationId) => session.open(id).then(close, report);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b p-2 pl-3">
        <h1 className="font-heading text-base font-medium">Conversations</h1>
        <Button variant="outline" size="sm" onClick={close}>
          Done
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <Input
          type="search"
          aria-label="Search conversations"
          placeholder="Search conversations"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-9"
        />
        {shown.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">
            {entries.length === 0 ? "No conversations yet." : "No matching conversations."}
          </p>
        ) : (
          <ul className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
            {shown.map((entry) => (
              <Row
                key={entry.id}
                entry={entry}
                current={entry.id === session.conversationId}
                open={() => void open(entry.id)}
                rename={(title) => void session.rename(entry.id, title).catch(report)}
                remove={() => void session.delete(entry.id).catch(report)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
