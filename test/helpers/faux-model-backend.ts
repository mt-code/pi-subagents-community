/**
 * faux-model-backend.ts — the model/auth plumbing a faux-provider session needs,
 * in one place.
 *
 * `registerFauxProvider` scripts the *responses*, but a session still has to get
 * past model lookup and auth before it streams anything:
 *   - `modelRuntime` is what `createAgentSession` takes: auth via
 *     `getAuth()`/`hasConfiguredAuth()`, and the turn itself streams through
 *     `modelRuntime.streamSimple`.
 *   - `modelRegistry` stands in for `ctx.modelRegistry`, the facade extensions
 *     see, for tests that hand a context to our code directly.
 *
 * Structural fakes (not real instances) keep the suites hermetic — no
 * auth.json, no network, no local login state.
 */
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "./pi-ai.js";

/** The session runtime and the extension-facing registry, for the given faux model. */
export function fauxModelBackend(model: Model<string>): {
  modelRegistry: any;
  modelRuntime: any;
} {
  return {
    modelRegistry: {
      find: () => model,
      getAll: () => [model],
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      // Mirrors ModelRegistry's ResolvedRequestAuth, where `ok` is the
      // discriminant: without `ok: true` a caller reads it as a failure.
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "faux", headers: {} }),
      registerProvider: () => {},
      unregisterProvider: () => {},
    },
    modelRuntime: {
      getModel: () => model,
      getModels: () => [model],
      getProvider: () => undefined,
      getProviders: () => [],
      getAvailable: async () => [model],
      getAvailableSnapshot: () => [model],
      getError: () => undefined,
      hasConfiguredAuth: () => true,
      checkAuth: async () => ({ ok: true }),
      isUsingOAuth: () => false,
      isUsingSubscription: () => false,
      // Shape mirrors ModelRuntime.getAuth: the session reads `auth.apiKey` /
      // `auth.headers` and throws "No API key found" when both are absent.
      getAuth: async () => ({ auth: { apiKey: "faux", headers: {} } }),
      getProviderAuthStatus: () => "configured",
      getCompatibilityRequestConfig: () => ({}),
      getRegisteredProviderIds: () => [],
      getRegisteredProviderConfig: () => undefined,
      getRegisteredNativeProvider: () => undefined,
      registerProvider: () => {},
      registerNativeProvider: () => {},
      unregisterProvider: () => {},
      refresh: async () => ({}),
      // The faux provider registers itself in pi-ai's global api-provider
      // registry, so compat's dispatcher reaches it by `model.api`.
      stream: streamSimple,
      streamSimple,
    },
  };
}
