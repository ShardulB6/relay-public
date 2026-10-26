import type { MutableModels, Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

import { chatgptModels, chatgptOAuth } from "./chatgpt-oauth.ts";

/**
 * pi-ai's OAuth logins start a local callback server, which only works in Node. Offer API-key
 * auth only, unless a browser-capable flow is supplied.
 */
function forBrowser(provider: Provider, oauth?: Provider["auth"]["oauth"]): Provider {
  return { ...provider, auth: { apiKey: provider.auth.apiKey, oauth } };
}

/** The model providers Relay supports. Plugins cannot add more. */
export function registerProviders(models: MutableModels): void {
  models.setProvider({
    ...forBrowser(openaiProvider(), chatgptOAuth()),
    filterModels: chatgptModels,
  });
  models.setProvider(forBrowser(openrouterProvider()));
}
