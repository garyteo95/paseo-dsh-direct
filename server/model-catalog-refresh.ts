import type { PaseoApi } from "@getpaseo/client";

type ProviderActions = Pick<PaseoApi["providers"], "refresh" | "listModels">;
export type PaseoModels = NonNullable<Awaited<ReturnType<ProviderActions["listModels"]>>["models"]>;

/** Refresh only dsh-pi, then wait for the requested change without unrelated providers blocking it. */
export async function refreshDshModels(
  providers: ProviderActions,
  matches?: (models: PaseoModels) => boolean,
  options: { attempts?: number; retryMs?: number } = {},
): Promise<PaseoModels> {
  const attempts = options.attempts ?? 20;
  const retryMs = options.retryMs ?? 500;
  await providers.refresh({ providers: ["dsh-pi"] });
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await providers.listModels("dsh-pi");
    if (!result.error) {
      const models = result.models ?? [];
      if (!matches || matches(models) || attempt === attempts - 1) return models;
    } else if (!matches || attempt === attempts - 1) {
      throw new Error(result.error);
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  return [];
}
