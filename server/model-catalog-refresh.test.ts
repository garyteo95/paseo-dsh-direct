import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { refreshDshModels } from "./model-catalog-refresh.js";

type ProviderActions = Pick<PaseoApi["providers"], "refresh" | "listModels">;

test("refresh waits for the saved DSH model instead of accepting another route", async () => {
  const calls: string[] = [];
  const old = { provider: "dsh-pi", id: "deepseek/default", label: "Default", metadata: { provider: "deepseek", model: "default" } };
  const glm = { provider: "dsh-pi", id: "zai/glm-5.3", label: "GLM", metadata: { provider: "zai", model: "glm-5.3" } };
  let reads = 0;
  const providers = {
    async refresh() { calls.push("refresh"); },
    async listModels() { calls.push("models"); return { models: reads++ === 0 ? [old] : [old, glm], error: null }; },
  } as unknown as ProviderActions;
  const models = await refreshDshModels(providers, (rows) => rows.some((row) => row.metadata?.provider === "zai" && row.metadata?.model === "glm-5.3"), { attempts: 2, retryMs: 0 });
  assert.deepEqual(calls, ["refresh", "models", "models"]);
  assert.equal(models.some((row) => row.id === "zai/glm-5.3"), true);
});

test("refresh leaves a missing target absent after the bounded retry", async () => {
  const providers = {
    async refresh() {},
    async listModels() { return { models: [{ provider: "dsh-pi", id: "deepseek/default", label: "Default" }], error: null }; },
  } as unknown as ProviderActions;
  const models = await refreshDshModels(providers, (rows) => rows.some((row) => row.metadata?.provider === "zai"), { attempts: 2, retryMs: 0 });
  assert.equal(models.some((row) => row.metadata?.provider === "zai"), false);
});

test("refresh waits until a removed provider leaves the DSH picker", async () => {
  const calls: string[] = [];
  let reads = 0;
  const providers = {
    async refresh() { calls.push("refresh"); },
    async listModels() {
      calls.push("models");
      return { models: reads++ === 0
        ? [{ provider: "dsh-pi", id: "zai/glm-5.3", label: "GLM", metadata: { provider: "zai", model: "glm-5.3" } }]
        : [], error: null };
    },
  } as unknown as ProviderActions;
  const models = await refreshDshModels(providers, (rows) => !rows.some((row) => row.metadata?.provider === "zai"), { attempts: 2, retryMs: 0 });
  assert.deepEqual(calls, ["refresh", "models", "models"]);
  assert.deepEqual(models, []);
});
