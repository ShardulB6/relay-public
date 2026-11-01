import type { Api, AuthCheck, AuthEvent, AuthPrompt, AuthType, Model } from "@earendil-works/pi-ai";
import { useAtomValue, useSetAtom } from "jotai";
import { SettingsIcon } from "lucide-react";
import { Component, useState, type ReactNode, type SubmitEvent } from "react";

import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

import type { RelayApp } from "../core/app.ts";
import { errorMessage } from "../core/errors.ts";
import type { RelayPlugin, SettingsPage } from "../core/plugin.ts";
import { settingsAtom, updateSettingsAtom } from "../core/settings.ts";
import { findModel, modelKey, ModelOptions, parseModelKey } from "./models.tsx";

/** A provider login in progress, shown as a dialog. */
export interface LoginDialogState {
  title: string;
  events: AuthEvent[];
  prompt?: { prompt: AuthPrompt; submit: (value: string) => void };
  error?: string;
  cancel: () => void;
}

export interface SettingsActions {
  login: (providerId: string, type: AuthType) => void;
  logout: (providerId: string) => void;
  close: () => void;
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="wrap-anywhere underline underline-offset-3"
    >
      {children}
    </a>
  );
}

function AuthEventView({ event }: { event: AuthEvent }) {
  switch (event.type) {
    case "auth_url":
      return (
        <p>
          {event.instructions ?? "Continue in the browser."}{" "}
          <ExternalLink href={event.url}>Open the sign-in page</ExternalLink>
        </p>
      );
    case "device_code":
      return (
        <p>
          Enter code <code className="font-mono">{event.userCode}</code> at{" "}
          <ExternalLink href={event.verificationUri}>{event.verificationUri}</ExternalLink>
        </p>
      );
    case "info":
      return (
        <p>
          {event.message}
          {event.links?.map((link) => (
            <span key={link.url}>
              {" "}
              <ExternalLink href={link.url}>{link.label ?? link.url}</ExternalLink>
            </span>
          ))}
        </p>
      );
    case "progress":
      return <p className="text-muted-foreground">{event.message}</p>;
  }
}

function AuthPromptView({
  prompt,
  submit,
}: {
  prompt: AuthPrompt;
  submit: (value: string) => void;
}) {
  if (prompt.type === "select") {
    return (
      <div className="flex flex-col gap-2">
        <p>{prompt.message}</p>
        <ItemGroup>
          {prompt.options.map((option) => (
            <Item
              key={option.id}
              variant="outline"
              size="xs"
              render={<button type="button" onClick={() => submit(option.id)} />}
              className="cursor-pointer text-left hover:bg-muted"
            >
              <ItemContent>
                <ItemTitle>{option.label}</ItemTitle>
                {option.description ? (
                  <ItemDescription>{option.description}</ItemDescription>
                ) : null}
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </div>
    );
  }
  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("value");
    submit((input as HTMLInputElement).value);
  };
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <Field>
        <FieldLabel htmlFor="auth-prompt" className="wrap-anywhere">
          {prompt.message}
        </FieldLabel>
        <Input
          id="auth-prompt"
          name="value"
          type={prompt.type === "secret" ? "password" : "text"}
          placeholder={prompt.placeholder ?? ""}
          autoComplete="off"
          spellCheck={false}
          required
        />
      </Field>
      <Button type="submit">Continue</Button>
    </form>
  );
}

export function LoginDialog({ dialog }: { dialog: LoginDialogState | undefined }) {
  return (
    <Dialog open={dialog !== undefined} onOpenChange={(open) => !open && dialog?.cancel()}>
      {dialog ? (
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{dialog.title}</DialogTitle>
            <DialogDescription className="sr-only">
              Follow the steps to connect this provider.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 wrap-anywhere">
            {dialog.events.map((event, index) => (
              <AuthEventView key={index} event={event} />
            ))}
            {dialog.prompt ? (
              // A new prompt is a new form; do not carry the previous answer over.
              <AuthPromptView
                key={dialog.prompt.prompt.message}
                prompt={dialog.prompt.prompt}
                submit={dialog.prompt.submit}
              />
            ) : null}
            {dialog.error ? (
              <Alert variant="destructive">
                <AlertDescription>{dialog.error}</AlertDescription>
              </Alert>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={dialog.cancel}>
              {dialog.error ? "Close" : "Cancel"}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/** Keeps a plugin's settings page from taking the side panel down with it. */
class PageBoundary extends Component<{ pluginId: string; children: ReactNode }> {
  state: { error?: string } = {};

  static getDerivedStateFromError(error: unknown) {
    return { error: errorMessage(error) };
  }

  componentDidCatch(error: unknown) {
    console.error(`[relay] settings of plugin "${this.props.pluginId}" failed`, error);
  }

  render() {
    if (this.state.error === undefined) return this.props.children;
    return (
      <Alert variant="destructive">
        <AlertDescription>This page failed to show: {this.state.error}</AlertDescription>
      </Alert>
    );
  }
}

function PluginPageContent({ render }: { render: SettingsPage }) {
  return render();
}

/** A plugin's settings page, in place of the settings view. */
function PluginSettingsView({
  plugin,
  render,
  back,
  close,
}: {
  plugin: RelayPlugin;
  render: SettingsPage;
  back: () => void;
  close: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title={plugin.name} close={close} back={back} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
        <PageBoundary pluginId={plugin.id}>
          <PluginPageContent render={render} />
        </PageBoundary>
      </div>
    </div>
  );
}

/** No title model: conversations are named after their first message. */
const FIRST_MESSAGE = "";

/** The model that names new conversations, out of those the stored credentials are served. */
function TitleModelField({ app, available }: { app: RelayApp; available: readonly Model<Api>[] }) {
  const selected = useAtomValue(settingsAtom).titleModel;
  const updateSettings = useSetAtom(updateSettingsAtom);
  // A model whose credential was removed is not offered, and not used.
  const current = findModel(available, selected);

  return (
    <Field>
      <FieldContent>
        <FieldLabel htmlFor="title-model">Title model</FieldLabel>
        <FieldDescription>
          Names each new conversation from its first message, using that provider's credential. Only
          models your connected providers serve are listed.
        </FieldDescription>
      </FieldContent>
      <Select
        value={current ? modelKey(current) : FIRST_MESSAGE}
        onValueChange={(value) => void updateSettings({ titleModel: parseModelKey(value) })}
      >
        <SelectTrigger id="title-model" className="w-full min-w-0">
          <SelectValue className="min-w-0 truncate">
            {() => current?.name ?? "None (use the first message)"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} className="max-h-80">
          <SelectGroup>
            <SelectItem value={FIRST_MESSAGE}>None (use the first message)</SelectItem>
          </SelectGroup>
          <ModelOptions app={app} models={available} />
        </SelectContent>
      </Select>
    </Field>
  );
}

export function SettingsView({
  app,
  auth,
  available,
  actions,
}: {
  app: RelayApp;
  auth: ReadonlyMap<string, AuthCheck | undefined>;
  /** Models the stored credentials are served. */
  available: readonly Model<Api>[];
  actions: SettingsActions;
}) {
  const { models, host } = app;
  const value = useAtomValue(settingsAtom);
  const updateSettings = useSetAtom(updateSettingsAtom);
  const [pluginPage, setPluginPage] = useState<string>();

  const togglePlugin = (id: string, enabled: boolean) => {
    const disabled = new Set(value.disabledPlugins);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    void updateSettings({ disabledPlugins: [...disabled] });
  };

  const open = host.plugins.find(({ plugin }) => plugin.id === pluginPage);
  if (open?.settings) {
    return (
      <PluginSettingsView
        plugin={open.plugin}
        render={open.settings}
        back={() => setPluginPage(undefined)}
        close={actions.close}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Settings" close={actions.close} />

      <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto p-3">
        <FieldSet>
          <FieldLegend>Providers</FieldLegend>
          <FieldDescription>
            Credentials are stored in this browser's extension storage.
          </FieldDescription>
          <ItemGroup>
            {models.getProviders().map((provider) => {
              const check = auth.get(provider.id);
              return (
                <Item key={provider.id} variant="outline" size="sm">
                  <ItemContent>
                    <ItemTitle className="w-full justify-between">
                      {provider.name}
                      {check ? (
                        <Badge variant="secondary">
                          {check.type === "oauth" ? "Signed in" : "API key"}
                        </Badge>
                      ) : null}
                    </ItemTitle>
                  </ItemContent>
                  <ItemActions className="basis-full flex-wrap">
                    {provider.auth.apiKey?.login ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => actions.login(provider.id, "api_key")}
                      >
                        {check?.type === "api_key" ? "Change API key" : "Use API key"}
                      </Button>
                    ) : null}
                    {provider.auth.oauth ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => actions.login(provider.id, "oauth")}
                      >
                        {provider.auth.oauth.loginLabel ?? "Sign in"}
                      </Button>
                    ) : null}
                    {check ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => actions.logout(provider.id)}
                      >
                        Disconnect
                      </Button>
                    ) : null}
                  </ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
        </FieldSet>

        <FieldSet>
          <FieldLegend>Conversations</FieldLegend>
          <TitleModelField app={app} available={available} />
        </FieldSet>

        <FieldSet>
          <FieldLegend>Plugins</FieldLegend>
          <FieldGroup>
            {host.plugins.map(({ plugin, error, settings }) => (
              <Field key={plugin.id} orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor={`plugin-${plugin.id}`}>{plugin.name}</FieldLabel>
                  {plugin.description ? (
                    <FieldDescription>{plugin.description}</FieldDescription>
                  ) : null}
                  {error ? (
                    <FieldDescription className="text-destructive">
                      Failed to load: {error}
                    </FieldDescription>
                  ) : null}
                </FieldContent>
                <div className="flex items-center gap-1">
                  {settings ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${plugin.name} settings`}
                      onClick={() => setPluginPage(plugin.id)}
                    >
                      <SettingsIcon />
                    </Button>
                  ) : null}
                  <Switch
                    id={`plugin-${plugin.id}`}
                    checked={!value.disabledPlugins.includes(plugin.id)}
                    onCheckedChange={(enabled) => togglePlugin(plugin.id, enabled)}
                  />
                </div>
              </Field>
            ))}
            <Field orientation="horizontal">
              <FieldDescription>Plugin changes apply after a reload.</FieldDescription>
              <Button variant="outline" size="sm" onClick={() => location.reload()}>
                Reload now
              </Button>
            </Field>
          </FieldGroup>
        </FieldSet>
      </div>
    </div>
  );
}
