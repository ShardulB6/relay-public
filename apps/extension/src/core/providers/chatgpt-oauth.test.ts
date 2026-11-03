import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";

import { chatgptModels, chatgptOAuth, issuedClientItem, parseCallback } from "./chatgpt-oauth.ts";

afterEach(async () => {
  vi.unstubAllGlobals();
  await issuedClientItem.removeValue();
});

const CALLBACK = "http://127.0.0.1:1455/auth/callback";

test("reads the code and issued client id from the redirect", () => {
  expect(parseCallback(`${CALLBACK}?code=abc&state=s1&client_id=client-9`, "s1")).toEqual({
    code: "abc",
    clientId: "client-9",
  });
});

test("rejects a wrong state, a provider error, or an unrelated URL", () => {
  expect(() => parseCallback(`${CALLBACK}?code=abc&state=other&client_id=c`, "s1")).toThrow(
    "state mismatch",
  );
  expect(() => parseCallback(`${CALLBACK}?error=access_denied&state=s1`, "s1")).toThrow(
    "access_denied",
  );
  expect(() => parseCallback("https://evil.example/auth/callback?code=abc&state=s1", "s1")).toThrow(
    "must start with",
  );
  expect(() => parseCallback("not a url", "s1")).toThrow("full callback URL");
});

test("a ChatGPT sign-in is offered only the Codex models; an API key gets them all", () => {
  const models = [{ id: "gpt-4" }, { id: "gpt-6.1-sol" }, { id: "o3" }];
  const signIn = { type: "oauth" as const, access: "a", refresh: "r", expires: 0 };

  expect(chatgptModels(models, signIn)).toEqual([{ id: "gpt-6.1-sol" }]);
  expect(chatgptModels(models, { type: "api_key", key: "sk-test" })).toEqual(models);
  expect(chatgptModels(models, undefined)).toEqual(models);
});

test("a reused client may be left out of the callback", () => {
  expect(parseCallback(`${CALLBACK}?code=abc&state=s1`, "s1", "client-9")).toEqual({
    code: "abc",
    clientId: "client-9",
  });
  expect(() => parseCallback(`${CALLBACK}?code=abc&state=s1`, "s1")).toThrow("issued client ID");
});

const DEVICE = { getDeviceId: () => "6f1c2b9e-3a4d-4e5f-8a7b-1c2d3e4f5a6b" };

const tokens = async () =>
  Response.json({
    access_token: "a",
    refresh_token: "r",
    expires_in: 3600,
    scope: "openid chatgpt.tokens.use.direct",
  });

interface SignIn {
  /** The callback URL the user pastes for the sign-in's state. Omit it to cancel the sign-in. */
  callback?: (state: string) => string | Promise<string>;
  /** The token endpoint's reply. */
  token?: () => Promise<Response>;
}

/** Sign in and return the client_id the authorize URL asked for. */
async function signIn({ callback, token = tokens }: SignIn): Promise<string | null> {
  vi.stubGlobal("chrome", {
    tabs: { onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } },
  });
  vi.stubGlobal("fetch", token);
  const abort = new AbortController();
  let authorize: URL | undefined;
  const interaction: ProviderAuthInteraction = {
    signal: abort.signal,
    notify: (event) => {
      if (event.type === "auth_url") authorize = new URL(event.url);
    },
    prompt: (prompt) => {
      if (callback) return Promise.resolve(callback(authorize!.searchParams.get("state")!));
      return new Promise((_, reject) => {
        prompt.signal?.addEventListener("abort", () => reject(new Error("Login cancelled")));
        abort.abort();
      });
    },
  };
  await chatgptOAuth().login(interaction, DEVICE);
  return authorize!.searchParams.get("client_id");
}

test("a sign-in reuses the client the last one registered", async () => {
  const first = await signIn({
    callback: (state) => `${CALLBACK}?code=c&state=${state}&client_id=issued-1`,
  });
  expect(first).toBe("dynamic_agent_client");
  expect(await issuedClientItem.getValue()).toBe("issued-1");

  const second = await signIn({ callback: (state) => `${CALLBACK}?code=c&state=${state}` });
  expect(second).toBe("issued-1");
  expect(await issuedClientItem.getValue()).toBe("issued-1");
});

test("a reused client OpenAI rejects, or a cancelled sign-in, is forgotten", async () => {
  await issuedClientItem.setValue("issued-1");
  await expect(
    signIn({ callback: (state) => `${CALLBACK}?error=invalid_client&state=${state}` }),
  ).rejects.toThrow("invalid_client");
  expect(await issuedClientItem.getValue()).toBeNull();

  await issuedClientItem.setValue("issued-1");
  await expect(
    signIn({
      callback: (state) => `${CALLBACK}?code=c&state=${state}`,
      token: async () => Response.json({ error: "unauthorized_client" }, { status: 401 }),
    }),
  ).rejects.toThrow("unauthorized_client");
  expect(await issuedClientItem.getValue()).toBeNull();

  // OpenAI refuses an unknown client on its own page, so cancelling is the only way out.
  await issuedClientItem.setValue("issued-1");
  await expect(signIn({})).rejects.toThrow("cancelled");
  expect(await issuedClientItem.getValue()).toBeNull();
});

test("other failures keep the reused client", async () => {
  await issuedClientItem.setValue("issued-1");
  await expect(
    signIn({
      callback: (state) => `${CALLBACK}?code=c&state=${state}`,
      token: async () => {
        throw new TypeError("Failed to fetch");
      },
    }),
  ).rejects.toThrow("Failed to fetch");
  await expect(
    signIn({ callback: (state) => `${CALLBACK}?error=access_denied&state=${state}` }),
  ).rejects.toThrow("access_denied");
  expect(await issuedClientItem.getValue()).toBe("issued-1");
});

test("a rejected client is not forgotten over one another side panel has since stored", async () => {
  await issuedClientItem.setValue("issued-1");
  await expect(
    signIn({
      callback: async (state) => {
        await issuedClientItem.setValue("issued-2");
        return `${CALLBACK}?error=invalid_client&state=${state}`;
      },
    }),
  ).rejects.toThrow("invalid_client");
  expect(await issuedClientItem.getValue()).toBe("issued-2");
});

test("a newly registered client is kept when the code exchange fails", async () => {
  await expect(
    signIn({
      callback: (state) => `${CALLBACK}?code=c&state=${state}&client_id=issued-1`,
      token: async () => Response.json({ error: "server_error" }, { status: 503 }),
    }),
  ).rejects.toThrow("503");
  expect(await issuedClientItem.getValue()).toBe("issued-1");

  const retry = await signIn({ callback: (state) => `${CALLBACK}?code=c&state=${state}` });
  expect(retry).toBe("issued-1");
});

test("an error redirect from another sign-in keeps the client", async () => {
  await issuedClientItem.setValue("issued-1");
  await expect(
    signIn({ callback: () => `${CALLBACK}?error=invalid_client&state=other` }),
  ).rejects.toThrow("state mismatch");
  expect(await issuedClientItem.getValue()).toBe("issued-1");
});
