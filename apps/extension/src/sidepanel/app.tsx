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
  ArrowUpIcon,
  BrainIcon,
  ImagePlusIcon,
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { RelayApp } from "../core/app.ts";
import { acceptsImages, preferredModel } from "../core/session.ts";
import { settingsAtom, updateSettingsAtom } from "../core/settings.ts";
import { IMAGE_TYPES, imageFiles, prepareImage } from "./images.ts";
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
  available,
  openSettings,
}: {
  app: RelayApp;
  available: readonly Model<Api>[];
  openSettings: () => void;
}) {
  const selected = useAtomValue(settingsAtom).model;
  const providers = new Map<string, Model<Api>[]>();
  for (const model of available) {
    providers.set(model.provider, [...(providers.get(model.provider) ?? []), model]);
  }
  const key = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
  const current = selected && available.find((model) => key(model) === key(selected));

  return (
    <header className="flex items-center gap-1 border-b p-2 pl-3">
      <span className="mr-2 font-heading font-semibold">Relay</span>
      <Select
        value={current ? key(current) : null}
        onValueChange={(value) => {
          // Model ids may contain slashes; the provider id never does.
          const [provider, ...rest] = (value ?? "").split("/");
          if (provider && rest.length > 0) void app.session.setModel(provider, rest.join("/"));
        }}
      >
        <SelectTrigger size="sm" aria-label="Model" className="min-w-0 flex-1">
          <SelectValue
            placeholder={available.length > 0 ? "Choose a model" : "No provider connected"}
          >
            {/* Options are labelled by model name, not by the provider/id value. */}
            {current ? () => current.name : undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} className="max-h-80">
          {[...providers].map(([providerId, list]) => (
            <SelectGroup key={providerId}>
              <SelectLabel>{app.models.getProvider(providerId)?.name ?? providerId}</SelectLabel>
              {list.map((model) => (
                <SelectItem key={key(model)} value={key(model)}>
                  {model.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New conversation"
              onClick={() => void app.session.reset()}
            />
          }
        >
          <SquarePenIcon />
        </TooltipTrigger>
        <TooltipContent side="bottom">New conversation</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label="Settings" onClick={openSettings} />
          }
        >
          <SettingsIcon />
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end">
          Settings
        </TooltipContent>
      </Tooltip>
    </header>
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
        className="-ml-1 h-6! border-transparent bg-transparent px-1.5 text-xs font-normal hover:bg-muted dark:bg-transparent dark:hover:bg-muted/50"
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

/** Pending images, shown as tiles along the top of the message box. */
function Attachments({
  images,
  supported,
  remove,
}: {
  images: readonly ImageContent[];
  supported: boolean;
  remove: (index: number) => void;
}) {
  if (images.length === 0) return null;
  return (
    <InputGroupAddon align="block-start" className="flex-col items-start gap-1.5 pt-2.5">
      <div className="flex max-w-full gap-2 overflow-x-auto pb-0.5">
        {images.map((image, index) => (
          <div
            key={index}
            className={cn(
              "group/tile relative size-28 shrink-0 overflow-hidden rounded-xl border bg-muted",
              !supported && "border-destructive/60 opacity-60",
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
              onClick={() => remove(index)}
              className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-background/80 text-foreground opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover/tile:opacity-100 hover:bg-background focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <XIcon className="size-3" />
            </button>
          </div>
        ))}
      </div>
      {!supported ? (
        <p className="text-xs font-normal text-destructive">
          The selected model does not accept images. Remove them or pick another model.
        </p>
      ) : null}
    </InputGroupAddon>
  );
}

function Composer({
  app,
  draft,
  setDraft,
  images,
  setImages,
}: {
  app: RelayApp;
  draft: string;
  setDraft: (draft: string) => void;
  images: ImageContent[];
  setImages: Dispatch<SetStateAction<ImageContent[]>>;
}) {
  const { session, ui } = app;
  const fileInput = useRef<HTMLInputElement>(null);
  const supportsImages = acceptsImages(session.model);

  const canSend = (draft.trim() || images.length > 0) && (images.length === 0 || supportsImages);

  const attach = async (files: File[]) => {
    if (files.length === 0) return;
    if (!supportsImages) {
      return ui.notify("The selected model does not accept images.", "error");
    }
    const added: ImageContent[] = [];
    for (const file of files) {
      try {
        added.push(await prepareImage(file, session.model));
      } catch (error) {
        ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
    if (added.length > 0) setImages((current) => [...current, ...added]);
  };

  const onPaste = (event: ClipboardEvent) => {
    const files = imageFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void attach(files);
  };

  const onDrop = (event: DragEvent) => {
    const files = imageFiles(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    void attach(files);
  };

  const submit = async () => {
    const text = draft.trim();
    if (!canSend) return;
    setDraft("");
    setImages([]);
    await session.prompt(text, images);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
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
          if (supportsImages && imageFiles(event.dataTransfer).length > 0) event.preventDefault();
        }}
        onDrop={onDrop}
      >
        {/* The group dims itself when anything inside is disabled; an empty draft only
            disables Send, so keep the field looking live. */}
        <InputGroup className="has-disabled:bg-transparent has-disabled:opacity-100 dark:has-disabled:bg-input/30">
          <Attachments
            images={images}
            supported={supportsImages}
            remove={(index) => setImages((current) => current.filter((_, i) => i !== index))}
          />
          <InputGroupTextarea
            aria-label="Message"
            rows={2}
            className="max-h-40"
            placeholder={session.isRunning ? "Send a message to steer the agent…" : "Ask Relay"}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <InputGroupAddon align="block-end">
            <ReasoningPicker app={app} />
            {supportsImages ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  accept={IMAGE_TYPES.join(",")}
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
                        aria-label="Attach image"
                        onClick={() => fileInput.current?.click()}
                      />
                    }
                  >
                    <ImagePlusIcon />
                  </TooltipTrigger>
                  <TooltipContent>Attach an image (or paste one)</TooltipContent>
                </Tooltip>
              </>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
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
              <InputGroupButton
                type="submit"
                variant="default"
                size="icon-xs"
                aria-label="Send"
                disabled={!canSend}
              >
                <ArrowUpIcon />
              </InputGroupButton>
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
  openSettings,
  draft,
  setDraft,
  images,
  setImages,
}: {
  app: RelayApp;
  available: readonly Model<Api>[];
  openSettings: () => void;
  draft: string;
  setDraft: (draft: string) => void;
  images: ImageContent[];
  setImages: Dispatch<SetStateAction<ImageContent[]>>;
}) {
  const { session } = app;
  const isEmpty = session.view.entries.length === 0 && session.inbox.length === 0 && !session.error;

  return (
    <>
      <Header app={app} available={available} openSettings={openSettings} />
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
      <Composer app={app} draft={draft} setDraft={setDraft} images={images} setImages={setImages} />
    </>
  );
}

export function App({ app }: { app: RelayApp }) {
  const [view, setView] = useState<"chat" | "settings">("chat");
  // Kept here so an unsent message survives a visit to settings.
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ImageContent[]>([]);
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
          error: error instanceof Error ? error.message : String(error),
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
            actions={{
              login: (providerId, type) => void login(providerId, type),
              logout: (providerId) => void app.models.logout(providerId),
              close: () => setView("chat"),
            }}
          />
        ) : (
          <Chat
            app={app}
            available={available}
            openSettings={() => setView("settings")}
            draft={draft}
            setDraft={setDraft}
            images={images}
            setImages={setImages}
          />
        )}
      </div>
      <LoginDialog dialog={dialog} />
      <Toaster position="top-center" />
    </TooltipProvider>
  );
}
