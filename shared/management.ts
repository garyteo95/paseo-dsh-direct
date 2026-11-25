import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const managementFailureKindSchema = z.enum([
  "invalid-credential",
  "unreachable",
  "incompatible-protocol",
  "unavailable-model",
  "rate-limit",
  "unsupported",
  "unknown",
]);
export type ManagementFailureKind = z.infer<typeof managementFailureKindSchema>;

const nonempty = z.string().trim().min(1);
const secret = z.string().min(1).regex(/^[\x21-\x7E]+$/, "Credential contains unsupported characters");
const providerId = nonempty.regex(/^[a-z][a-z0-9._-]*$/, "Invalid provider id");
const modelSchema = z.object({
  id: nonempty,
  name: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  inputModalities: z.array(z.enum(["text", "image"])).optional(),
  reasoningEfforts: z.array(z.object({ id: nonempty, name: z.string().optional(), value: z.string().optional() })).optional(),
});
export type ManagedModel = z.infer<typeof modelSchema>;

const credentialStateSchema = z.object({
  configured: z.boolean(),
  writable: z.boolean(),
  masked: z.string().optional(),
  source: z.string().optional(),
});

const protocolChoiceSchema = z.object({ id: nonempty, label: nonempty });
const providerSchema = z.object({
  id: nonempty,
  displayName: nonempty,
  api: z.string().optional(),
  baseURL: z.string().optional(),
  credentialRef: z.string().optional(),
  credential: credentialStateSchema,
  models: z.array(modelSchema),
  configured: z.boolean(),
  activeDependenciesKnown: z.boolean(),
  activeSessionIds: z.array(z.string()),
  diagnostic: z.string().optional(),
});

export const managementViewSchema = z.object({
  supported: z.boolean(),
  reason: z.string().optional(),
  hostLabel: z.literal("Paseo daemon host"),
  profile: nonempty,
  credentialScope: z.literal("Shared DSH home credential store"),
  revision: z.string(),
  protocols: z.array(protocolChoiceSchema),
  providers: z.array(providerSchema),
  addableProviders: z.array(z.object({
    id: nonempty,
    displayName: nonempty,
    defaultBaseURL: z.string().optional(),
    diagnostic: z.string().optional(),
  })),
});
export type ManagementView = z.infer<typeof managementViewSchema>;

const credentialUpdateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("keep") }),
  z.object({ action: z.literal("set"), apiKey: secret }),
  z.object({ action: z.literal("unset") }),
]);

export const managementUpsertSchema = z.object({
  profile: nonempty,
  revision: nonempty,
  id: providerId,
  displayName: nonempty,
  api: z.string().trim().optional(),
  baseURL: z.string().trim().optional(),
  models: z.array(modelSchema),
  credential: credentialUpdateSchema,
});
export type ManagementUpsert = z.infer<typeof managementUpsertSchema>;
export const providerMutationResultSchema = z.object({
  view: managementViewSchema,
  settingsApplied: z.boolean(),
  credentialApplied: z.enum(["not-requested", "applied", "failed"]),
  diagnostic: z.string().optional(),
  catalogRefreshed: z.boolean().optional(),
  catalogDiagnostic: z.string().optional(),
});
export type ProviderMutationResult = z.infer<typeof providerMutationResultSchema>;

export const managementRemoveSchema = z.object({
  profile: nonempty,
  revision: nonempty,
  id: providerId,
  confirmActiveSessions: z.boolean(),
});
export type ManagementRemove = z.infer<typeof managementRemoveSchema>;
export const providerRemovalResultSchema = z.object({
  view: managementViewSchema,
  catalogRefreshed: z.boolean(),
  catalogDiagnostic: z.string().optional(),
});
export type ProviderRemovalResult = z.infer<typeof providerRemovalResultSchema>;

export const modelDiscoverySchema = z.object({
  profile: nonempty,
  revision: nonempty,
  provider: z.string().trim().optional(),
  baseURL: z.string().trim().optional(),
  api: z.string().trim().optional(),
  apiKey: secret.optional(),
});
export type ModelDiscovery = z.infer<typeof modelDiscoverySchema>;

export const managementTestSchema = modelDiscoverySchema.extend({ model: nonempty.optional() });
export type ManagementTest = z.infer<typeof managementTestSchema>;
export const operationResultSchema = z.object({
  ok: z.boolean(),
  billable: z.boolean(),
  category: managementFailureKindSchema.optional(),
  diagnostic: z.string().optional(),
});
export type OperationResult = z.infer<typeof operationResultSchema>;

export const readManagement = defineRpc({
  name: "dsh-management.read",
  input: z.object({}),
  output: managementViewSchema,
});
export const upsertProvider = defineRpc({
  name: "dsh-management.provider.upsert",
  input: managementUpsertSchema,
  output: providerMutationResultSchema,
});
export const removeProvider = defineRpc({
  name: "dsh-management.provider.remove",
  input: managementRemoveSchema,
  output: providerRemovalResultSchema,
});
export const discoverProviderModels = defineRpc({
  name: "dsh-management.provider.discover",
  input: modelDiscoverySchema,
  output: z.object({ models: z.array(modelSchema), failure: operationResultSchema.optional() }),
});
export const testProvider = defineRpc({
  name: "dsh-management.provider.test",
  input: managementTestSchema,
  output: operationResultSchema,
});

const pluginApplicationSchema = z.enum([
  "applied", "restart-required", "overridden", "failed", "cancelled",
]);
function safeGitUrl(value: string): boolean {
  return /^https:\/\/[^/?#@\s]+(?:\/[^?#\s]*)?$/.test(value);
}
const pluginSchema = z.object({
  name: nonempty,
  version: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean(),
  installed: z.boolean(),
  removable: z.boolean(),
  updateAvailable: z.boolean().nullable(),
  updateStrategy: z.enum(["registry", "unknown"]),
  readOnlyReason: z.string().optional(),
  error: z.string().optional(),
  uiSupport: z.enum(["runtime", "native-ui-only", "mixed", "unknown"]),
});
export const pluginsViewSchema = z.object({
  supported: z.boolean(),
  reason: z.string().optional(),
  hostLabel: z.literal("Paseo daemon host"),
  profile: nonempty,
  revision: z.string(),
  plugins: z.array(pluginSchema),
});
export type PluginsView = z.infer<typeof pluginsViewSchema>;
export const pluginChangeSchema = z.object({
  changed: z.boolean(),
  application: pluginApplicationSchema,
  restartReason: z.string().optional(),
  diagnostic: z.string().optional(),
  requestId: z.string().optional(),
  view: pluginsViewSchema,
});
export type PluginChange = z.infer<typeof pluginChangeSchema>;
const packageName = nonempty.regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i, "Invalid package name");
const gitUrl = z.string().url().refine(safeGitUrl, "Git URL must be HTTPS and must not contain credentials, query parameters or fragments");
const pluginTarget = { profile: nonempty, revision: nonempty };
export const pluginInstallSchema = z.discriminatedUnion("source", [
  z.object({ ...pluginTarget, source: z.literal("registry"), name: packageName, version: nonempty.regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/).optional(), enable: z.boolean() }),
  z.object({ ...pluginTarget, source: z.literal("git"), url: gitUrl, ref: nonempty.regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/).optional(), enable: z.boolean() }),
]);
export type PluginInstall = z.infer<typeof pluginInstallSchema>;
export const pluginActionSchema = z.object({ ...pluginTarget, name: packageName });
export type PluginAction = z.infer<typeof pluginActionSchema>;
export const pluginToggleSchema = pluginActionSchema.extend({ enabled: z.boolean() });
export type PluginToggle = z.infer<typeof pluginToggleSchema>;
export const pluginUpdateSchema = pluginActionSchema.extend({ version: nonempty.optional() });
export type PluginUpdate = z.infer<typeof pluginUpdateSchema>;
export const pluginOperationSchema = z.object({ ...pluginTarget, requestId: nonempty });
export type PluginOperation = z.infer<typeof pluginOperationSchema>;

export const readPlugins = defineRpc({ name: "dsh-management.plugins.read", input: z.object({}), output: pluginsViewSchema });
export const installPlugin = defineRpc({ name: "dsh-management.plugins.install", input: pluginInstallSchema, output: pluginChangeSchema });
export const setPluginEnabled = defineRpc({ name: "dsh-management.plugins.enable", input: pluginToggleSchema, output: pluginChangeSchema });
export const updatePlugin = defineRpc({ name: "dsh-management.plugins.update", input: pluginUpdateSchema, output: pluginChangeSchema });
export const removePlugin = defineRpc({ name: "dsh-management.plugins.remove", input: pluginActionSchema, output: pluginChangeSchema });
export const pluginStatus = defineRpc({ name: "dsh-management.plugins.status", input: pluginOperationSchema, output: pluginChangeSchema });
export const cancelPluginOperation = defineRpc({ name: "dsh-management.plugins.cancel", input: pluginOperationSchema, output: pluginChangeSchema });
