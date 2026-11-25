import assert from "node:assert/strict";
import test from "node:test";
import type { DshBridge } from "./bridge-client.js";
import { createManagementAccess } from "./management.js";

test("management access binds direct and nested revisions to the launch target", async () => {
  let configured = { executable: "dsh-a", profile: "one" };
  let opens = 0;
  const view = (revision: string) => ({
    supported: true as const,
    hostLabel: "Paseo daemon host" as const,
    profile: "one",
    credentialScope: "Shared DSH home credential store" as const,
    revision,
    protocols: [], providers: [], addableProviders: [],
  });
  const access = createManagementAccess({
    target: async () => ({ configured }),
    open: async () => {
      opens++;
      return {
        request: async (method: string) => method === "management.provider.upsert"
          ? { view: view("native-2"), settingsApplied: true, credentialApplied: "not-requested" }
          : view("native-1"),
        close: async () => {},
      } as unknown as DshBridge;
    },
  });
  const read = await access.run("management.read", {});
  assert.match(read.revision, /:native-1$/);
  const updated = await access.run("management.provider.upsert", {
    profile: "one", revision: read.revision, id: "route", displayName: "Route", models: [], credential: { action: "keep" },
  }, true);
  assert.match(updated.view.revision, /:native-2$/);
  configured = { executable: "dsh-b", profile: "one" };
  await assert.rejects(() => access.run("management.provider.upsert", {
    profile: "one", revision: updated.view.revision, id: "route", displayName: "Route", models: [], credential: { action: "keep" },
  }, true), /launch settings changed/);
  assert.equal(opens, 2);
  await access.dispose();
});

test("pending plugin status and cancellation stay on the bridge that owns the operation", async () => {
  let opens = 0;
  let closes = 0;
  const plugins = (revision: string) => ({
    supported: true as const,
    hostLabel: "Paseo daemon host" as const,
    profile: "one",
    revision,
    plugins: [],
  });
  const access = createManagementAccess({
    target: async () => ({ configured: { executable: "dsh", profile: "one" } }),
    open: async () => {
      const bridgeId = ++opens;
      return {
        request: async (method: string) => {
          if (method === "management.plugins.read") return plugins("native-1");
          assert.equal(bridgeId, 2);
          if (method === "management.plugins.install" || method === "management.plugins.status") {
            return { changed: false, application: "applied", requestId: "request-1", view: plugins("native-1") };
          }
          if (method === "management.plugins.cancel") {
            return { changed: true, application: "cancelled", view: plugins("native-1") };
          }
          throw new Error(`Unexpected method ${method}`);
        },
        close: async () => { closes++; },
      } as unknown as DshBridge;
    },
  });
  const initial = await access.run("management.plugins.read", {});
  const installed = await access.run("management.plugins.install", {
    profile: "one", revision: initial.revision, source: "registry", name: "safe-bundle", enable: false,
  }, true);
  const status = await access.run("management.plugins.status", {
    profile: "one", revision: installed.view.revision, requestId: "request-1",
  }, true);
  await access.run("management.plugins.cancel", {
    profile: "one", revision: status.view.revision, requestId: "request-1",
  }, true);
  assert.equal(opens, 2);
  assert.equal(closes, 2);
  await assert.rejects(() => access.run("management.plugins.status", {
    profile: "one", revision: status.view.revision, requestId: "request-1",
  }, true), /no longer attached/);
  await access.dispose();
});
