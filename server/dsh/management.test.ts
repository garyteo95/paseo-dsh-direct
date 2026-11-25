import assert from "node:assert/strict";
import test from "node:test";
import type { HostBundleInfo, HostContext, HostServices } from "./host.js";
import { classifyManagementError, DshManagement, validateManagementParams } from "./management.js";
import { pluginInstallSchema } from "../../shared/management.js";

function fixture(options: {
  credentialFailure?: Error;
  runtimeModels?: Array<{ id: string; name?: string }>;
} = {}) {
  let revision = 1;
  let providers: Record<string, unknown> = {
    current: {
      displayName: "Current",
      api: "openai-completions",
      apiKeyEnv: "CURRENT_API_KEY",
      models: [{
        id: "saved-model", contextWindow: 8192, maxTokens: 1024, input: ["text"],
        reasoningEfforts: { high: "high" }, providerExtension: "preserved",
      }],
      preserved: { value: true },
    },
  };
  const settings: NonNullable<HostServices["settings"]> = {
    documentPath: "unused",
    describe: () => [{
      ns: "llm-pi-ai", revision, value: { providers }, user: { providers },
      schema: { providers: { value: { api: { type: "union", list: [{ value: "openai-completions" }] } } } },
    }],
    mutate: async (_ns, ops, expected) => {
      if (expected !== revision) throw Object.assign(new Error("conflict"), { code: "SETTINGS_CONFLICT" });
      for (const op of ops) {
        const id = op.path[1]!;
        if (op.op === "set") providers = { ...providers, [id]: structuredClone(op.value) };
        else { const next = { ...providers }; delete next[id]; providers = next; }
      }
      revision++;
    },
  };
  let receivedSecret: string | undefined;
  let receivedRef: string | undefined;
  const unsetRefs: string[] = [];
  let bundles: HostBundleInfo[] = [{ name: "safe-bundle", version: "1.0.0", enabled: false, installed: true, removable: true, update: "registry" }];
  const pluginCalls: unknown[][] = [];
  const services = {
    settings,
    credentials: {
      describe: async () => ({ configured: true, writable: true, masked: "••••" }),
      set: async (ref: string, value: string) => { receivedRef = ref; receivedSecret = value; if (options.credentialFailure) throw options.credentialFailure; },
      unset: async (ref: string) => { unsetRefs.push(ref); },
    },
    llm: {
      listProviders: () => [],
      listModels: async () => {
        if (options.runtimeModels) return options.runtimeModels;
        throw new Error("dormant");
      },
      listConfigurableProviders: () => [
        { provider: "current", displayName: "Current", settingsNs: "llm-pi-ai", settingsPath: ["providers", "current"] },
        { provider: "candidate", displayName: "Candidate", settingsNs: "llm-pi-ai", settingsPath: ["providers", "candidate"], nativeAuth: { env: ["NATIVE_CANDIDATE_KEY"], oauth: false } },
        { provider: "shared", displayName: "Shared", settingsNs: "llm-pi-ai", settingsPath: ["providers", "shared"], nativeAuth: { env: ["NATIVE_CANDIDATE_KEY"], oauth: false } },
      ],
      discoverModels: async function () {
        assert.equal(typeof this.listModels, "function", "native discovery must retain its service receiver");
        return [{ id: "discovered" }];
      },
    },
    agents: { list: () => [] },
    pluginManager: {
      listBundles: async () => bundles,
      installBundle: async (...args: unknown[]) => {
        pluginCalls.push(["install", ...args]);
        bundles = [...bundles, { name: "new-bundle", version: "1.2.3", enabled: true, installed: true, removable: true, update: "registry" }];
        return { changed: true, application: "applied" };
      },
      setBundleEnabled: async (name: string, enabled: boolean) => {
        pluginCalls.push(["enable", name, enabled]);
        bundles = bundles.map((bundle) => bundle.name === name ? { ...bundle, enabled } : bundle);
        return { changed: true, application: "applied" };
      },
      updateBundle: async (...args: unknown[]) => {
        pluginCalls.push(["update", ...args]);
        bundles = bundles.map((bundle) => bundle.name === args[0] ? { ...bundle, version: "1.1.0" } : bundle);
        return { changed: true, application: "restart-required", restartReason: "Runtime code changed" };
      },
      removeBundle: async (name: string) => {
        pluginCalls.push(["remove", name]);
        bundles = bundles.filter((bundle) => bundle.name !== name);
        return { changed: true, application: "applied" };
      },
      waitForInstall: async (requestId: string) => {
        pluginCalls.push(["status", requestId]);
        return { changed: false, application: "restart-required", requestId };
      },
      cancelInstall: async (requestId: string) => {
        pluginCalls.push(["cancel", requestId]);
        return { status: "cancelled" };
      },
    },
  } as unknown as HostServices;
  const ctx = { get: (name: keyof HostServices) => services[name] } as HostContext;
  return {
    management: new DshManagement(ctx, "test"),
    receivedSecret: () => receivedSecret,
    receivedRef: () => receivedRef,
    providers: () => structuredClone(providers),
    setProviders(value: Record<string, unknown>) { providers = value; },
    unsetRefs,
    pluginCalls,
    setBundles(value: typeof bundles) { bundles = value; },
  };
}

test("read separates configured routes from addable catalog rows and preserves dormant configured models", async () => {
  const { management } = fixture();
  const view = await management.read();
  assert.equal(view.supported, true);
  assert.deepEqual(view.providers.map((row) => row.id), ["current"]);
  assert.deepEqual(view.addableProviders.map((row) => row.id), ["candidate", "shared"]);
  assert.equal(view.providers[0]?.models[0]?.id, "saved-model");
  assert.equal(view.providers[0]?.activeDependenciesKnown, false);
  assert.equal(view.credentialScope, "Shared DSH home credential store");
});

test("provider create and delete preserve an unrelated configured route", async () => {
  const { management } = fixture();
  const before = await management.read();
  const created = await management.upsert({
    profile: "test", revision: before.revision, id: "candidate", displayName: "Candidate",
    api: "openai-completions", models: [{ id: "candidate-model" }], credential: { action: "keep" },
  });
  assert.deepEqual(created.view.providers.map((provider) => provider.id).sort(), ["candidate", "current"]);
  const removed = await management.remove({
    profile: "test", revision: created.view.revision, id: "candidate", confirmActiveSessions: true,
  });
  assert.deepEqual(removed.providers.map((provider) => provider.id), ["current"]);
});

test("new providers require models and custom routes require a protocol and endpoint", async () => {
  const { management, providers } = fixture();
  const before = await management.read();
  const input = { profile: "test", revision: before.revision, id: "candidate", displayName: "Candidate", models: [], credential: { action: "keep" as const } };
  await assert.rejects(() => management.upsert(input), /at least one model/);
  await assert.rejects(() => management.upsert({ ...input, id: "custom", models: [{ id: "model" }] }), /protocol and base URL/);
  assert.deepEqual(Object.keys(providers()), ["current"]);
});

test("native provider credential uses the catalogue's reference", async () => {
  const { management, receivedRef, providers } = fixture();
  const before = await management.read();
  await management.upsert({
    profile: "test", revision: before.revision, id: "candidate", displayName: "Candidate",
    models: [{ id: "model" }], credential: { action: "set", apiKey: "synthetic-test-key" },
  });
  assert.equal(receivedRef(), "NATIVE_CANDIDATE_KEY");
  assert.equal((providers().candidate as { apiKeyEnv: string }).apiKeyEnv, "NATIVE_CANDIDATE_KEY");
});

test("credential removal respects another provider's implicit native reference", async () => {
  const { management, setProviders, unsetRefs } = fixture();
  setProviders({
    candidate: { displayName: "Candidate", models: [{ id: "model" }], apiKeyEnv: "NATIVE_CANDIDATE_KEY" },
    shared: { displayName: "Shared", models: [{ id: "other-model" }] },
  });
  const before = await management.read();
  const result = await management.upsert({
    profile: "test", revision: before.revision, id: "candidate", displayName: "Candidate",
    models: [{ id: "model" }], credential: { action: "unset" },
  });
  assert.equal(result.credentialApplied, "failed");
  assert.deepEqual(unsetRefs, []);
});

test("provider write reports a credential-stage failure without returning the secret or losing unknown settings", async () => {
  const secret = "secret-value-123";
  const { management, receivedSecret } = fixture({ credentialFailure: Object.assign(new Error(`rejected ${secret}`), { code: "DENIED" }) });
  const before = await management.read();
  const result = await management.upsert({
    profile: "test", revision: before.revision, id: "current", displayName: "Renamed",
    api: "openai-completions", baseURL: "https://example.invalid/v1",
    models: [{ id: "saved-model" }], credential: { action: "set", apiKey: secret },
  });
  assert.equal(receivedSecret(), secret);
  assert.equal(result.settingsApplied, true);
  assert.equal(result.credentialApplied, "failed");
  assert.doesNotMatch(JSON.stringify(result), /secret-value-123/);
  assert.equal(result.view.providers[0]?.displayName, "Renamed");
});

test("runtime catalogue data augments configured metadata and provider-specific model fields survive edits", async () => {
  const { management, providers } = fixture({ runtimeModels: [
    { id: "saved-model", name: "Runtime name" },
    { id: "catalogue-only", name: "Catalogue only" },
  ] });
  const before = await management.read();
  const model = before.providers[0]!.models[0]!;
  assert.equal(model.name, "Runtime name");
  assert.equal(model.contextWindow, 8192);
  assert.equal(model.maxTokens, 1024);
  assert.deepEqual(model.inputModalities, ["text"]);
  assert.deepEqual(model.reasoningEfforts, [{ id: "high", value: "high" }]);
  assert.deepEqual(before.providers[0]!.models.map((row) => row.id), ["saved-model"]);
  await management.upsert({
    profile: "test", revision: before.revision, id: "current", displayName: "Edited",
    api: "openai-completions", models: [model], credential: { action: "keep" },
  });
  const raw = providers().current as { models: Array<Record<string, unknown>> };
  assert.equal(raw.models[0]?.providerExtension, "preserved");
});

test("model discovery, connection checks and explicit model removal use native provider state", async () => {
  const { management, providers } = fixture();
  const before = await management.read();
  const discovery = await management.discover({ profile: "test", revision: before.revision, provider: "current" });
  assert.deepEqual(discovery.models.map((model) => model.id), ["discovered"]);
  assert.equal((await management.test({ profile: "test", revision: before.revision, provider: "current", model: "discovered" })).ok, true);
  assert.equal((await management.test({ profile: "test", revision: before.revision, provider: "current", model: "missing" })).category, "unavailable-model");
  await management.upsert({
    profile: "test", revision: before.revision, id: "current", displayName: "Current",
    api: "openai-completions", models: [], credential: { action: "keep" },
  });
  assert.deepEqual((providers().current as { models: unknown[] }).models, []);
});

test("removing a stored credential invokes the native unset service instead of reporting a no-op", async () => {
  const { management, unsetRefs } = fixture();
  const before = await management.read();
  const result = await management.upsert({
    profile: "test", revision: before.revision, id: "current", displayName: "Current",
    api: "openai-completions", models: before.providers[0]!.models, credential: { action: "unset" },
  });
  assert.equal(result.credentialApplied, "applied");
  assert.deepEqual(unsetRefs, ["CURRENT_API_KEY"]);
});

test("stale revisions and unconfirmed removal fail before a destructive write", async () => {
  const { management, providers, setProviders } = fixture();
  await assert.rejects(() => management.remove({ profile: "test", revision: "stale", id: "current", confirmActiveSessions: true }), /changed/);
  const view = await management.read();
  await assert.rejects(() => management.remove({ profile: "test", revision: view.revision, id: "current", confirmActiveSessions: false }), /confirm removal/);
  setProviders({ ...providers(), current: { ...(providers().current as object), displayName: "Changed elsewhere" } });
  await assert.rejects(() => management.remove({ profile: "test", revision: view.revision, id: "current", confirmActiveSessions: true }), /changed/);
});

test("bridge validation rejects secret whitespace and command-shaped plugin fields", () => {
  assert.throws(() => validateManagementParams("management.provider.discover", {
    profile: "test", revision: "r", apiKey: "bad key",
  }), /credential/);
  assert.throws(() => validateManagementParams("management.plugins.install", {
    profile: "test", revision: "r", source: "registry", name: "safe; whoami", enable: true,
  }), /package/);
  assert.doesNotThrow(() => validateManagementParams("management.plugins.install", {
    profile: "test", revision: "r", source: "git", url: "https://example.invalid/org/repo.git", ref: "v1.0.0", enable: false,
  }));
  for (const url of ["https://user:secret@example.invalid/repo.git", "https://example.invalid/repo.git?token=secret"]) {
    assert.throws(() => validateManagementParams("management.plugins.install", {
      profile: "test", revision: "r", source: "git", url, ref: "v1.0.0", enable: false,
    }), /Git URL/);
    assert.equal(pluginInstallSchema.safeParse({ profile: "test", revision: "r", source: "git", url, enable: false }).success, false);
  }
});

test("Git plugin installation delegates a credential-free structured spec", async () => {
  const { management, pluginCalls } = fixture();
  const view = await management.readPlugins();
  await management.installPlugin({
    profile: "test", revision: view.revision, source: "git",
    url: "https://example.invalid/org/repo.git", ref: "abc123", enable: false,
  });
  assert.deepEqual(pluginCalls[0], [
    "install", "https://example.invalid/org/repo.git#abc123", { enabled: false, saveExact: true },
  ]);
});

test("connection failures are classified without echoing endpoint or credential details", () => {
  assert.equal(classifyManagementError(Object.assign(new Error("HTTP 401 from secret endpoint"), { status: 401 })), "invalid-credential");
  assert.equal(classifyManagementError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), "unreachable");
  assert.equal(classifyManagementError(Object.assign(new Error("rate limited"), { status: 429 })), "rate-limit");
  assert.equal(classifyManagementError(Object.assign(new Error("model missing"), { status: 404 })), "unavailable-model");
  assert.equal(classifyManagementError(Object.assign(new Error("unsupported protocol"), { code: "UNSUPPORTED_API" })), "incompatible-protocol");
});

test("plugin lifecycle delegates only structured operations and reads back every change", async () => {
  const { management, pluginCalls, setBundles } = fixture();
  let view = await management.readPlugins();
  assert.equal(view.plugins[0]?.updateAvailable, null);
  assert.equal(view.plugins[0]?.updateStrategy, "registry");

  let change = await management.togglePlugin({ profile: "test", revision: view.revision, name: "safe-bundle", enabled: true });
  assert.equal(change.view.plugins[0]?.enabled, true);
  change = await management.togglePlugin({ profile: "test", revision: change.view.revision, name: "safe-bundle", enabled: false });
  assert.equal(change.view.plugins[0]?.enabled, false);
  change = await management.updatePlugin({ profile: "test", revision: change.view.revision, name: "safe-bundle" });
  assert.equal(change.application, "restart-required");
  assert.equal(change.view.plugins[0]?.version, "1.1.0");
  change = await management.installPlugin({ profile: "test", revision: change.view.revision, source: "registry", name: "@scope/new", version: "1.2.3", enable: true });
  assert.ok(change.view.plugins.some((plugin) => plugin.name === "new-bundle"));
  change = await management.removePlugin({ profile: "test", revision: change.view.revision, name: "new-bundle" });
  assert.ok(!change.view.plugins.some((plugin) => plugin.name === "new-bundle"));
  assert.ok(pluginCalls.some((call) => JSON.stringify(call) === JSON.stringify([
    "install", "@scope/new@1.2.3", { enabled: true, saveExact: true },
  ])));

  setBundles([{ name: "safe-bundle", version: "1.1.0", enabled: true, installed: true, removable: true, update: { version: "1.2.0" } }]);
  view = await management.readPlugins();
  assert.equal(view.plugins[0]?.updateAvailable, true);
  assert.equal(view.plugins[0]?.updateStrategy, "registry");

  const status = await management.pluginStatus({ profile: "test", revision: "stale-after-install", requestId: "request-1" });
  assert.equal(status.requestId, "request-1");
  const cancelled = await management.cancelPlugin({ profile: "test", revision: "stale-after-install", requestId: "request-1" });
  assert.equal(cancelled.application, "cancelled");
  assert.deepEqual(pluginCalls.slice(-2), [["status", "request-1"], ["cancel", "request-1"]]);
});
