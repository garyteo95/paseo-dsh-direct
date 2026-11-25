import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import type { BridgeMethods } from "../shared/bridge-protocol.js";
import type { DshConfigured } from "./dsh-config.js";
import type { DshBridge } from "./bridge-client.js";
import { DEFAULT_PROFILE } from "./bridge-client.js";
import { subagentSettingsTargetKey } from "./subagent-settings.js";

interface Target { configured: DshConfigured; launch?: ProviderLaunch }
interface PendingPluginOperation { bridge: DshBridge; key: string; profile: string }

function pendingOperationId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return;
  const value = result as Record<string, unknown>;
  return typeof value.requestId === "string" && value.requestId && value.changed === false &&
    value.application !== "failed" && value.application !== "cancelled"
    ? value.requestId
    : undefined;
}

function bindResultRevision<K extends keyof BridgeMethods>(
  method: K,
  result: BridgeMethods[K]["result"],
  key: string,
): BridgeMethods[K]["result"] {
  const bindView = (view: unknown) => {
    if (!view || typeof view !== "object" || typeof (view as { revision?: unknown }).revision !== "string") return view;
    const value = view as { revision: string } & Record<string, unknown>;
    return { ...value, revision: `${key}:${value.revision}` };
  };
  if (method === "management.read" || method === "management.provider.remove" || method === "management.plugins.read") {
    return bindView(result) as BridgeMethods[K]["result"];
  }
  if (method === "management.provider.upsert" || method.startsWith("management.plugins.")) {
    const value = result as unknown as { view?: unknown } & Record<string, unknown>;
    return (value.view ? { ...value, view: bindView(value.view) } : value) as BridgeMethods[K]["result"];
  }
  return result;
}

/** Serializes profile mutations and retains the owning bridge while a plugin operation is pending. */
export function createManagementAccess(options: {
  target(): Promise<Target>;
  open(target: Target): Promise<DshBridge>;
}) {
  let disposed = false;
  let lane = Promise.resolve();
  const tasks = new Set<Promise<unknown>>();
  const pluginOperations = new Map<string, PendingPluginOperation>();
  const run = <K extends keyof BridgeMethods>(method: K, input: BridgeMethods[K]["params"], write = false): Promise<BridgeMethods[K]["result"]> => {
    if (disposed) return Promise.reject(new Error("Plugin is shutting down"));
    const invoke = async () => {
      const target = await options.target();
      const profile = target.configured.profile ?? DEFAULT_PROFILE;
      const key = subagentSettingsTargetKey(target);
      const bridged = { ...(input as Record<string, unknown>) };
      if ("profile" in bridged && bridged.profile !== profile) throw new Error("DSH profile changed. Reload before saving.");
      if (typeof bridged.revision === "string") {
        const prefix = `${key}:`;
        if (!bridged.revision.startsWith(prefix)) throw new Error("DSH launch settings changed. Reload before saving.");
        bridged.revision = bridged.revision.slice(prefix.length);
      }
      if (method === "management.plugins.status" || method === "management.plugins.cancel") {
        const requestId = bridged.requestId;
        const operation = typeof requestId === "string" ? pluginOperations.get(requestId) : undefined;
        if (!operation || operation.key !== key || operation.profile !== profile) {
          throw new Error("The pending DSH plugin operation is no longer attached to this plugin process. Refresh plugin state before retrying.");
        }
        const result = await operation.bridge.request(method, bridged as BridgeMethods[K]["params"]);
        if (!pendingOperationId(result)) {
          pluginOperations.delete(requestId as string);
          await operation.bridge.close();
        }
        return bindResultRevision(method, result, key);
      }
      const bridge = await options.open(target);
      let retained = false;
      try {
        const result = await bridge.request(method, bridged as BridgeMethods[K]["params"]);
        const requestId = pendingOperationId(result);
        if (requestId) {
          if (pluginOperations.has(requestId)) throw new Error("DSH returned a duplicate plugin operation id");
          pluginOperations.set(requestId, { bridge, key, profile });
          retained = true;
        }
        return bindResultRevision(method, result, key);
      } finally {
        if (!retained) await bridge.close();
      }
    };
    const task = write ? lane.then(invoke, invoke) : invoke();
    if (write) lane = task.then(() => undefined, () => undefined);
    tasks.add(task);
    void task.then(() => tasks.delete(task), () => tasks.delete(task));
    return task;
  };
  return {
    run,
    async dispose() {
      disposed = true;
      await Promise.allSettled(tasks);
      await lane;
      await Promise.allSettled([...pluginOperations.values()].map(({ bridge }) => bridge.close()));
      pluginOperations.clear();
    },
  };
}
