import type { Credential, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";

// "Sign in with ChatGPT" for a browser extension.
//
// pi-ai ships this flow for Node only (it starts a local callback server). The protocol here is
// the same one, taken from pi-ai's auth/oauth/openai-chatgpt: a public-client PKCE flow whose
// access token is sent straight to api.openai.com. Instead of a callback server, the extension
// watches the sign-in tab for the redirect to the loopback URL and reads the code from it.

const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const AGENT_NAME_HINT = "Relay";
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE = "https://api.openai.com/v1";
const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`;
// Refresh this long before the real expiry so a request never starts with a dying token.
const EXPIRY_MARGIN_MS = 3 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function randomValue(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomValue();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

interface AuthorizationResult {
  code: string;
  clientId: string;
}

/** Parse the redirect URL; throws when it is the callback but carries an error or bad state. */
export function parseCallback(input: string, expectedState: string): AuthorizationResult {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Paste the full callback URL from the browser");
  }
  const expected = new URL(REDIRECT_URI);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new Error(`The callback URL must start with ${REDIRECT_URI}`);
  }
  const error = url.searchParams.get("error");
  if (error) throw new Error(`ChatGPT authorization failed: ${error}`);
  const code = url.searchParams.get("code");
  if (!code) throw new Error("Missing authorization code");
  if (url.searchParams.get("state") !== expectedState) throw new Error("OAuth state mismatch");
  // Every login registers a new client; OpenAI returns the issued id in the callback.
  const clientId = url.searchParams.get("client_id")?.trim();
  if (!clientId) throw new Error("The callback did not contain an issued client ID");
  return { code, clientId };
}

/** Resolves when any tab navigates to the OAuth redirect URL, then closes that tab. */
function waitForRedirect(expectedState: string, signal: AbortSignal): Promise<AuthorizationResult> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("Login cancelled"));
    };
    const onUpdated = (tabId: number, change: { url?: string }) => {
      if (!change.url?.startsWith(REDIRECT_URI)) return;
      cleanup();
      // Nothing listens on the loopback port, so the tab only shows a connection error.
      chrome.tabs.remove(tabId).catch(() => {});
      try {
        resolve(parseCallback(change.url, expectedState));
      } catch (error) {
        reject(error);
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function credentialFromToken(token: Record<string, unknown>, clientId: string): OAuthCredential {
  const text = (field: string) => {
    const value = token[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`OpenAI OAuth token response has invalid ${field}`);
    }
    return value;
  };
  const expiresIn = token.expires_in;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("OpenAI OAuth token response has invalid expires_in");
  }
  const scopes = text("scope").trim().split(/\s+/);
  if (!scopes.includes(DIRECT_TOKEN_SCOPE)) {
    throw new Error(`OpenAI OAuth grant did not include ${DIRECT_TOKEN_SCOPE}`);
  }
  return {
    type: "oauth",
    access: text("access_token"),
    refresh: text("refresh_token"),
    expires: Date.now() + expiresIn * 1000 - EXPIRY_MARGIN_MS,
    clientId,
    scopes,
  };
}

/**
 * A ChatGPT sign-in is only served the Codex models; OpenAI rejects the rest of the catalog
 * with a 400. An API key is served every model.
 */
export function chatgptModels<T extends { id: string }>(
  models: readonly T[],
  credential: Credential | undefined,
): readonly T[] {
  if (credential?.type !== "oauth") return models;
  return models.filter((model) => Object.hasOwn(OPENAI_CODEX_MODELS, model.id));
}

export function chatgptOAuth(): OAuthAuth {
  async function requestToken(body: Record<string, string>, signal: AbortSignal) {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
      signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `OpenAI OAuth token request failed (${response.status}): ${detail || response.statusText}`,
      );
    }
    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error("OpenAI OAuth token response must be an object");
    }
    return data as Record<string, unknown>;
  }

  return {
    name: "OpenAI (ChatGPT subscription)",
    isSubscription: true,
    loginLabel: "Sign in with ChatGPT",

    async login(interaction, options) {
      const deviceId = options?.getDeviceId?.();
      if (!deviceId || !UUID_PATTERN.test(deviceId)) {
        throw new Error("Sign in with ChatGPT requires a device ID for this installation");
      }
      const { verifier, challenge } = await pkce();
      const state = randomValue();

      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: DYNAMIC_CLIENT_ID,
        agent_name_hint: AGENT_NAME_HINT,
        ext_agent_host_id: `urn:uuid:${deviceId.toLowerCase()}`,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
        scope: SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        nonce: randomValue(),
      }).toString();

      // Whichever finishes first wins: the watched redirect or a URL pasted by the user.
      const settled = new AbortController();
      const signal = AbortSignal.any([settled.signal, interaction.signal]);
      const redirect = waitForRedirect(state, signal);
      interaction.notify({
        type: "auth_url",
        url: url.toString(),
        instructions:
          "Finish signing in in the tab that opens. Relay continues on its own when it sees the redirect.",
      });
      const manual = interaction
        .prompt({
          type: "manual_code",
          message:
            "If nothing happens after you sign in, paste the final URL (it starts with http://127.0.0.1:1455) here:",
          placeholder: REDIRECT_URI,
          signal,
        })
        .then((input) => parseCallback(input, state));
      // The loser is aborted below and must not surface as an unhandled rejection.
      redirect.catch(() => {});
      manual.catch(() => {});

      try {
        const result = await Promise.race([redirect, manual]);
        interaction.notify({ type: "progress", message: "Exchanging the code for tokens…" });
        const token = await requestToken(
          {
            grant_type: "authorization_code",
            client_id: result.clientId,
            code: result.code,
            code_verifier: verifier,
            redirect_uri: REDIRECT_URI,
            resource: RESOURCE,
          },
          interaction.signal,
        );
        return credentialFromToken(token, result.clientId);
      } finally {
        settled.abort();
      }
    },

    async refresh(credential, signal) {
      const clientId = credential.clientId;
      if (typeof clientId !== "string" || !clientId.trim()) {
        throw new Error("The stored ChatGPT credential has no client ID; sign in again");
      }
      const token = await requestToken(
        {
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: credential.refresh,
          resource: RESOURCE,
        },
        signal,
      );
      return credentialFromToken(token, clientId);
    },

    async toAuth(credential) {
      return { apiKey: credential.access };
    },
  };
}
