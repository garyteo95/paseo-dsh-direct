import { createHash } from "node:crypto";
import type {
  ManagementRemove,
  ManagementFailureKind,
  ManagementTest,
  ManagementUpsert,
  ManagementView,
  ModelDiscovery,
  PluginAction,
  PluginInstall,
  PluginOperation,
  PluginToggle,
  PluginUpdate,
  PluginsView,
  ProviderMutationResult,
} from "../../shared/management.js";
import type { HostContext, HostPluginChangeResult, HostServices, HostSettingsDescriptor } from "./host.js";

const SETTINGS_NS = "llm-pi-ai";
const PROVIDERS_PATH = "providers";
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`Unsupported management field: ${extra[0]}`);
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a nonempty string`);
  return value;
}
function target(value: Record<string, unknown>): void {
  requiredString(value.profile, "profile"); requiredString(value.revision, "revision");
}

/** Defense in depth for the private stdio boundary; public RPC schemas validate first. */
export function validateManagementParams(method: string, value: Record<string, unknown>): void {
  if (method === "management.read" || method === "management.plugins.read") { keys(value, []); return; }
  if (method === "management.provider.upsert") {
    keys(value, ["profile", "revision", "id", "displayName", "api", "baseURL", "models", "credential"]); target(value);
    providerId(value.id); requiredString(value.displayName, "displayName");
    if (!Array.isArray(value.models)) throw new Error("models must be an array");
    for (const raw of value.models) {
      const model = object(raw); keys(model, ["id", "name", "contextWindow", "maxTokens", "inputModalities", "reasoningEfforts"]);
      requiredString(model.id, "model id");
      for (const field of ["contextWindow", "maxTokens"] as const) if (model[field] !== undefined &&
        (typeof model[field] !== "number" || !Number.isSafeInteger(model[field]) || model[field] <= 0)) throw new Error(`Invalid ${field}`);
      if (model.inputModalities !== undefined && (!Array.isArray(model.inputModalities) || model.inputModalities.some((item) => item !== "text" && item !== "image"))) throw new Error("Invalid input modalities");
      if (model.reasoningEfforts !== undefined && (!Array.isArray(model.reasoningEfforts) || model.reasoningEfforts.some((item) => {
        const effort = object(item); return !text(effort.id) || (effort.name !== undefined && typeof effort.name !== "string") || (effort.value !== undefined && typeof effort.value !== "string");
      }))) throw new Error("Invalid reasoning efforts");
    }
    const credential = object(value.credential); keys(credential, ["action", "apiKey"]);
    if (!['keep', 'set', 'unset'].includes(String(credential.action))) throw new Error("Invalid credential action");
    if (credential.action === "set" && (typeof credential.apiKey !== "string" || !/^[\x21-\x7E]+$/.test(credential.apiKey))) throw new Error("Invalid credential value");
    return;
  }
  if (method === "management.provider.remove") {
    keys(value, ["profile", "revision", "id", "confirmActiveSessions"]); target(value); providerId(value.id);
    if (typeof value.confirmActiveSessions !== "boolean") throw new Error("confirmActiveSessions must be boolean"); return;
  }
  if (method === "management.provider.discover" || method === "management.provider.test") {
    keys(value, ["profile", "revision", "provider", "baseURL", "api", "apiKey", ...(method.endsWith("test") ? ["model"] : [])]); target(value);
    for (const field of ["provider", "baseURL", "api", ...(method.endsWith("test") ? ["model"] : [])]) if (value[field] !== undefined && typeof value[field] !== "string") throw new Error(`Invalid ${field}`);
    if (value.apiKey !== undefined && (typeof value.apiKey !== "string" || !/^[\x21-\x7E]+$/.test(value.apiKey))) throw new Error("Invalid credential value"); return;
  }
  if (method.startsWith("management.plugins.")) {
    const common = ["profile", "revision"];
    if (method.endsWith("install")) {
      keys(value, [...common, "source", "name", "version", "url", "ref", "enable"]); target(value);
      if (value.source === "registry") {
        if (typeof value.name !== "string" || !PACKAGE_NAME.test(value.name)) throw new Error("Invalid package name");
        if (value.version !== undefined && (typeof value.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value.version))) throw new Error("Invalid package version");
      } else if (value.source === "git") {
        if (typeof value.url !== "string" || !/^https:\/\/[^#\s]+$/.test(value.url)) throw new Error("Invalid Git URL");
        if (value.ref !== undefined && (typeof value.ref !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(value.ref))) throw new Error("Invalid Git ref");
      }
      else throw new Error("Invalid plugin source");
      if (typeof value.enable !== "boolean") throw new Error("enable must be boolean"); return;
    }
    keys(value, [...common, method.endsWith("status") || method.endsWith("cancel") ? "requestId" : "name", ...(method.endsWith("enable") ? ["enabled"] : []), ...(method.endsWith("update") ? ["version"] : [])]); target(value);
    const field = method.endsWith("status") || method.endsWith("cancel") ? "requestId" : "name";
    requiredString(value[field], field); if (field === "name" && !PACKAGE_NAME.test(value.name as string)) throw new Error("Invalid package name");
    if (method.endsWith("enable") && typeof value.enabled !== "boolean") throw new Error("enabled must be boolean"); return;
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function providerId(value: unknown): string {
  const id = text(value);
  if (!id || !/^[a-z][a-z0-9._-]*$/.test(id)) throw new Error("Invalid provider id");
  return id;
}

function deriveKeyRef(id: string): string {
  return `${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

function sanitize(error: unknown): string {
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
  return code ? `DSH operation failed (${code})` : "DSH operation failed";
}

export function classifyManagementError(error: unknown): ManagementFailureKind {
  const value = object(error);
  const code = `${text(value.code) ?? ""} ${typeof value.status === "number" ? value.status : ""} ${text(value.message) ?? ""}`.toUpperCase();
  if (/AUTH|CREDENTIAL|401|403|MISSING_CREDENTIAL/.test(code)) return "invalid-credential";
  if (/RATE|429/.test(code)) return "rate-limit";
  if (/MODEL|404/.test(code)) return "unavailable-model";
  if (/PROTOCOL|UNSUPPORTED_API|NO_DISCOVERY/.test(code)) return "incompatible-protocol";
  if (/NETWORK|CONNECT|TIMEOUT|DNS|ECONN|ENET|EHOST/.test(code)) return "unreachable";
  if (/UNSUPPORTED|UNAVAILABLE/.test(code)) return "unsupported";
  return "unknown";
}

function revisionOf(descriptor: HostSettingsDescriptor): string {
  return createHash("sha256").update(JSON.stringify({
    ns: descriptor.ns,
    revision: descriptor.revision,
    user: descriptor.user,
  })).digest("hex");
}

function protocolsFrom(schema: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, underApi = false): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (underApi) {
          const literal = text(object(item).value);
          if (literal) found.add(literal);
        }
        visit(item, underApi);
      }
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) visit(child, underApi || key === "api");
  };
  visit(schema);
  return [...found];
}

interface Snapshot {
  settings: NonNullable<HostServices["settings"]>;
  descriptor: HostSettingsDescriptor;
  revision: string;
  providers: Record<string, unknown>;
}

export class DshManagement {
  constructor(private readonly ctx: HostContext, private readonly profile: string) {}

  private optional<K extends keyof HostServices>(name: K): HostServices[K] | undefined {
    try { return this.ctx.get(name); } catch { return undefined; }
  }

  private snapshot(): Snapshot | undefined {
    const settings = this.optional("settings");
    if (!settings || settings.writable === false || typeof settings.describe !== "function" || typeof settings.mutate !== "function") return;
    const descriptor = settings.describe({ redactSecrets: true }).find((row) => row.ns === SETTINGS_NS);
    if (!descriptor || !Number.isSafeInteger(descriptor.revision) || descriptor.revision < 0) return;
    return {
      settings,
      descriptor,
      revision: revisionOf(descriptor),
      providers: object(object(descriptor.value)[PROVIDERS_PATH]),
    };
  }

  private credentialInfo(ref: string): Promise<{ configured: boolean; writable: boolean; masked?: string; source?: string }> {
    const credentials = this.optional("credentials");
    if (!credentials?.describe) return Promise.resolve({ configured: false, writable: false });
    return Promise.resolve(credentials.describe(ref)).then((info) => ({
      configured: info.configured,
      writable: info.writable,
      ...(text(info.masked) ? { masked: text(info.masked)! } : {}),
      ...(text(info.source) ? { source: text(info.source)! } : {}),
    }));
  }

  private unsupported(reason: string): ManagementView {
    return {
      supported: false, reason, hostLabel: "Paseo daemon host", profile: this.profile,
      credentialScope: "Shared DSH home credential store", revision: "", protocols: [], providers: [], addableProviders: [],
    };
  }

  async read(): Promise<ManagementView> {
    const snapshot = this.snapshot();
    const llm = this.optional("llm");
    if (!snapshot) return this.unsupported("This DSH profile does not provide writable model-provider settings.");
    if (!llm?.listConfigurableProviders) return this.unsupported("This DSH runtime does not expose configurable model providers.");
    const directory = llm.listConfigurableProviders().filter((row) => row.settingsNs === SETTINGS_NS);
    const directoryById = new Map(directory.map((row) => [row.provider, row]));
    const ids = Object.keys(snapshot.providers);
    const providers = await Promise.all(ids.map(async (id) => {
      const profile = object(snapshot.providers[id]);
      const directoryRow = directoryById.get(id);
      const ref = text(profile.apiKeyEnv) ?? deriveKeyRef(id);
      const configuredModels = Array.isArray(profile.models) ? profile.models.map((raw) => {
        const model = object(raw);
        const id = text(model.id);
        if (!id) return;
        return {
          id,
          ...(text(model.name) ? { name: text(model.name)! } : {}),
          ...(typeof model.contextWindow === "number" && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
          ...(typeof model.maxTokens === "number" && model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
          ...(Array.isArray(model.input) ? { inputModalities: model.input.filter((item): item is "text" | "image" => item === "text" || item === "image") } : {}),
          ...(object(model.reasoningEfforts) && Object.keys(object(model.reasoningEfforts)).length
            ? { reasoningEfforts: Object.entries(object(model.reasoningEfforts)).map(([id, value]) => ({ id, ...(typeof value === "string" ? { value } : {}) })) } : {}),
        };
      }).filter((model): model is NonNullable<typeof model> => model !== undefined) : [];
      let models: ManagementView["providers"][number]["models"] = configuredModels;
      try {
        const merged = new Map(configuredModels.map((model) => [model.id, { ...model }]));
        for (const model of await llm.listModels(id)) {
          merged.set(model.id, {
            ...merged.get(model.id),
            id: model.id,
            ...(model.name ? { name: model.name } : {}),
          });
        }
        models = [...merged.values()];
        for (const model of models) {
          try {
            const info = await llm.resolveModelInfo?.(id, model.id);
            if (info?.context?.contextWindow) model.contextWindow = info.context.contextWindow;
            if (info?.defaultMaxTokens) model.maxTokens = info.defaultMaxTokens;
            const modalities = info?.inputModalities?.filter((item): item is "text" | "image" => item === "text" || item === "image");
            if (modalities?.length) model.inputModalities = modalities;
            if (info?.reasoning?.efforts) {
              const efforts = new Map(model.reasoningEfforts?.map((effort) => [effort.id, effort]) ?? []);
              for (const effort of info.reasoning.efforts) efforts.set(effort.id, { ...efforts.get(effort.id), id: effort.id, name: effort.name });
              model.reasoningEfforts = [...efforts.values()];
            }
          } catch { /* Optional per-model metadata does not hide the route. */ }
        }
      } catch { /* Keep configured model rows for a dormant or invalid route. */ }
      return {
        id,
        displayName: text(profile.displayName) ?? directoryRow?.displayName ?? id,
        ...(text(profile.api) ? { api: text(profile.api)! } : {}),
        ...(text(profile.baseURL) ?? directoryRow?.defaultBaseURL
          ? { baseURL: text(profile.baseURL) ?? directoryRow!.defaultBaseURL! } : {}),
        credentialRef: ref,
        credential: await this.credentialInfo(ref),
        models,
        configured: true,
        activeDependenciesKnown: false,
        activeSessionIds: [],
        ...(directoryRow?.error ? { diagnostic: "Provider configuration is invalid." } : {}),
      };
    }));
    return {
      supported: true,
      hostLabel: "Paseo daemon host",
      profile: this.profile,
      credentialScope: "Shared DSH home credential store",
      revision: snapshot.revision,
      protocols: protocolsFrom(snapshot.descriptor.schema).map((id) => ({ id, label: id })),
      providers,
      addableProviders: directory.filter((row) => !Object.hasOwn(snapshot.providers, row.provider)).map((row) => ({
        id: row.provider,
        displayName: row.displayName,
        ...(row.defaultBaseURL ? { defaultBaseURL: row.defaultBaseURL } : {}),
        ...(row.error ? { diagnostic: "Provider configuration is invalid." } : {}),
      })),
    };
  }

  private requireSnapshot(profile: string, revision: string): Snapshot {
    if (profile !== this.profile) throw new Error("DSH profile changed; reload before saving");
    const snapshot = this.snapshot();
    if (!snapshot) throw new Error("Model-provider settings are unavailable");
    if (revision !== snapshot.revision) throw new Error("Model-provider settings changed; reload before saving");
    return snapshot;
  }

  async upsert(input: ManagementUpsert): Promise<ProviderMutationResult> {
    const snapshot = this.requireSnapshot(input.profile, input.revision);
    const id = providerId(input.id);
    const existing = object(snapshot.providers[id]);
    const ref = text(existing.apiKeyEnv) ?? deriveKeyRef(id);
    const existingModels = new Map(
      (Array.isArray(existing.models) ? existing.models : [])
        .map((raw) => object(raw))
        .filter((model) => text(model.id))
        .map((model) => [text(model.id)!, model]),
    );
    const models = input.models.map((model) => {
      const row: Record<string, unknown> = { ...existingModels.get(model.id), id: model.id };
      const optional = (field: string, value: unknown) => {
        if (value === undefined) delete row[field];
        else row[field] = value;
      };
      optional("name", model.name);
      optional("contextWindow", model.contextWindow);
      optional("maxTokens", model.maxTokens);
      const unmanagedModalities = Array.isArray(row.input)
        ? row.input.filter((value) => value !== "text" && value !== "image")
        : [];
      const input = [...(model.inputModalities ?? []), ...unmanagedModalities];
      optional("input", input.length ? input : undefined);
      optional("reasoningEfforts", model.reasoningEfforts
        ? Object.fromEntries(model.reasoningEfforts.map((effort) => [effort.id, effort.value ?? effort.id]))
        : undefined);
      return row;
    });
    const profile: Record<string, unknown> = {
      ...existing,
      displayName: input.displayName,
      models,
      ...(input.credential.action === "set" ? { apiKeyEnv: ref } : {}),
    };
    if (input.api) profile.api = input.api; else delete profile.api;
    if (input.baseURL) profile.baseURL = input.baseURL; else delete profile.baseURL;
    await snapshot.settings.mutate(SETTINGS_NS, [{ op: "set", path: [PROVIDERS_PATH, id], value: profile }], snapshot.descriptor.revision);
    let credentialApplied: ProviderMutationResult["credentialApplied"] = "not-requested";
    let diagnostic: string | undefined;
    if (input.credential.action !== "keep") {
      const credentials = this.optional("credentials");
      if (!credentials) {
        credentialApplied = "failed";
        diagnostic = "Provider saved, but the DSH credential service is unavailable.";
      } else try {
        if (input.credential.action === "set") await credentials.set(ref, input.credential.apiKey);
        else {
          if (Object.entries(snapshot.providers).some(([otherId, raw]) => otherId !== id && text(object(raw).apiKeyEnv) === ref)) {
            throw Object.assign(new Error("Credential reference is shared"), { code: "CREDENTIAL_IN_USE" });
          }
          await credentials.unset(ref);
        }
        credentialApplied = "applied";
      } catch (error) {
        credentialApplied = "failed";
        diagnostic = `Provider saved, but credential update failed. ${sanitize(error)}`;
      }
    }
    const view = await this.read();
    if (!view.providers.some((provider) => provider.id === id)) throw new Error("Provider write did not become visible");
    return { view, settingsApplied: true, credentialApplied, ...(diagnostic ? { diagnostic } : {}) };
  }

  async remove(input: ManagementRemove): Promise<ManagementView> {
    const snapshot = this.requireSnapshot(input.profile, input.revision);
    const id = providerId(input.id);
    if (!input.confirmActiveSessions) throw new Error("Active dependencies cannot be proven from a management bridge; confirm removal to continue");
    await snapshot.settings.mutate(SETTINGS_NS, [{ op: "unset", path: [PROVIDERS_PATH, id] }], snapshot.descriptor.revision);
    const view = await this.read();
    if (view.providers.some((provider) => provider.id === id)) {
      throw new Error("Provider removal did not become visible");
    }
    // Credentials are intentionally retained: another route or profile may reference them.
    return view;
  }

  async discover(input: ModelDiscovery): Promise<{ models: ManagementView["providers"][number]["models"]; failure?: { ok: boolean; billable: boolean; category?: string; diagnostic?: string } }> {
    this.requireSnapshot(input.profile, input.revision);
    const discover = this.optional("llm")?.discoverModels;
    if (!discover) return { models: [], failure: { ok: false, billable: false, category: "unsupported", diagnostic: "Model discovery is unavailable." } };
    try {
      const { profile: _profile, revision: _revision, ...request } = input;
      const models = await discover(SETTINGS_NS, request);
      return { models: models.map((model) => ({
        id: model.id,
        ...(model.name ? { name: model.name } : {}),
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
        ...(model.inputModalities ? { inputModalities: model.inputModalities.filter((item): item is "text" | "image" => item === "text" || item === "image") } : {}),
      })) };
    } catch (error) {
      return { models: [], failure: { ok: false, billable: false, category: classifyManagementError(error), diagnostic: sanitize(error) } };
    }
  }

  async test(input: ManagementTest) {
    const result = await this.discover(input);
    if (result.failure) return result.failure;
    if (input.model && !result.models.some((model) => model.id === input.model)) {
      return { ok: false, billable: false, category: "unavailable-model" as const, diagnostic: "The endpoint did not advertise the requested model." };
    }
    return { ok: true, billable: false };
  }

  async readPlugins(): Promise<PluginsView> {
    const manager = this.optional("pluginManager");
    if (!manager?.listBundles) return {
      supported: false, reason: "This DSH runtime does not expose plugin management.",
      hostLabel: "Paseo daemon host", profile: this.profile, revision: "", plugins: [],
    };
    const bundles = await manager.listBundles();
    return {
      supported: true,
      hostLabel: "Paseo daemon host",
      profile: this.profile,
      revision: createHash("sha256").update(JSON.stringify(bundles.map((bundle) => ({
        name: bundle.name, version: bundle.version, enabled: bundle.enabled,
        installed: bundle.installed, update: bundle.update,
      })))).digest("hex"),
      plugins: bundles.map((bundle) => {
        const registryUpdate = bundle.update === "registry" || (bundle.update !== null && typeof bundle.update === "object");
        return {
          name: bundle.name,
          ...(text(bundle.version) ? { version: text(bundle.version)! } : {}),
          ...(text(bundle.description) ? { description: text(bundle.description)! } : {}),
          enabled: bundle.enabled,
          installed: bundle.installed,
          removable: bundle.removable === true,
          updateAvailable: bundle.update !== null && typeof bundle.update === "object" && text(bundle.update.version)
            ? bundle.update.version !== bundle.version
            : null,
          updateStrategy: registryUpdate ? "registry" as const : "unknown" as const,
          ...(text(bundle.readOnlyReason) ? { readOnlyReason: text(bundle.readOnlyReason)! } : {}),
          ...(bundle.error ? { error: "Bundle reported an error." } : {}),
          uiSupport: "unknown" as const,
        };
      }),
    };
  }

  async pluginChange(result: HostPluginChangeResult) {
    return {
      changed: result.changed,
      application: result.application,
      ...(result.restartReason ? { restartReason: result.restartReason } : {}),
      ...(result.error ? { diagnostic: sanitize(result.error) } : {}),
      ...(result.requestId ? { requestId: result.requestId } : {}),
      view: await this.readPlugins(),
    };
  }

  private async requirePluginTarget(input: { profile: string; revision: string }): Promise<void> {
    this.requirePluginProfile(input);
    const view = await this.readPlugins();
    if (!view.supported) throw new Error(view.reason ?? "DSH plugin management is unavailable");
    if (view.revision !== input.revision) throw new Error("DSH plugins changed; reload before saving");
  }

  private requirePluginProfile(input: { profile: string }): void {
    if (input.profile !== this.profile) throw new Error("DSH profile changed; reload before changing plugins");
  }

  async installPlugin(input: PluginInstall) {
    await this.requirePluginTarget(input);
    const manager = this.optional("pluginManager");
    if (!manager?.installBundle) throw new Error("DSH plugin management is unavailable");
    const spec = input.source === "registry"
      ? `${input.name}${input.version ? `@${input.version}` : ""}`
      : `${input.url}${input.ref ? `#${input.ref}` : ""}`;
    return this.pluginChange(await manager.installBundle(spec, { enabled: input.enable, saveExact: true }));
  }

  async togglePlugin(input: PluginToggle) {
    await this.requirePluginTarget(input);
    const manager = this.optional("pluginManager");
    if (!manager?.setBundleEnabled) throw new Error("DSH plugin management is unavailable");
    return this.pluginChange(await manager.setBundleEnabled(input.name, input.enabled));
  }

  async updatePlugin(input: PluginUpdate) {
    await this.requirePluginTarget(input);
    const manager = this.optional("pluginManager");
    if (!manager?.updateBundle) throw new Error("DSH plugin management is unavailable");
    return this.pluginChange(await manager.updateBundle(input.name, input.version, {}));
  }

  async removePlugin(input: PluginAction) {
    await this.requirePluginTarget(input);
    const manager = this.optional("pluginManager");
    if (!manager?.removeBundle) throw new Error("DSH plugin management is unavailable");
    return this.pluginChange(await manager.removeBundle(input.name));
  }

  async pluginStatus(input: PluginOperation) {
    this.requirePluginProfile(input);
    const manager = this.optional("pluginManager");
    if (!manager?.waitForInstall) throw new Error("DSH plugin management is unavailable");
    const result = await manager.waitForInstall(input.requestId);
    if (!result) throw new Error("DSH has no installation with that request id");
    return this.pluginChange(result);
  }

  async cancelPlugin(input: PluginOperation) {
    this.requirePluginProfile(input);
    const manager = this.optional("pluginManager");
    if (!manager?.cancelInstall) throw new Error("DSH plugin management is unavailable");
    const result = await manager.cancelInstall(input.requestId);
    return this.pluginChange({
      changed: result.status === "cancelled",
      application: result.status === "cancelled" ? "cancelled" : "restart-required",
      ...(result.status === "too-late" ? { restartReason: "Installation is already applying; reconcile its status." } : {}),
    });
  }
}
