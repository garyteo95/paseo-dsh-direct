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
