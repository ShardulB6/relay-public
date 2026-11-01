import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type AuthCheck,
  type AuthType,
  type ImageContent,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { useAtomValue, useSetAtom } from "jotai";
import {
  ArrowRightIcon,
  ArrowUpIcon,
  BrainIcon,
  FileTextIcon,
  PaperclipIcon,
  RotateCwClockIcon,
  SettingsIcon,
  SquareIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ClipboardEvent,
  type Dispatch,
  type DragEvent,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import { toast } from "sonner";

import { IconButton } from "@/components/icon-button";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { RelayApp } from "../core/app.ts";
import { errorMessage } from "../core/errors.ts";
import {
  acceptsImages,
  documentBudget,
  documentLength,
  DOCUMENTS_TOO_LONG,
  IMAGES_UNSUPPORTED,
  preferredModel,
  type AttachedDocument,
} from "../core/session.ts";
import { settingsAtom, updateSettingsAtom } from "../core/settings.ts";
import { documentFiles, PDF_TYPE, prepareDocument } from "./documents.ts";
import { HistoryView } from "./history.tsx";
import { IMAGE_TYPES, imageFiles, prepareImage } from "./images.ts";
import { findModel, modelKey, ModelOptions, parseModelKey } from "./models.tsx";
import { QuestionPanel, useQuestionFlow } from "./questions.tsx";
import { LoginDialog, SettingsView, type LoginDialogState } from "./settings.tsx";
import { Transcript } from "./transcript.tsx";

const THINKING_LABEL: Record<ModelThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** Providers with credentials, and the models those credentials are served. */
function useAuth(app: RelayApp) {
  const [auth, setAuth] = useState<ReadonlyMap<string, AuthCheck | undefined>>(new Map());
  const [available, setAvailable] = useState<readonly Model<Api>[]>([]);

  useEffect(() => {
    let current = true;
    const refresh = async () => {
      const { models } = app;
      const checks = new Map<string, AuthCheck | undefined>();
      for (const provider of models.getProviders()) {
        checks.set(provider.id, await models.checkAuth(provider.id).catch(() => undefined));
      }
      const served = await models.getAvailable();
      if (!current) return;
      setAuth(checks);
      setAvailable(served);
    };
    void refresh();
    const off = app.credentials.onChange.on(() => void refresh());
    return () => {
      current = false;
      off();
    };
  }, [app]);

  return { auth, available };
}

function Header({
  app,
  openHistory,
  openSettings,
}: {
  app: RelayApp;
  openHistory: () => void;
  openSettings: () => void;
}) {
  return (
    <header className="flex items-center gap-1 border-b p-2 pl-3">
      <span className="mr-auto font-heading font-semibold">Relay</span>
      <IconButton label="Conversations" size="icon-sm" side="bottom" onClick={openHistory}>
        <RotateCwClockIcon />
      </IconButton>
      <IconButton
        label="New conversation"
        size="icon-sm"
        side="bottom"
        onClick={() => void app.session.reset()}
      >
        <SquarePenIcon />
      </IconButton>
      <IconButton label="Settings" size="icon-sm" side="bottom" align="end" onClick={openSettings}>
        <SettingsIcon />
      </IconButton>
    </header>
  );
}

/** Compact select styling for pickers that sit in the message box's toolbar. */
const TOOLBAR_SELECT =
  "h-6! border-transparent bg-transparent px-1.5 text-xs font-normal hover:bg-muted dark:bg-transparent dark:hover:bg-muted/50";

/** The model for the next message, grouped by the provider serving it. */
function ModelPicker({ app, available }: { app: RelayApp; available: readonly Model<Api>[] }) {
  const current = findModel(available, useAtomValue(settingsAtom).model);

  return (
    <Select
      value={current ? modelKey(current) : null}
      onValueChange={(value) => {
        const model = parseModelKey(value);
        if (model) void app.session.setModel(model.provider, model.id);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Model"
        title="Model"
        className={cn("-ml-1 min-w-0", TOOLBAR_SELECT)}
      >
        <SelectValue
          className="min-w-0 truncate"
          placeholder={available.length > 0 ? "Choose a model" : "No provider connected"}
        >
          {/* Options are labelled by model name, not by the provider/id value. */}
          {current ? () => current.name : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent side="top" align="start" alignItemWithTrigger={false} className="max-h-80">
        <ModelOptions app={app} models={available} />
      </SelectContent>
    </Select>
  );
}

/** Reasoning effort for the next message, limited to what the selected model supports. */
function ReasoningPicker({ app }: { app: RelayApp }) {
  const { thinkingLevel } = useAtomValue(settingsAtom);
  const updateSettings = useSetAtom(updateSettingsAtom);
  const model = app.session.model;
  if (!model?.reasoning) return null;
  const levels = getSupportedThinkingLevels(model);
  // The stored level may be one this model lacks; show the one it will actually run with.
  const level = clampThinkingLevel(model, thinkingLevel);

  return (
    <Select
      value={level}
      onValueChange={(thinkingLevel) => thinkingLevel && void updateSettings({ thinkingLevel })}
    >
      <SelectTrigger
        size="sm"
        aria-label="Reasoning level"
        title="Reasoning level"
        className={cn("shrink-0", TOOLBAR_SELECT)}
      >
        <BrainIcon className="size-3.5!" />
        <SelectValue>{(value: ModelThinkingLevel) => THINKING_LABEL[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent side="top" align="start" alignItemWithTrigger={false} className="min-w-32">
        <SelectGroup>
          <SelectLabel>Reasoning</SelectLabel>
          {levels.map((option) => (
            <SelectItem key={option} value={option}>
              {THINKING_LABEL[option]}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** What the next message carries besides its text. */
interface Attached {
  images: ImageContent[];
  documents: AttachedDocument[];
  /** Files still being read; the message waits for them. */
  reading: { id: string; name: string }[];
}

const NOTHING_ATTACHED: Attached = { images: [], documents: [], reading: [] };

const REMOVE_BUTTON =
  "absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-background/80 text-foreground opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover/tile:opacity-100 hover:bg-background focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/** Pending images and documents, shown as tiles along the top of the message box. */
function Attachments({
  attached: { images, documents, reading },
  supportsImages,
  documentsFit,
  setAttached,
}: {
  attached: Attached;
  supportsImages: boolean;
  documentsFit: boolean;
  setAttached: Dispatch<SetStateAction<Attached>>;
}) {
  if (images.length === 0 && documents.length === 0 && reading.length === 0) return null;
  return (
    <InputGroupAddon align="block-start" className="flex-col items-start gap-1.5 pt-2.5">
      <div className="flex max-w-full items-start gap-2 overflow-x-auto pb-0.5">
        {reading.map((file) => (
          <div
            key={file.id}
            role="status"
            className="flex h-14 w-48 shrink-0 items-center gap-2 rounded-xl border bg-muted px-2.5"
          >
            <Spinner className="size-5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-xs font-medium text-foreground">{file.name}</span>
              <span className="text-xs font-normal">Reading…</span>
            </span>
          </div>
        ))}
        {documents.map((document, index) => (
          <div
            key={`document-${index}`}
            className={cn(
              "group/tile relative flex h-14 w-48 shrink-0 items-center gap-2 rounded-xl border bg-muted px-2.5 text-left",
              !documentsFit && "border-destructive/60 opacity-60",
            )}
          >
            <FileTextIcon className="size-5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-xs font-medium text-foreground">{document.name}</span>
              <span className="text-xs font-normal">
                PDF · {document.pages} {document.pages === 1 ? "page" : "pages"}
              </span>
            </span>
            <button
              type="button"
              aria-label={`Remove ${document.name}`}
              onClick={() =>
                setAttached((current) => ({
                  ...current,
                  documents: current.documents.filter((_, i) => i !== index),
                }))
              }
              className={REMOVE_BUTTON}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        ))}
        {images.map((image, index) => (
          <div
            key={`image-${index}`}
            className={cn(
              "group/tile relative size-28 shrink-0 overflow-hidden rounded-xl border bg-muted",
              !supportsImages && "border-destructive/60 opacity-60",
            )}
          >
            <img
              src={`data:${image.mimeType};base64,${image.data}`}
              alt={`Attached image ${index + 1}`}
              className="size-full object-cover"
            />
            <button
              type="button"
              aria-label={`Remove image ${index + 1}`}
              onClick={() =>
                setAttached((current) => ({
                  ...current,
                  images: current.images.filter((_, i) => i !== index),
                }))
              }
              className={REMOVE_BUTTON}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        ))}
      </div>
      {images.length > 0 && !supportsImages ? (
        <p className="text-xs font-normal text-destructive">{IMAGES_UNSUPPORTED}</p>
      ) : null}
      {!documentsFit ? (
        <p className="text-xs font-normal text-destructive">{DOCUMENTS_TOO_LONG}</p>
      ) : null}
    </InputGroupAddon>
  );
}

function Composer({
  app,
  available,
  draft,
  setDraft,
  attached,
  setAttached,
}: {
  app: RelayApp;
  available: readonly Model<Api>[];
  draft: string;
  setDraft: (draft: string) => void;
  attached: Attached;
  setAttached: Dispatch<SetStateAction<Attached>>;
}) {
  const { session, ui } = app;
  const { images, documents, reading } = attached;
  const fileInput = useRef<HTMLInputElement>(null);
  const supportsImages = acceptsImages(session.model);
  // While the agent waits on questions, the message box answers them and the draft waits.
  const asking = useQuestionFlow(session.questions);

  // Checked against the selected model, which may have changed since they were attached.
  const documentsFit = documentLength(documents) <= documentBudget(session.model);

  const canSend = asking
    ? asking.canContinue
    : (draft.trim() || images.length > 0 || documents.length > 0) &&
      reading.length === 0 &&
      (images.length === 0 || supportsImages) &&
      documentsFit;

  /**
   * Images go to the model as they are; PDFs as their text, which every model reads. Each file
   * shows as being read until it is ready, and the message cannot be sent until then.
   */
  const attach = async (files: File[]) => {
    await Promise.all(
      files.map(async (file) => {
        const id = crypto.randomUUID();
        setAttached((current) => ({
          ...current,
          reading: [...current.reading, { id, name: file.name }],
        }));
        let added: Partial<Pick<Attached, "images" | "documents">> = {};
        try {
          if (file.type === PDF_TYPE) {
            added = { documents: [await prepareDocument(file, session.model)] };
          } else if (!supportsImages) {
            ui.notify("The selected model does not accept images.", "error");
          } else {
            added = { images: [await prepareImage(file, session.model)] };
          }
        } catch (error) {
          ui.notify(errorMessage(error), "error");
        }
        setAttached((current) => ({
          images: [...current.images, ...(added.images ?? [])],
          documents: [...current.documents, ...(added.documents ?? [])],
          reading: current.reading.filter((other) => other.id !== id),
        }));
      }),
    );
  };

  /** The images and PDFs in a paste or drop. */
  const attachable = (transfer: DataTransfer | null) => [
    ...imageFiles(transfer),
    ...documentFiles(transfer),
  ];

  const onPaste = (event: ClipboardEvent) => {
    const files = attachable(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void attach(files);
  };

  const onDrop = (event: DragEvent) => {
    const files = attachable(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    void attach(files);
  };

  const submit = async () => {
    if (asking) return asking.next();
    const text = draft.trim();
    if (!canSend) return;
    setDraft("");
    setAttached(NOTHING_ATTACHED);
    await session.prompt(text, images, documents);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // Keys typed into an input method's composition are for it, not shortcuts.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="flex flex-col gap-2 p-2 pt-0">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onDragOver={(event) => {
          if (attachable(event.dataTransfer).length > 0) event.preventDefault();
        }}
        onDrop={onDrop}
      >
        {/* The group dims itself when anything inside is disabled; an empty draft only
            disables Send, so keep the field looking live. */}
        <InputGroup className="has-disabled:bg-transparent has-disabled:opacity-100 dark:has-disabled:bg-input/30">
          {asking ? <QuestionPanel flow={asking} /> : null}
          {asking ? null : (
            <Attachments
              attached={attached}
              supportsImages={supportsImages}
              documentsFit={documentsFit}
              setAttached={setAttached}
            />
          )}
          <InputGroupTextarea
            aria-label="Message"
            rows={2}
            className="max-h-40"
            placeholder={
              asking
                ? asking.question.options.length === 0
                  ? "Type your answer…"
                  : asking.question.multiSelect
                    ? "Add your own answer…"
                    : "Or type your own answer…"
                : session.isRunning
                  ? "Send a message to steer the agent…"
                  : "Ask Relay"
            }
            value={asking ? asking.written : draft}
            onChange={(event) =>
              asking ? asking.write(event.target.value) : setDraft(event.target.value)
            }
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <InputGroupAddon align="block-end">
            <ModelPicker app={app} available={available} />
            <ReasoningPicker app={app} />
            {!asking ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  accept={[...(supportsImages ? IMAGE_TYPES : []), PDF_TYPE].join(",")}
                  multiple
                  hidden
                  onChange={(event) => {
                    void attach([...(event.target.files ?? [])]);
                    event.target.value = "";
                  }}
                />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <InputGroupButton
                        variant="ghost"
                        size="icon-xs"
                        aria-label={supportsImages ? "Attach an image or PDF" : "Attach a PDF"}
                        onClick={() => fileInput.current?.click()}
                      />
                    }
                  >
                    <PaperclipIcon />
                  </TooltipTrigger>
                  <TooltipContent>
                    {supportsImages ? "Attach an image or PDF" : "Attach a PDF"} (or paste or drop
                    one)
                  </TooltipContent>
                </Tooltip>
              </>
            ) : null}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {session.isRunning ? (
                <InputGroupButton
                  variant="outline"
                  size="icon-xs"
                  aria-label="Stop"
                  onClick={() => void session.abort()}
                >
                  <SquareIcon className="fill-current" />
                </InputGroupButton>
              ) : null}
              {asking ? (
                <InputGroupButton type="submit" variant="default" size="xs" disabled={!canSend}>
                  {asking.isLast ? "Submit" : "Next"}
                  <ArrowRightIcon />
                </InputGroupButton>
              ) : (
                <InputGroupButton
                  type="submit"
                  variant="default"
                  size="icon-xs"
                  aria-label="Send"
                  disabled={!canSend}
                >
                  <ArrowUpIcon />
                </InputGroupButton>
              )}
            </div>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  );
}

function Chat({
  app,
  available,
  openHistory,
  openSettings,
  draft,
  setDraft,
  attached,
  setAttached,
}: {
  app: RelayApp;
  available: readonly Model<Api>[];
  openHistory: () => void;
  openSettings: () => void;
  draft: string;
  setDraft: (draft: string) => void;
  attached: Attached;
  setAttached: Dispatch<SetStateAction<Attached>>;
}) {
  const { session } = app;
  const isEmpty = session.view.entries.length === 0 && session.inbox.length === 0 && !session.error;

  return (
    <>
      <Header app={app} openHistory={openHistory} openSettings={openSettings} />
      {isEmpty ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Relay</EmptyTitle>
            <EmptyDescription>
              Ask about the page you are on, or hand off a task in the browser.
            </EmptyDescription>
          </EmptyHeader>
          {available.length === 0 ? (
            <EmptyContent>
              <Button onClick={openSettings}>Connect a model provider</Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : (
        // A new conversation gets a new scroller, so its scroll state starts over.
        <Transcript key={session.conversationId} app={app} />
      )}
      <Composer
        app={app}
        available={available}
        draft={draft}
        setDraft={setDraft}
        attached={attached}
        setAttached={setAttached}
      />
    </>
  );
}

export function App({ app }: { app: RelayApp }) {
  const [view, setView] = useState<"chat" | "history" | "settings">("chat");
  // Kept here so an unsent message survives a visit to settings.
  const [draft, setDraft] = useState("");
  const [attached, setAttached] = useState<Attached>(NOTHING_ATTACHED);
  const [dialog, setDialog] = useState<LoginDialogState>();
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const { auth, available } = useAuth(app);

  // The core is plain mutable objects with change events; the view re-reads them on each.
  useEffect(() => {
    const subscriptions = [
      app.session.onChange.on(rerender),
      app.ui.onNotice.on(({ message, level }) =>
        level === "error" ? toast.error(message) : toast(message),
      ),
    ];
    return () => subscriptions.forEach((off) => off());
  }, [app]);

  const login = useCallback(
    async (providerId: string, type: AuthType) => {
      const { models, session, store, ui, deviceId } = app;
      const provider = models.getProvider(providerId);
      const abort = new AbortController();
      const update = (patch: Partial<LoginDialogState>) =>
        setDialog((current) => current && { ...current, ...patch });
      setDialog({
        title: `Connect ${provider?.name ?? providerId}`,
        events: [],
        cancel: () => {
          abort.abort();
          setDialog(undefined);
        },
      });

      try {
        await models.login(
          providerId,
          type,
          {
            signal: abort.signal,
            notify: (event) => {
              if (event.type === "auth_url") void chrome.tabs.create({ url: event.url });
              setDialog((current) => current && { ...current, events: [...current.events, event] });
            },
            prompt: (prompt) =>
              new Promise<string>((resolve, reject) => {
                const cancelled = () => reject(new Error("Login cancelled"));
                abort.signal.addEventListener("abort", cancelled, { once: true });
                // The flow can retract a prompt, e.g. when the browser redirect arrives first.
                prompt.signal?.addEventListener(
                  "abort",
                  () => {
                    update({ prompt: undefined });
                    cancelled();
                  },
                  { once: true },
                );
                update({
                  prompt: {
                    prompt,
                    submit: (value) => {
                      update({ prompt: undefined });
                      resolve(value);
                    },
                  },
                });
              }),
          },
          { getDeviceId: () => deviceId },
        );
        setDialog(undefined);
        ui.notify(`${provider?.name ?? providerId} connected`);
        if (!session.model) {
          const model = preferredModel(await models.getAvailable(providerId));
          if (model) {
            await store.set(updateSettingsAtom, { model: { provider: providerId, id: model.id } });
          }
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        update({
          prompt: undefined,
          error: errorMessage(error),
        });
      }
    },
    [app],
  );

  return (
    <TooltipProvider>
      <div className="flex h-full min-w-0 flex-col">
        {view === "settings" ? (
          <SettingsView
            app={app}
            auth={auth}
            available={available}
            actions={{
              login: (providerId, type) => void login(providerId, type),
              logout: (providerId) => void app.models.logout(providerId),
              close: () => setView("chat"),
            }}
          />
        ) : view === "history" ? (
          <HistoryView app={app} close={() => setView("chat")} />
        ) : (
          <Chat
            app={app}
            available={available}
            openHistory={() => setView("history")}
            openSettings={() => setView("settings")}
            draft={draft}
            setDraft={setDraft}
            attached={attached}
            setAttached={setAttached}
          />
        )}
      </div>
      <LoginDialog dialog={dialog} />
      <Toaster position="top-center" />
    </TooltipProvider>
  );
}
