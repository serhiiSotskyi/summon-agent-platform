import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUserContext } from "@/lib/app/context";
import { llmProviderSchema } from "@/lib/env";
import { hasModelListEnv, listProviderModels } from "@/lib/llm/models";

export async function GET(request: NextRequest) {
  const providerResult = llmProviderSchema.safeParse(
    request.nextUrl.searchParams.get("provider") ?? "openai",
  );
  const workspaceId = request.nextUrl.searchParams.get("workspace") ?? undefined;

  if (!providerResult.success) {
    return NextResponse.json({ error: "Unknown LLM provider." }, { status: 400 });
  }

  const context = await getCurrentUserContext(workspaceId);
  if (!context.isAuthenticated) {
    return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
  }

  const provider = providerResult.data;

  if (!hasModelListEnv(provider)) {
    return NextResponse.json({
      models: [],
      provider,
      source: null,
      warning: `Missing ${provider} API key. Add the provider key to load its official model list.`,
    });
  }

  try {
    const models = await listProviderModels(provider);

    return NextResponse.json({
      models,
      provider,
      source: models[0]?.source ?? null,
      warning: models.length === 0 ? "Provider returned no compatible models." : null,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Provider model list failed.";

    console.error("[llm.models]", { provider, message });

    return NextResponse.json(
      {
        error: "Could not load provider model list.",
        message,
        models: [],
        provider,
      },
      { status: 502 },
    );
  }
}
