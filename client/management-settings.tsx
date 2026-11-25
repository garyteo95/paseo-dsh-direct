import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import SettingsSection from "./settings-section.js";
import {
  cancelPluginOperation,
  discoverProviderModels,
  installPlugin,
  pluginStatus,
  readManagement,
  readPlugins,
  removePlugin as removePluginRpc,
  removeProvider,
  setPluginEnabled,
  testProvider,
  updatePlugin,
  upsertProvider,
  type ManagedModel,
  type ManagementView,
  type PluginChange,
  type PluginsView,
} from "../shared/management.js";

type Provider = ManagementView["providers"][number];
type Plugin = PluginsView["plugins"][number];
type CredentialAction = "keep" | "set" | "unset";
type ProviderDraft = {
  originalId?: string;
  custom: boolean;
  profile: string;
  revision: string;
  launchRevision: string;
  id: string;
  displayName: string;
  api: string;
  baseURL: string;
  models: ManagedModel[];
  credentialAction: CredentialAction;
  apiKey: string;
};
type ModelDraft = {
  index?: number;
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  inputText: boolean;
  inputImage: boolean;
  reasoningEfforts: string;
  original?: ManagedModel;
};
type ProviderRemoval = {
  provider: Provider;
  profile: string;
  revision: string;
  launchRevision: string;
};
type PluginConfirm = { plugin: Plugin; action: "enable" | "disable" | "update" | "remove" };
const PREFERRED_PROVIDER_IDS = new Set(["zai", "opencode-go"]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalPositiveInteger(value: string, label: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function providerDraft(
  view: ManagementView,
  launchRevision: string,
  provider?: Provider,
  addable?: ManagementView["addableProviders"][number],
): ProviderDraft {
  return {
    originalId: provider?.id,
    custom: !provider && !addable,
    profile: view.profile,
    revision: view.revision,
    launchRevision,
    id: provider?.id ?? addable?.id ?? "",
    displayName: provider?.displayName ?? addable?.displayName ?? "",
    api: provider?.api ?? "",
    baseURL: provider?.baseURL ?? addable?.defaultBaseURL ?? "",
    models: provider?.models.map((model) => ({ ...model })) ?? [],
    credentialAction: !provider && (!addable || PREFERRED_PROVIDER_IDS.has(addable.id)) ? "set" : "keep",
    apiKey: "",
  };
}

function modelDraft(model?: ManagedModel, index?: number): ModelDraft {
  return {
    index,
    id: model?.id ?? "",
    name: model?.name ?? "",
    contextWindow: model?.contextWindow ? String(model.contextWindow) : "",
    maxTokens: model?.maxTokens ? String(model.maxTokens) : "",
    inputText: model?.inputModalities?.includes("text") ?? false,
    inputImage: model?.inputModalities?.includes("image") ?? false,
    reasoningEfforts: model?.reasoningEfforts?.map((effort) => effort.id).join(", ") ?? "",
    original: model,
  };
}

function providerProbeInput(draft: ProviderDraft) {
  if (draft.credentialAction === "set" && !draft.apiKey) throw new Error("Enter an API key");
  return {
    profile: draft.profile,
    revision: draft.revision,
    provider: draft.id.trim() || undefined,
    baseURL: draft.baseURL.trim() || undefined,
    api: draft.api.trim() || undefined,
    apiKey: draft.credentialAction === "set" ? draft.apiKey || undefined : undefined,
  };
}
type ProbeConfirmation = {
  kind: "discover" | "test";
  input: ReturnType<typeof providerProbeInput>;
  model?: string;
};

function isPendingPluginChange(result: PluginChange): boolean {
  return Boolean(result.requestId && !result.changed && result.application !== "failed" && result.application !== "cancelled");
}

function credentialHint(provider: Provider): string {
  if (provider.credential.configured) {
    return `${provider.credential.masked ?? "Stored credential"}${provider.credential.source ? ` · ${provider.credential.source}` : ""}`;
  }
  return provider.credential.source ? `Not stored · ${provider.credential.source}` : "No stored credential";
}

function pluginSupport(plugin: Plugin): string {
  if (plugin.uiSupport === "runtime") return "Runtime support in Paseo";
  if (plugin.uiSupport === "mixed") return "Runtime supported; native DSH UI is not rendered in Paseo";
  if (plugin.uiSupport === "native-ui-only") return "Requires the native DSH graphical interface";
  return "Runtime/UI compatibility is unknown";
}

/** Host-side DSH configuration without copying credentials into Paseo settings. */
export default function ManagementSettings({ theme, host, launchRevision, launchSaving }: {
  theme: PluginSurfaceProps["theme"];
  host: PluginSurfaceProps["host"];
  launchRevision: string;
  launchSaving: boolean;
}) {
  const readManagementRpc = useRpc(readManagement);
  const upsertProviderRpc = useRpc(upsertProvider);
  const removeProviderRpc = useRpc(removeProvider);
  const discoverModelsRpc = useRpc(discoverProviderModels);
  const testProviderRpc = useRpc(testProvider);
  const readPluginsRpc = useRpc(readPlugins);
  const installPluginRpc = useRpc(installPlugin);
  const setPluginEnabledRpc = useRpc(setPluginEnabled);
  const updatePluginRpc = useRpc(updatePlugin);
  const removePluginCall = useRpc(removePluginRpc);
  const pluginStatusRpc = useRpc(pluginStatus);
  const cancelPluginRpc = useRpc(cancelPluginOperation);
  const queryClient = useQueryClient();
  const toast = useToast();

  const managementKey = ["dsh-management", launchRevision] as const;
  const pluginsKey = ["dsh-plugins", launchRevision] as const;
  const managementQuery = useQuery({
    queryKey: managementKey,
    queryFn: () => readManagementRpc({}),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const pluginsQuery = useQuery({
    queryKey: pluginsKey,
    queryFn: () => readPluginsRpc({}),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const management = managementQuery.data;
  const plugins = pluginsQuery.data;
  const preferredProviders = management?.addableProviders.filter((provider) => PREFERRED_PROVIDER_IDS.has(provider.id)) ?? [];
  const otherProviders = management?.addableProviders.filter((provider) => !PREFERRED_PROVIDER_IDS.has(provider.id)) ?? [];

  const [providerEditor, setProviderEditor] = useState<ProviderDraft | null>(null);
  const [showInstalledProviders, setShowInstalledProviders] = useState(false);
  const [modelEditor, setModelEditor] = useState<ModelDraft | null>(null);
  const [providerRemove, setProviderRemove] = useState<ProviderRemoval | null>(null);
  const [providerBusy, setProviderBusy] = useState<string | null>(null);
  const [providerFeedback, setProviderFeedback] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [probeConfirm, setProbeConfirm] = useState<ProbeConfirmation | null>(null);

  const [installOpen, setInstallOpen] = useState(false);
  const [installSource, setInstallSource] = useState<"registry" | "git">("registry");
  const [installName, setInstallName] = useState("");
  const [installVersion, setInstallVersion] = useState("");
  const [installUrl, setInstallUrl] = useState("");
  const [installRef, setInstallRef] = useState("");
  const [installEnable, setInstallEnable] = useState(true);
  const [installConfirmed, setInstallConfirmed] = useState(false);
  const [pluginConfirm, setPluginConfirm] = useState<PluginConfirm | null>(null);
  const [pluginBusy, setPluginBusy] = useState<string | null>(null);
  const [pluginFeedback, setPluginFeedback] = useState<string | null>(null);
  const [pluginError, setPluginError] = useState<string | null>(null);
  const [pendingPluginRequest, setPendingPluginRequest] = useState<string | null>(null);
  const pluginOperationGeneration = useRef(0);

  const busy = launchSaving || providerBusy !== null || pluginBusy !== null;
  const providerTargetChanged = providerEditor !== null && providerEditor.launchRevision !== launchRevision;
  const removalTargetChanged = providerRemove !== null && (
    providerRemove.launchRevision !== launchRevision ||
    providerRemove.profile !== management?.profile ||
    providerRemove.revision !== management?.revision
  );

  const applyPluginChange = (result: PluginChange, label: string) => {
    queryClient.setQueryData(pluginsKey, result.view);
    const application = result.application === "restart-required"
      ? `Restart required${result.restartReason ? `: ${result.restartReason}` : ""}`
      : result.application.replaceAll("-", " ");
    setPluginFeedback(`${label}: ${application}${result.diagnostic ? ` · ${result.diagnostic}` : ""}`);
    setPluginError(result.application === "failed" ? result.diagnostic ?? `${label} failed` : null);
    setPendingPluginRequest(isPendingPluginChange(result) ? result.requestId! : null);
  };

  useEffect(() => {
    if (!pendingPluginRequest || !plugins) return;
    const generation = pluginOperationGeneration.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = (view: PluginsView) => {
      timer = setTimeout(() => {
        void pluginStatusRpc({ profile: view.profile, revision: view.revision, requestId: pendingPluginRequest })
          .then((result) => {
            if (stopped || generation !== pluginOperationGeneration.current) return;
            applyPluginChange(result, "DSH plugin operation");
            if (isPendingPluginChange(result) && result.view.revision === view.revision) poll(result.view);
          })
          .catch((error) => { if (!stopped && generation === pluginOperationGeneration.current) setPluginError(errorMessage(error)); });
      }, 1_000);
    };
    poll(plugins);
    return () => { stopped = true; clearTimeout(timer); };
  }, [pendingPluginRequest, plugins?.profile, plugins?.revision]);

  const startProviderEdit = (provider?: Provider, addable?: ManagementView["addableProviders"][number]) => {
    if (!management || busy) return;
    setProviderFeedback(null);
    setProviderError(null);
    setModelEditor(null);
    setProbeConfirm(null);
    setProviderEditor(providerDraft(management, launchRevision, provider, addable));
  };

  const reviewProbe = (kind: ProbeConfirmation["kind"]) => {
    if (!providerEditor || busy || providerTargetChanged) return;
    try {
      setProviderError(null);
      setProbeConfirm({
        kind,
        input: providerProbeInput(providerEditor),
        ...(kind === "test" ? { model: providerEditor.models[0]?.id } : {}),
      });
    } catch (error) {
      setProviderError(errorMessage(error));
    }
  };

  const saveModel = () => {
    if (!providerEditor || !modelEditor) return;
    try {
      const id = modelEditor.id.trim();
      if (!id) throw new Error("Model ID is required");
      const reasoningIds = [...new Set(modelEditor.reasoningEfforts.split(",").map((value) => value.trim()).filter(Boolean))];
      const model: ManagedModel = {
        ...modelEditor.original,
        id,
        ...(modelEditor.name.trim() ? { name: modelEditor.name.trim() } : { name: undefined }),
        contextWindow: optionalPositiveInteger(modelEditor.contextWindow, "Context window"),
        maxTokens: optionalPositiveInteger(modelEditor.maxTokens, "Maximum output tokens"),
        inputModalities: modelEditor.inputText || modelEditor.inputImage
          ? [modelEditor.inputText ? "text" as const : undefined, modelEditor.inputImage ? "image" as const : undefined].filter((value): value is "text" | "image" => value !== undefined)
          : undefined,
        reasoningEfforts: reasoningIds.length
          ? reasoningIds.map((effortId) => modelEditor.original?.reasoningEfforts?.find((effort) => effort.id === effortId) ?? { id: effortId })
          : undefined,
      };
      if (providerEditor.models.some((row, index) => row.id === id && index !== modelEditor.index)) {
        throw new Error(`Model ${id} is already in this provider`);
      }
      const models = [...providerEditor.models];
      if (modelEditor.index === undefined) models.push(model);
      else models[modelEditor.index] = model;
      setProviderEditor({ ...providerEditor, models });
      setModelEditor(null);
      setProbeConfirm(null);
      setProviderError(null);
    } catch (error) {
      setProviderError(errorMessage(error));
    }
  };

  const saveProvider = async () => {
    if (!providerEditor || busy || providerTargetChanged) return;
    setProviderBusy("Saving provider");
    setProviderError(null);
    try {
      if (!providerEditor.originalId && providerEditor.models.length === 0) throw new Error("Add at least one model");
      if (providerEditor.custom && (!providerEditor.api.trim() || !providerEditor.baseURL.trim())) {
        throw new Error("Choose an API protocol and enter its base URL");
      }
      if (providerEditor.credentialAction === "set" && !providerEditor.apiKey) throw new Error("Enter an API key");
      const credential = providerEditor.credentialAction === "set"
        ? { action: "set" as const, apiKey: providerEditor.apiKey }
        : providerEditor.credentialAction === "unset"
          ? { action: "unset" as const }
          : { action: "keep" as const };
      const result = await upsertProviderRpc({
        profile: providerEditor.profile,
        revision: providerEditor.revision,
        id: providerEditor.id.trim(),
        displayName: providerEditor.displayName.trim(),
        api: providerEditor.api.trim() || undefined,
        baseURL: providerEditor.baseURL.trim() || undefined,
        models: providerEditor.models,
        credential,
      });
      queryClient.setQueryData(managementKey, result.view);
      const feedback = [result.settingsApplied
        ? "Provider settings were saved and read back from DSH."
        : "Provider settings were not saved."];
      if (result.credentialApplied === "failed") feedback.push("The API key was not updated; retry the key update.");
      else if (result.credentialApplied === "applied") feedback.push("The API key was updated.");
      if (result.catalogRefreshed === false) feedback.push(result.catalogDiagnostic ?? "The model did not appear in the Paseo picker.");
      setProviderFeedback(feedback.join(" "));
      setProviderEditor((draft) => draft && ({
        ...draft,
        profile: result.view.profile,
        revision: result.view.revision,
        ...(result.credentialApplied === "applied" ? { credentialAction: "keep" as const, apiKey: "" } : {}),
      }));
      const partial = !result.settingsApplied || result.credentialApplied === "failed" || result.catalogRefreshed === false;
      if (partial) setProviderError("The operation completed only partially. Review the result before retrying.");
      else {
        setProviderEditor(null);
        toast.show("Model provider saved", { variant: "success" });
      }
    } catch (error) {
      setProviderError(errorMessage(error));
    } finally {
      setProviderBusy(null);
      setProbeConfirm(null);
    }
  };

  const discoverModels = async () => {
    if (!providerEditor || busy || providerTargetChanged || probeConfirm?.kind !== "discover") return;
    setProviderBusy("Discovering models");
    setProviderError(null);
    try {
      const result = await discoverModelsRpc(probeConfirm.input);
      if (result.failure && !result.failure.ok) {
        setProviderError(`${result.failure.category ?? "unknown"}: ${result.failure.diagnostic ?? "Model discovery failed"}`);
        return;
      }
      const models = new Map(providerEditor.models.map((model) => [model.id, model]));
      for (const model of result.models) models.set(model.id, { ...models.get(model.id), ...model });
      setProviderEditor({ ...providerEditor, models: [...models.values()] });
      setProviderFeedback(`Discovered ${result.models.length} model${result.models.length === 1 ? "" : "s"}; save to apply`);
    } catch (error) {
      setProviderError(errorMessage(error));
    } finally {
      setProviderBusy(null);
      setProbeConfirm(null);
    }
  };

  const runProviderTest = async () => {
    if (!providerEditor || busy || providerTargetChanged || probeConfirm?.kind !== "test") return;
    setProviderBusy("Testing provider");
    setProviderError(null);
    try {
      const result = await testProviderRpc({
        ...probeConfirm.input,
        model: probeConfirm.model,
      });
      const text = result.ok ? result.diagnostic ?? "Model appears in the DSH catalogue" : `${result.category ?? "unknown"}: ${result.diagnostic ?? "Catalogue check failed"}`;
      setProviderFeedback(`${text}${result.billable ? " · The provider may bill this request" : ""}`);
      if (!result.ok) setProviderError(text);
      else toast.show("DSH model catalogue checked", { variant: "success" });
    } catch (error) {
      setProviderError(errorMessage(error));
    } finally {
      setProviderBusy(null);
      setProbeConfirm(null);
    }
  };

  const confirmProviderRemoval = async () => {
    if (!providerRemove || busy || removalTargetChanged) return;
    setProviderBusy("Removing provider");
    setProviderError(null);
    try {
      const result = await removeProviderRpc({
        profile: providerRemove.profile,
        revision: providerRemove.revision,
        id: providerRemove.provider.id,
        // The management bridge cannot see agents owned by other session
        // bridges. Reaching this handler is the user's explicit confirmation
        // of that uncertainty in the removal modal.
        confirmActiveSessions: true,
      });
      queryClient.setQueryData(managementKey, result.view);
      setProviderFeedback(`Removed ${providerRemove.provider.displayName}; unrelated routes were preserved${result.catalogRefreshed ? "" : ` · ${result.catalogDiagnostic ?? "picker refresh failed"}`}`);
      if (!result.catalogRefreshed) setProviderError("The provider was removed, but the model picker did not refresh. Refresh it before starting a new session.");
      setProviderRemove(null);
      toast.show("Model provider removed", { variant: "success" });
    } catch (error) {
      setProviderError(errorMessage(error));
    } finally {
      setProviderBusy(null);
    }
  };

  const runPluginAction = async (confirmation: PluginConfirm) => {
    if (!plugins || busy) return;
    const { plugin, action } = confirmation;
    pluginOperationGeneration.current++;
    setPluginBusy(`${action[0]!.toUpperCase()}${action.slice(1)} ${plugin.name}`);
    setPluginError(null);
    try {
      const target = { profile: plugins.profile, revision: plugins.revision, name: plugin.name };
      const result = action === "enable" ? await setPluginEnabledRpc({ ...target, enabled: true })
        : action === "disable" ? await setPluginEnabledRpc({ ...target, enabled: false })
          : action === "update" ? await updatePluginRpc(target)
            : await removePluginCall(target);
      applyPluginChange(result, `${action} ${plugin.name}`);
      setPluginConfirm(null);
      if (isPendingPluginChange(result)) toast.show("DSH plugin operation started", { variant: "success" });
      else if (result.application !== "failed") toast.show("DSH plugin operation completed", { variant: "success" });
    } catch (error) {
      setPluginError(errorMessage(error));
    } finally {
      setPluginBusy(null);
    }
  };

  const runPluginInstall = async () => {
    if (!plugins || busy) return;
    pluginOperationGeneration.current++;
    setPluginBusy("Installing DSH plugin");
    setPluginError(null);
    try {
      const target = { profile: plugins.profile, revision: plugins.revision };
      const result = installSource === "registry"
        ? await installPluginRpc({ ...target, source: "registry", name: installName.trim(), version: installVersion.trim() || undefined, enable: installEnable })
        : await installPluginRpc({ ...target, source: "git", url: installUrl.trim(), ref: installRef.trim() || undefined, enable: installEnable });
      applyPluginChange(result, "Install DSH plugin");
      if (result.application !== "failed") {
        setInstallOpen(false);
        setInstallConfirmed(false);
        toast.show(isPendingPluginChange(result) ? "DSH plugin installation started" : "DSH plugin installation complete", { variant: "success" });
      }
    } catch (error) {
      setPluginError(errorMessage(error));
    } finally {
      setPluginBusy(null);
    }
  };

  const cancelPendingPlugin = async () => {
    if (!plugins || !pendingPluginRequest || pluginBusy) return;
    pluginOperationGeneration.current++;
    setPluginBusy("Cancelling DSH plugin operation");
    try {
      const result = await cancelPluginRpc({ profile: plugins.profile, revision: plugins.revision, requestId: pendingPluginRequest });
      applyPluginChange(result, "Cancel DSH plugin operation");
    } catch (error) {
      setPluginError(errorMessage(error));
    } finally {
      setPluginBusy(null);
    }
  };

  const providerEditorContent = providerEditor && (
    <>
      <SettingsSection theme={theme} title="Provider">
        <SettingsInput key={`provider-id-${providerEditor.originalId ?? "new"}`} label="Provider ID" hint={providerEditor.originalId ? "Stable ID; create a new provider to rename it" : "Lowercase letters, numbers, dots, dashes or underscores"} initialValue={providerEditor.id} onChangeText={(id) => { setProbeConfirm(null); setProviderEditor({ ...providerEditor, id }); }} disabled={busy || providerEditor.originalId !== undefined} />
        <SettingsInput label="Display name" initialValue={providerEditor.displayName} onChangeText={(displayName) => setProviderEditor({ ...providerEditor, displayName })} disabled={busy} />
        <SettingsSelect label="API protocol" value={providerEditor.api} options={[{ label: "Use provider default", value: "" }, ...(management?.protocols ?? []).map((choice) => ({ label: choice.label, value: choice.id }))]} onValueChange={(api) => { setProbeConfirm(null); setProviderEditor({ ...providerEditor, api }); }} disabled={busy} />
        <SettingsInput label="Base URL" placeholder="https://gateway.example/v1" initialValue={providerEditor.baseURL} onChangeText={(baseURL) => { setProbeConfirm(null); setProviderEditor({ ...providerEditor, baseURL }); }} disabled={busy} />
      </SettingsSection>
      <SettingsSection theme={theme} title="Credential">
        <SettingsSelect
          label="API key"
          hint="Stored keys are write-only and never returned to this page"
          value={providerEditor.credentialAction}
          options={[{ label: "Keep saved credential or environment fallback", value: "keep" }, { label: "Add or replace key", value: "set" }, { label: "Remove stored override", value: "unset" }]}
          onValueChange={(credentialAction) => { setProbeConfirm(null); setProviderEditor({ ...providerEditor, credentialAction, apiKey: credentialAction === "set" ? providerEditor.apiKey : "" }); }}
          disabled={busy}
        />
        {providerEditor.credentialAction === "set" && <SettingsInput label="New API key" hint="Sent once to the DSH credential service" secureTextEntry initialValue={providerEditor.apiKey} onChangeText={(apiKey) => { setProbeConfirm(null); setProviderEditor({ ...providerEditor, apiKey }); }} disabled={busy} />}
        {providerEditor.credentialAction === "unset" && <SettingsRow label="Stored override will be removed" hint="DSH will fall back to configured environment or provider-native authentication" />}
      </SettingsSection>
      <SettingsSection theme={theme} title={`Models (${providerEditor.models.length})`}>
        {providerEditor.models.map((model, index) => (
          <SettingsAction key={`${model.id}-${index}`} label={model.name || model.id} hint={`${model.id}${model.contextWindow ? ` · ${model.contextWindow} context` : ""}${model.maxTokens ? ` · ${model.maxTokens} max output` : ""}${model.inputModalities?.length ? ` · ${model.inputModalities.join("+")}` : ""}${model.reasoningEfforts?.length ? ` · reasoning: ${model.reasoningEfforts.map((effort) => effort.id).join(", ")}` : ""}`} actionLabel="Edit" onPress={() => setModelEditor(modelDraft(model, index))} disabled={busy} />
        ))}
        <SettingsAction label="Add a model manually" actionLabel="Add" onPress={() => setModelEditor(modelDraft())} disabled={busy} />
        <SettingsAction label="Discover available models" hint="Updates this draft only; built-in providers may use DSH's local catalogue" actionLabel={providerBusy === "Discovering models" ? "Discovering" : "Review"} onPress={() => reviewProbe("discover")} disabled={busy || !providerEditor.id.trim()} />
        {probeConfirm?.kind === "discover" && <>
          <SettingsRow label="Review model discovery" hint={`DSH may query ${probeConfirm.input.baseURL || "the selected provider's default endpoint"} or use its local catalogue.${probeConfirm.input.apiKey ? " A new credential may be sent to the endpoint." : " A saved credential may be used."} No inference request is sent.`} />
          <SettingsAction label="Discover models" actionLabel="Discover" onPress={() => void discoverModels()} disabled={busy} />
          <SettingsAction label="Cancel model discovery" actionLabel="Cancel" onPress={() => setProbeConfirm(null)} disabled={busy} />
        </>}
      </SettingsSection>
      {modelEditor && (
        <SettingsSection theme={theme} title={modelEditor.index === undefined ? "New model" : "Edit model"}>
          <SettingsInput label="Model ID" initialValue={modelEditor.id} onChangeText={(id) => setModelEditor({ ...modelEditor, id })} disabled={busy} />
          <SettingsInput label="Display name" initialValue={modelEditor.name} onChangeText={(name) => setModelEditor({ ...modelEditor, name })} disabled={busy} />
          <SettingsInput label="Context window" placeholder="Optional positive integer" initialValue={modelEditor.contextWindow} onChangeText={(contextWindow) => setModelEditor({ ...modelEditor, contextWindow })} disabled={busy} />
          <SettingsInput label="Maximum output tokens" placeholder="Optional positive integer" initialValue={modelEditor.maxTokens} onChangeText={(maxTokens) => setModelEditor({ ...modelEditor, maxTokens })} disabled={busy} />
          <SettingsSwitch label="Text input" value={modelEditor.inputText} onValueChange={(inputText) => setModelEditor({ ...modelEditor, inputText })} disabled={busy} />
          <SettingsSwitch label="Image input" value={modelEditor.inputImage} onValueChange={(inputImage) => setModelEditor({ ...modelEditor, inputImage })} disabled={busy} />
          <SettingsInput label="Reasoning levels" hint="Comma-separated IDs reported by the provider, such as low, high, max" initialValue={modelEditor.reasoningEfforts} onChangeText={(reasoningEfforts) => setModelEditor({ ...modelEditor, reasoningEfforts })} disabled={busy} />
          <SettingsAction label="Apply model to draft" actionLabel="Apply" onPress={saveModel} disabled={busy} />
          {modelEditor.index !== undefined && <SettingsAction label="Remove model from draft" hint="The provider is unchanged until you save" actionLabel="Remove" onPress={() => { setProbeConfirm(null); setProviderEditor({ ...providerEditor, models: providerEditor.models.filter((_, index) => index !== modelEditor.index) }); setModelEditor(null); }} disabled={busy} />}
          <SettingsAction label="Discard model edits" actionLabel="Cancel" onPress={() => setModelEditor(null)} disabled={busy} />
        </SettingsSection>
      )}
      <SettingsSection theme={theme} title="Verify and save">
        {probeConfirm?.kind !== "test" ? (
          <SettingsAction label="Check DSH model catalogue" hint="Built-in routes may use local metadata; success does not prove the endpoint or key works" actionLabel="Review check" onPress={() => reviewProbe("test")} disabled={busy || providerEditor.models.length === 0} />
        ) : (
          <>
            <SettingsRow label="Model catalogue check" hint={`DSH will check ${probeConfirm.model ?? "the configured model"} and may query ${probeConfirm.input.baseURL || "the selected provider endpoint"}.${probeConfirm.input.apiKey ? " The new credential may be sent to that endpoint." : " A saved credential may be used."} Built-in routes may use local metadata, so success does not prove endpoint access or account entitlement. A real inference test may be billable.`} />
            <SettingsAction label="Check model registration" actionLabel="Check" onPress={() => void runProviderTest()} disabled={busy} />
            <SettingsAction label="Cancel catalogue check" actionLabel="Cancel" onPress={() => setProbeConfirm(null)} disabled={busy} />
          </>
        )}
        {providerTargetChanged && <SettingsRow label="Connection settings changed" error="Discard this draft and reopen it for the current DSH target." />}
        {providerFeedback && <SettingsRow label="Last provider operation" hint={providerFeedback} />}
        {providerError && <SettingsRow label="Provider operation failed" error={providerError} />}
        <SettingsAction label={providerBusy ?? "Save provider"} hint="DSH remains authoritative; successful writes are read back before this page updates" actionLabel={providerBusy ? "Working" : "Save"} onPress={() => void saveProvider()} disabled={busy || providerTargetChanged || modelEditor !== null} />
        <SettingsAction label="Discard provider draft" actionLabel="Cancel" onPress={() => { setProviderEditor(null); setModelEditor(null); setProbeConfirm(null); }} disabled={busy} />
      </SettingsSection>
    </>
  );

  return (
    <>
      <SettingsSection theme={theme} title="DSH management host">
        <SettingsCard>
          <SettingsRow label={host.label} hint={`Effective profile: ${management?.profile ?? plugins?.profile ?? "Loading…"}`} />
          <SettingsRow label="Host trust boundary" hint="Anyone authorised to control this Paseo host can invoke these management operations. Before entering a key remotely, use an authenticated, protected relay, VPN or TLS connection." />
          <SettingsRow label="Credentials stay in DSH" hint={management?.credentialScope ?? "Keys are sent once to the daemon host and are never returned to Paseo clients."} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection theme={theme} title="Model providers">
        {!management && <SettingsRow label={managementQuery.isError ? "Could not load model providers" : "Loading model providers"} error={managementQuery.isError ? errorMessage(managementQuery.error) : undefined} />}
        {management && !management.supported && <SettingsRow label="Provider management unavailable" hint={management.reason} />}
        {management?.providers.filter((provider) => provider.configured).map((provider) => (
          <SettingsCard key={provider.id}>
            <SettingsRow label={provider.displayName} hint={`${provider.id}${provider.api ? ` · ${provider.api}` : ""}${provider.baseURL ? ` · ${provider.baseURL}` : ""}`} error={provider.diagnostic} />
            <SettingsRow label="Credential" hint={credentialHint(provider)} />
            <SettingsRow label={`${provider.models.length} configured model${provider.models.length === 1 ? "" : "s"}`} hint={provider.models.map((model) => model.name || model.id).join(", ") || "Uses provider catalog/defaults"} />
            <SettingsAction label="Provider settings and models" actionLabel="Edit" onPress={() => startProviderEdit(provider)} disabled={busy || !management.supported} />
            <SettingsAction label="Remove provider" hint={provider.activeDependenciesKnown ? `${provider.activeSessionIds.length} active session dependenc${provider.activeSessionIds.length === 1 ? "y" : "ies"}` : "Active session dependencies could not be confirmed"} actionLabel="Review removal" onPress={() => { setProviderError(null); setProviderRemove({ provider, profile: management.profile, revision: management.revision, launchRevision }); }} disabled={busy || !management.supported} />
          </SettingsCard>
        ))}
        {management?.supported && management.providers.every((provider) => !provider.configured) && <SettingsRow label="No configured model providers" hint="Configure the API connection and its model IDs below." />}
        {preferredProviders.map((provider) => <SettingsAction key={provider.id} label={`Add ${provider.displayName}`} hint={provider.defaultBaseURL ?? provider.diagnostic ?? provider.id} actionLabel="Add" onPress={() => startProviderEdit(undefined, provider)} disabled={busy} />)}
        {management?.supported && <SettingsAction label="Add a custom model API" hint="Set the API protocol, endpoint, key and model IDs" actionLabel="Configure" onPress={() => startProviderEdit()} disabled={busy} />}
        {management?.supported && otherProviders.length > 0 && <SettingsAction label="Other DSH providers" hint={showInstalledProviders ? "Hide available DSH providers" : "Optional: browse the remaining DSH provider catalogue"} actionLabel={showInstalledProviders ? "Hide" : "Show"} onPress={() => setShowInstalledProviders((shown) => !shown)} disabled={busy} />}
        {showInstalledProviders && otherProviders.map((provider) => <SettingsAction key={provider.id} label={`Add ${provider.displayName}`} hint={provider.diagnostic ?? provider.id} actionLabel="Add" onPress={() => startProviderEdit(undefined, provider)} disabled={busy} />)}
        {providerFeedback && !providerEditor && <SettingsRow label="Last provider operation" hint={providerFeedback} />}
        {providerError && !providerEditor && <SettingsRow label="Provider operation failed" error={providerError} />}
        {managementQuery.isError && management && <SettingsRow label="Could not refresh model providers" error={errorMessage(managementQuery.error)} hint="The previous successful state is still shown" />}
        <SettingsAction label={managementQuery.isFetching ? "Refreshing provider state" : "Refresh providers"} actionLabel={managementQuery.isError ? "Retry" : "Refresh"} onPress={() => void managementQuery.refetch()} disabled={busy || managementQuery.isFetching} />
      </SettingsSection>

      <SettingsSection theme={theme} title="DSH plugins">
        {!plugins && <SettingsRow label={pluginsQuery.isError ? "Could not load DSH plugins" : "Loading DSH plugins"} error={pluginsQuery.isError ? errorMessage(pluginsQuery.error) : undefined} />}
        {plugins && !plugins.supported && <SettingsRow label="DSH plugin management unavailable" hint={plugins.reason} />}
        {plugins?.plugins.map((plugin) => (
          <SettingsCard key={plugin.name}>
            <SettingsRow label={plugin.name} hint={`${plugin.version ?? "Version unknown"} · ${plugin.enabled ? "Enabled" : "Disabled"} · ${pluginSupport(plugin)}`} error={plugin.error} />
            {plugin.description && <SettingsRow label="Description" hint={plugin.description} />}
            <SettingsRow label="Update status" hint={plugin.updateAvailable === true ? "Update available" : plugin.updateAvailable === false ? "Current" : "Not reported by this DSH source"} />
            <SettingsAction label={plugin.enabled ? "Disable plugin" : "Enable plugin"} hint="Changes apply according to the DSH result shown after confirmation" actionLabel={plugin.enabled ? "Review disable" : "Review enable"} onPress={() => { setPluginError(null); setPluginConfirm({ plugin, action: plugin.enabled ? "disable" : "enable" }); }} disabled={busy || !!plugin.readOnlyReason} error={plugin.readOnlyReason} />
            {plugin.updateStrategy === "registry" && <SettingsAction label={plugin.updateAvailable ? "Update available" : "Check for registry update"} hint="DSH resolves and applies the registry update" actionLabel="Review update" onPress={() => { setPluginError(null); setPluginConfirm({ plugin, action: "update" }); }} disabled={busy || !!plugin.readOnlyReason} />}
            {plugin.removable && <SettingsAction label="Remove DSH plugin" actionLabel="Review removal" onPress={() => { setPluginError(null); setPluginConfirm({ plugin, action: "remove" }); }} disabled={busy} />}
          </SettingsCard>
        ))}
        {plugins?.supported && plugins.plugins.length === 0 && <SettingsRow label="No DSH plugins reported for this profile" />}
        {plugins?.supported && <SettingsAction label="Install DSH plugin" hint="Registry packages and HTTPS Git sources only" actionLabel="Install" onPress={() => { setPluginError(null); setInstallConfirmed(false); setInstallOpen(true); }} disabled={busy} />}
        {pendingPluginRequest && <SettingsAction label={pluginBusy ?? "DSH plugin operation is running"} hint={`Operation ${pendingPluginRequest}`} actionLabel="Cancel" onPress={() => void cancelPendingPlugin()} disabled={pluginBusy !== null} />}
        {pluginFeedback && <SettingsRow label="Last plugin operation" hint={pluginFeedback} />}
        {pluginError && <SettingsRow label="Plugin operation failed" error={pluginError} />}
        {pluginsQuery.isError && plugins && <SettingsRow label="Could not refresh DSH plugins" error={errorMessage(pluginsQuery.error)} hint="The previous successful state is still shown" />}
        <SettingsAction label={pluginsQuery.isFetching ? "Checking plugin state and updates" : "Refresh plugins and updates"} actionLabel={pluginsQuery.isError ? "Retry" : "Refresh"} onPress={() => void pluginsQuery.refetch()} disabled={busy || pluginsQuery.isFetching} />
      </SettingsSection>

      <Modal title={providerEditor?.originalId ? "Edit model provider" : "Add model provider"} open={providerEditor !== null} onOpenChange={(open) => { if (!open && !providerBusy) { setProviderEditor(null); setModelEditor(null); setProbeConfirm(null); } }}>
        <Modal.Content>{providerEditorContent}</Modal.Content>
      </Modal>

      <Modal title="Remove model provider" open={providerRemove !== null} onOpenChange={(open) => { if (!open && !providerBusy) setProviderRemove(null); }}>
        <Modal.Content>
          {providerRemove && <>
            <SettingsSection theme={theme} title="Confirm removal">
              <SettingsRow label={`Remove ${providerRemove.provider.displayName}?`} hint={`Provider ID: ${providerRemove.provider.id}. Unrelated providers and credentials are not removed.`} />
              <SettingsRow label={providerRemove.provider.activeDependenciesKnown ? `${providerRemove.provider.activeSessionIds.length} active session dependencies` : "Active dependencies are unknown"} error={!providerRemove.provider.activeDependenciesKnown ? "DSH could not confirm every active dependency. Removal may make stored selections unavailable." : undefined} />
              {removalTargetChanged && <SettingsRow label="DSH target changed" error="Close this confirmation and review the provider again before removing it." />}
              {providerError && <SettingsRow label="Removal failed" error={providerError} />}
              <SettingsAction label="Remove provider despite unknown dependencies" hint="The revision is rechecked; dependencies in other DSH processes remain unknown." actionLabel={providerBusy ? "Removing" : "Remove"} onPress={() => void confirmProviderRemoval()} disabled={busy || removalTargetChanged} />
              <SettingsAction label="Keep provider" actionLabel="Cancel" onPress={() => setProviderRemove(null)} disabled={busy} />
            </SettingsSection>
          </>}
        </Modal.Content>
      </Modal>

      <Modal title="Install DSH plugin" open={installOpen} onOpenChange={(open) => { if (!open && !pluginBusy) { setInstallOpen(false); setInstallConfirmed(false); } }}>
        <Modal.Content>
          <SettingsSection theme={theme} title="Source">
            <SettingsSelect label="Source type" value={installSource} options={[{ label: "npm registry package", value: "registry" }, { label: "HTTPS Git repository", value: "git" }]} onValueChange={(source) => { setInstallSource(source); setInstallConfirmed(false); }} disabled={busy} />
            {installSource === "registry" ? <>
              <SettingsInput label="Package name" placeholder="@scope/package" initialValue={installName} onChangeText={(value) => { setInstallName(value); setInstallConfirmed(false); }} disabled={busy} />
              <SettingsInput label="Version or tag" placeholder="Optional" initialValue={installVersion} onChangeText={(value) => { setInstallVersion(value); setInstallConfirmed(false); }} disabled={busy} />
            </> : <>
              <SettingsInput label="HTTPS Git URL" placeholder="https://github.com/owner/repository.git" initialValue={installUrl} onChangeText={(value) => { setInstallUrl(value); setInstallConfirmed(false); }} disabled={busy} />
              <SettingsInput label="Git ref" placeholder="Optional tag, branch or commit" initialValue={installRef} onChangeText={(value) => { setInstallRef(value); setInstallConfirmed(false); }} disabled={busy} />
            </>}
            <SettingsSwitch label="Enable after installation" value={installEnable} onValueChange={(enable) => { setInstallEnable(enable); setInstallConfirmed(false); }} disabled={busy} />
          </SettingsSection>
          <SettingsSection theme={theme} title="Install">
            {pluginError && <SettingsRow label="Installation failed" error={pluginError} />}
            {!installConfirmed ? <SettingsAction label="Review installation" hint="DSH bundles are trusted host code. Install only a source you trust." actionLabel="Review" onPress={() => setInstallConfirmed(true)} disabled={busy || (installSource === "registry" ? !installName.trim() : !installUrl.trim())} /> : <>
              <SettingsRow label="Trusted code confirmation" hint={`Install ${installSource === "registry" ? installName : installUrl} into profile ${plugins?.profile ?? "unknown"}?`} />
              <SettingsAction label={pluginBusy ?? "Install confirmed DSH bundle"} actionLabel={pluginBusy ? "Installing" : "Install"} onPress={() => void runPluginInstall()} disabled={busy} />
              <SettingsAction label="Return to source fields" actionLabel="Back" onPress={() => setInstallConfirmed(false)} disabled={busy} />
            </>}
          </SettingsSection>
        </Modal.Content>
      </Modal>

      <Modal title="Confirm DSH plugin change" open={pluginConfirm !== null} onOpenChange={(open) => { if (!open && !pluginBusy) setPluginConfirm(null); }}>
        <Modal.Content>
          {pluginConfirm && <SettingsSection theme={theme} title="Confirm change">
            <SettingsRow label={`${pluginConfirm.action[0]!.toUpperCase()}${pluginConfirm.action.slice(1)} ${pluginConfirm.plugin.name}?`} hint={`${pluginSupport(pluginConfirm.plugin)}. DSH will report whether this applies immediately or requires a restart.`} />
            {pluginConfirm.action === "remove" && <SettingsRow label="Removal is destructive" hint="Sessions and credentials are not deleted, but new sessions will no longer load this bundle." />}
            {pluginError && <SettingsRow label="Plugin change failed" error={pluginError} />}
            <SettingsAction label={`Confirm ${pluginConfirm.action}`} actionLabel={pluginBusy ? "Working" : "Confirm"} onPress={() => void runPluginAction(pluginConfirm)} disabled={busy} />
            <SettingsAction label="Keep current plugin state" actionLabel="Cancel" onPress={() => setPluginConfirm(null)} disabled={busy} />
          </SettingsSection>}
        </Modal.Content>
      </Modal>
    </>
  );
}
