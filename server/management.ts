import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import type { BridgeMethods } from "../shared/bridge-protocol.js";
import type { DshConfigured } from "./dsh-config.js";
import type { DshBridge } from "./bridge-client.js";
import { DEFAULT_PROFILE } from "./bridge-client.js";
import { subagentSettingsTargetKey } from "./subagent-settings.js";

interface Target { configured: DshConfigured; launch?: ProviderLaunch }

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

/** Serializes profile mutations while each operation owns and closes one short-lived bridge. */
export function createManagementAccess(options: {
  target(): Promise<Target>;
  open(target: Target): Promise<DshBridge>;
}) {
  let disposed = false;
  let lane = Promise.resolve();
  const pending = new Set<Promise<unknown>>();
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
      const bridge = await options.open(target);
      try {
        const result = await bridge.request(method, bridged as BridgeMethods[K]["params"]);
        return bindResultRevision(method, result, key);
      } finally {
        await bridge.close();
      }
    };
    const task = write ? lane.then(invoke, invoke) : invoke();
    if (write) lane = task.then(() => undefined, () => undefined);
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  };
  return {
    run,
    async dispose() {
      disposed = true;
      await Promise.allSettled(pending);
      await lane;
    },
  };
}
