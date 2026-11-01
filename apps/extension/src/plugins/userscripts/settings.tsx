import { useCallback, useEffect, useState, type SubmitEvent } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import { errorMessage } from "../../core/errors.ts";
import type { KeyValueStore } from "../../core/storage.ts";
import { userscripts } from "./client.ts";
import { permissionOrigins } from "./manager.ts";
import {
  SCRIPTS_KEY,
  type RunAt,
  type SaveUserScript,
  type UserScriptDetails,
  type UserScriptSummary,
  type UserScriptsStatus,
} from "./protocol.ts";

function ScriptEditor({
  script,
  busy,
  save,
  cancel,
}: {
  script: UserScriptDetails;
  busy: boolean;
  save: (script: SaveUserScript) => void;
  cancel: () => void;
}) {
  const { id, name, description, code, runAt } = script;
  const [draft, setDraft] = useState<SaveUserScript>({ id, name, description, code, runAt });
  const [matches, setMatches] = useState(script.matches.join("\n"));
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    save({
      ...draft,
      matches: matches
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border p-3">
      <Field>
        <FieldLabel htmlFor="userscript-name">Name</FieldLabel>
        <Input
          id="userscript-name"
          value={draft.name}
          required
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="userscript-description">Description</FieldLabel>
        <Input
          id="userscript-description"
          value={draft.description}
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="userscript-matches">Matching pages</FieldLabel>
        <Textarea
          id="userscript-matches"
          value={matches}
          required
          disabled={busy}
          spellCheck={false}
          onChange={(event) => setMatches(event.target.value)}
        />
        <FieldDescription>
          One pattern per line, such as https://example.com/articles/*.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="userscript-run-at">Run when</FieldLabel>
        <Select
          value={draft.runAt}
          disabled={busy}
          onValueChange={(value) => value && setDraft({ ...draft, runAt: value as RunAt })}
        >
          <SelectTrigger id="userscript-run-at">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="document_start">Page starts loading</SelectItem>
            <SelectItem value="document_end">DOM is ready</SelectItem>
            <SelectItem value="document_idle">Page is idle</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="userscript-code">JavaScript</FieldLabel>
        <Textarea
          id="userscript-code"
          value={draft.code}
          required
          disabled={busy}
          spellCheck={false}
          className="max-h-96 min-h-48 overflow-auto font-mono text-xs"
          onChange={(event) => setDraft({ ...draft, code: event.target.value })}
        />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          Save changes
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={cancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function statusLabel(script: UserScriptSummary): string {
  if (!script.enabled) return "Disabled";
  if (script.registered) return "Runs on page load";
  if (!script.siteAccess) return "Needs site access";
  return "Waiting to run";
}

/** Lets the user see, change and remove the scripts the agent saved, and grant them site access. */
export function UserScriptsSettings({ storage }: { storage: KeyValueStore }) {
  const [scripts, setScripts] = useState<UserScriptSummary[]>([]);
  const [status, setStatus] = useState<UserScriptsStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<UserScriptDetails>();

  const refresh = useCallback(async () => {
    try {
      const [nextScripts, nextStatus] = await Promise.all([
        userscripts.list(),
        userscripts.status(),
      ]);
      setScripts(nextScripts);
      setStatus(nextStatus);
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const permissionChanged = () => void refresh();
    const unwatch = storage.watch(SCRIPTS_KEY, () => void refresh());
    chrome.permissions.onAdded.addListener(permissionChanged);
    chrome.permissions.onRemoved.addListener(permissionChanged);
    return () => {
      unwatch();
      chrome.permissions.onAdded.removeListener(permissionChanged);
      chrome.permissions.onRemoved.removeListener(permissionChanged);
    };
  }, [refresh, storage]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const grantAccess = (script: UserScriptSummary) => {
    // Request immediately in the click handler so Chrome retains the user gesture.
    const permission = chrome.permissions.request({ origins: permissionOrigins(script.matches) });
    void run(async () => {
      if (!(await permission))
        throw new Error("Site access was not granted. The script remains saved.");
      await userscripts.sync();
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <FieldDescription>
        Ask Relay to create a userscript for the page you’re on. Enabled scripts run automatically
        on matching page loads, even when the sidebar is closed. Reload a page to apply edits or
        clear changes from a disabled or deleted script.
      </FieldDescription>
      {status && !status.available ? (
        <Alert>
          <AlertDescription>{status.error}</AlertDescription>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })
              }
            >
              Extension details
            </Button>
            <Button variant="outline" size="sm" onClick={() => chrome.runtime.reload()}>
              Reload Relay
            </Button>
          </div>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
        Refresh scripts
      </Button>
      {!scripts.length ? (
        <p className="text-sm text-muted-foreground">No userscripts yet.</p>
      ) : null}
      {scripts.map((script) => (
        <div key={script.id} className="flex flex-col gap-2">
          <Item variant="outline" size="sm">
            <ItemContent>
              <ItemTitle>{script.name}</ItemTitle>
              {script.description ? <ItemDescription>{script.description}</ItemDescription> : null}
              <p className="wrap-anywhere font-mono text-xs text-muted-foreground">
                {script.matches.join(", ")}
              </p>
              <Badge variant="secondary">{statusLabel(script)}</Badge>
              {script.enabled && script.error ? (
                <p className="text-xs text-destructive">{script.error}</p>
              ) : null}
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={`Enable ${script.name}`}
                checked={script.enabled}
                disabled={busy}
                onCheckedChange={(enabled) =>
                  void run(() => userscripts.setEnabled(script.id, enabled))
                }
              />
            </ItemActions>
            <ItemActions className="basis-full flex-wrap">
              {!script.siteAccess ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => grantAccess(script)}
                >
                  Allow site access
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void run(async () => setEditing(await userscripts.get(script.id)))}
              >
                View / edit
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await userscripts.remove(script.id);
                    if (editing?.id === script.id) setEditing(undefined);
                  })
                }
              >
                Delete
              </Button>
            </ItemActions>
          </Item>
          {editing?.id === script.id ? (
            <ScriptEditor
              key={editing.updatedAt}
              script={editing}
              busy={busy}
              cancel={() => setEditing(undefined)}
              save={(draft) =>
                void run(async () => {
                  await userscripts.save(draft);
                  setEditing(undefined);
                })
              }
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}
