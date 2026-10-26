import { expect, test } from "vite-plus/test";

import { chatgptModels, parseCallback } from "./chatgpt-oauth.ts";

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
  expect(() => parseCallback(`${CALLBACK}?error=access_denied`, "s1")).toThrow("access_denied");
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
