import type { PluginServerContext } from "@getpaseo/plugin/server";
import { DSH_SETTINGS } from "./shared/settings.js";
import { launchDshBridge, type LaunchBridgeOptions } from "./server/bridge-client.js";
import { currentDshConfigured } from "./server/dsh-config.js";
import { defaultDshCommand } from "./server/dsh-spawn.js";
import { DSH_BRIDGE_SOURCE } from "./server/generated-bridge.js";
import { createDshProvider, isBuiltInDeepSeekProvider } from "./server/provider.js";
import type { ProviderConnection, ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { createSubagentSettingsAccess } from "./server/subagent-settings.js";
import { readSubagentSettings, saveSubagentSettings } from "./shared/subagent-settings.js";
import { createManagementAccess } from "./server/management.js";
import { refreshDshModels, type PaseoModels } from "./server/model-catalog-refresh.js";
import {
  cancelPluginOperation,
  discoverProviderModels,
  installPlugin,
  pluginStatus,
  readManagement,
  readPlugins,
  removePlugin,
  removeProvider,
  setPluginEnabled,
  testProvider,
  updatePlugin,
  upsertProvider,
} from "./shared/management.js";

const HOST_EXIT_EVENTS = ["disconnect", "SIGTERM", "SIGINT"] as const;
// A pending host request must not keep an orphaned worker alive after its host is gone.
const HOST_EXIT_DEADLINE_MS = 10_000;

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(DSH_SETTINGS);
  // Read per call, not once: a changed setting applies to new sessions and new catalog discovery.
  const configured = () => currentDshConfigured(process.env, settings);
  const startup = new AbortController();
  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>): Promise<T> => {
    inFlight.add(task);
    void task.then(() => inFlight.delete(task), () => inFlight.delete(task));
    return task;
  };
  const openBridge = (options: LaunchBridgeOptions) =>
    track(launchDshBridge({ ...options, signal: startup.signal }));
  const connections = new Set<ProviderConnection>();
  let providerLaunch: ProviderLaunch | undefined;
  const subagents = createSubagentSettingsAccess({
    target: async () => ({ configured: await configured(), launch: providerLaunch }),
    open: ({ configured: { executable, profile, startupTimeoutMs }, launch }) => openBridge({
      bridgeSource: DSH_BRIDGE_SOURCE, executable, profile, startupTimeoutMs, providerLaunch: launch,
    }),
  });
  const management = createManagementAccess({
    target: async () => ({ configured: await configured(), launch: providerLaunch }),
    open: ({ configured: { executable, profile, startupTimeoutMs }, launch }) => openBridge({
      bridgeSource: DSH_BRIDGE_SOURCE, executable, profile, startupTimeoutMs, providerLaunch: launch,
    }),
  });
  // Provider discovery supplies the same resolved command and environment used for sessions.
  const refreshLaunch = async (
    paseo: import("@getpaseo/client").PaseoApi,
    matches?: (models: PaseoModels) => boolean,
  ) => refreshDshModels(paseo.providers, matches);
  server.handle(readSubagentSettings, async (_input, { paseo }) => {
    await refreshLaunch(paseo);
    return subagents.read();
  });
  server.handle(saveSubagentSettings, async (input, { paseo }) => {
    await refreshLaunch(paseo);
    return subagents.save(input);
  });
  server.handle(readManagement, async (_input, { paseo }) => {
    // Capture the daemon-resolved launch when possible, but a broken model
    // catalog must not hide the management surface that can repair it.
    const showBuiltInDeepSeekModels = (await configured()).showBuiltInDeepSeekModels === true;
    await refreshLaunch(paseo, showBuiltInDeepSeekModels ? undefined :
      (models) => !models.some((model) =>
        typeof model.metadata?.provider === "string" && isBuiltInDeepSeekProvider(model.metadata.provider)))
      .catch(() => undefined);
    return management.run("management.read", {});
  });
  server.handle(upsertProvider, async (input, { paseo }) => {
    const result = await management.run("management.provider.upsert", input, true);
    try {
      const includesSavedModels = (models: PaseoModels) =>
        input.models.every((model) => models?.some((available) =>
          available.metadata?.provider === input.id && available.metadata?.model === model.id));
      const models = await refreshLaunch(paseo, includesSavedModels);
      if (!includesSavedModels(models)) {
        return { ...result, catalogRefreshed: false, catalogDiagnostic: "Provider saved, but its configured model is absent from the Paseo picker. Review the DSH provider configuration." };
      }
      return { ...result, catalogRefreshed: true };
    } catch {
      return { ...result, catalogRefreshed: false, catalogDiagnostic: "Provider saved, but the Paseo model catalog could not refresh." };
    }
  });
  server.handle(removeProvider, async (input, { paseo }) => {
    const view = await management.run("management.provider.remove", input, true);
    try {
      const excludesRemovedProvider = (models: PaseoModels) =>
        !models?.some((model) => model.metadata?.provider === input.id);
      const models = await refreshLaunch(paseo, excludesRemovedProvider);
      if (!excludesRemovedProvider(models)) {
        return { view, catalogRefreshed: false, catalogDiagnostic: "Provider removed, but its models remain in the Paseo picker." };
      }
      return { view, catalogRefreshed: true };
    } catch {
      return { view, catalogRefreshed: false, catalogDiagnostic: "Provider removed, but the Paseo model catalog could not refresh." };
    }
  });
  server.handle(discoverProviderModels, (input) => management.run("management.provider.discover", input));
  server.handle(testProvider, (input) => management.run("management.provider.test", input));
  server.handle(readPlugins, () => management.run("management.plugins.read", {}));
  server.handle(installPlugin, (input) => management.run("management.plugins.install", input, true));
  server.handle(setPluginEnabled, (input) => management.run("management.plugins.enable", input, true));
  server.handle(updatePlugin, (input) => management.run("management.plugins.update", input, true));
  server.handle(removePlugin, (input) => management.run("management.plugins.remove", input, true));
  server.handle(pluginStatus, (input) => management.run("management.plugins.status", input, true));
  server.handle(cancelPluginOperation, (input) => management.run("management.plugins.cancel", input, true));
  const provider = createDshProvider({
    configured,
    observeLaunch: (launch) => { providerLaunch = launch; },
    command: defaultDshCommand(process.env),
    createBridge: async (launch) => {
      startup.signal.throwIfAborted();
      const { executable, profile, startupTimeoutMs } = await configured();
      return openBridge({ ...launch, bridgeSource: DSH_BRIDGE_SOURCE, executable, profile, startupTimeoutMs });
    },
  });
  server.registerProvider({
    ...provider,
    async connect(request) {
      const task = provider.connect(request).then(async (connection) => {
        // Shutdown snapshots `connections` synchronously, so a connection that
        // resolves afterwards must close itself rather than stay open.
        if (startup.signal.aborted) {
          await connection.close();
          startup.signal.throwIfAborted();
        }
        const tracked: ProviderConnection = {
          version: connection.version,
          capabilities: connection.capabilities,
          send: (input) => connection.send(input),
          onEvent: (listener) => connection.onEvent(listener),
          close: () => connection.close().finally(() => { connections.delete(tracked); }),
        };
        connections.add(tracked);
        return tracked;
      });
      return track(task);
    },
  });
  let hostExitHandled = false;
  let shutdownTask: Promise<void> | undefined;
  const shutdown = () => (shutdownTask ??= (async () => {
    startup.abort();
    await Promise.allSettled([
      subagents.dispose(),
      management.dispose(),
      ...inFlight,
      ...Array.from(connections, (connection) => connection.close()),
    ]);
    for (const event of HOST_EXIT_EVENTS) process.off(event, onHostExit);
  })());
  const onHostExit = () => {
    if (hostExitHandled) return;
    hostExitHandled = true;
    // A late plugin reply on the closed host channel reports this code as a
    // process "error"; absorb it so cleanup can finish. Anything else stays fatal.
    process.on("error", (error: NodeJS.ErrnoException) => {
      if (error?.code !== "ERR_IPC_CHANNEL_CLOSED") throw error;
    });
    // The stderr pipe has no reader once the host is gone; a broken pipe from a
    // diagnostic write must not kill the worker in the middle of cleanup.
    process.stderr.on("error", (error: NodeJS.ErrnoException) => {
      if (error?.code !== "EPIPE") throw error;
    });
    // Failsafe: exiting still closes every bridge's stdin, and DSH releases its
    // write lease on EOF, so a stuck request cannot leave the worker behind.
    const deadline = setTimeout(() => process.exit(0), HOST_EXIT_DEADLINE_MS);
    deadline.unref();
    void shutdown().finally(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
  };
  for (const event of HOST_EXIT_EVENTS) process.on(event, onHostExit);
  return shutdown;
}
