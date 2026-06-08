import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Prisma, type Agent } from "@prisma/client";
import { runQbrMetricsCompile, runQbrReport } from "../../../sandbox/qbr/executor";
import { createNotionMemoryPageFromRunArtifacts, importPptxAsGoogleSlides } from "@/lib/connectors/write";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";

export const QBR_GENERATE_DECK_TOOL = "qbr.generateDeck";

const DEFAULT_WENDY_WU_CSV =
  "/Users/sergeysotskiy/Downloads/Wendy Wu Weekly Report - GA4 - New_Untitled page_Table (4).csv";
const DEFAULT_REFERENCE_DECK_URL =
  "https://docs.google.com/presentation/d/1ctx-YpaHfYTJ-sJgWW_BGUTtbeLiEU7xF2JX76CkNkw";

type QbrAgent = Pick<
  Agent,
  "id" | "name" | "description" | "systemPrompt" | "tools"
>;

type QbrManifest = {
  status: "ok";
  input: {
    source_csv: string;
    client_id: string;
    client_name: string;
  };
  report_title: string;
  row_count: number;
  date_range: { min: string; max: string };
  outputs: {
    pptx_path: string;
    metrics_json_path: string;
  };
  quarter: {
    label: string;
    year: number;
    quarter: number;
    start: string;
    end: string;
  };
  metrics: Record<string, unknown>;
};

type QbrCalculationBlueprintSummary = {
  outputJsonPath: string;
  mode: "calculation_blueprint";
  slideCount: number;
  rowCount: number;
  referenceDeckUrl?: string;
  rendererInstructions?: string[];
};

type QbrCalculationBlueprintRead = {
  summary: QbrCalculationBlueprintSummary;
  payload: Record<string, unknown>;
};

type QbrToolOutput = {
  mode: "tool_execution";
  toolName: typeof QBR_GENERATE_DECK_TOOL;
  referenceDeckUrl: string;
  manifest: QbrManifest;
  calculationBlueprint: QbrCalculationBlueprintSummary | null;
  googleSlides: {
    fileId: string;
    webViewLink: string | null;
    fileName: string;
  } | null;
  notionMemory: {
    pageId: string;
    pageUrl: string | null;
  } | null;
  blockers: string[];
  toolCalls: Prisma.InputJsonArray;
  artifacts: Prisma.InputJsonArray;
};

function arrayTools(tools: Prisma.JsonValue) {
  return Array.isArray(tools)
    ? tools.filter((tool): tool is string => typeof tool === "string")
    : [];
}

export function agentWantsQbrTool(agent: QbrAgent) {
  const tools = arrayTools(agent.tools);
  if (tools.includes(QBR_GENERATE_DECK_TOOL)) {
    return true;
  }

  const text = [agent.name, agent.description, agent.systemPrompt]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /\b(qbr|quarterly|deck|slides|presentation)\b/.test(text);
}

function getDefaultCsvPath() {
  const configured = getEnv("QBR_DEFAULT_CSV_PATH");
  if (configured && existsSync(configured)) {
    return configured;
  }

  if (existsSync(DEFAULT_WENDY_WU_CSV)) {
    return DEFAULT_WENDY_WU_CSV;
  }

  throw new Error(
    "QBR input CSV was not found. Set QBR_DEFAULT_CSV_PATH or provide a run-owned CSV source before running qbr.generateDeck.",
  );
}

function getReportPeriod() {
  const year = Number(getEnv("QBR_REPORT_YEAR") ?? "2026");
  const quarter = Number(getEnv("QBR_REPORT_QUARTER") ?? "1");
  return {
    reportYear: Number.isFinite(year) ? year : 2026,
    reportQuarter: ([1, 2, 3, 4].includes(quarter) ? quarter : 1) as 1 | 2 | 3 | 4,
  };
}

async function fileMetadata(filePath: string) {
  const fileStat = await stat(filePath);
  return {
    path: filePath,
    sizeBytes: fileStat.size,
  };
}

function jsonArtifact(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function jsonObject(value: unknown): Prisma.InputJsonObject {
  return value as Prisma.InputJsonObject;
}

async function createArtifact(input: {
  agentRunId: string;
  toolCallId?: string;
  artifactType: string;
  name: string;
  location?: string | null;
  mimeType?: string | null;
  payload?: Record<string, unknown>;
}) {
  return getDb().agentArtifact.create({
    data: {
      agentRunId: input.agentRunId,
      toolCallId: input.toolCallId,
      artifactType: input.artifactType,
      name: input.name,
      location: input.location,
      mimeType: input.mimeType,
      payload: input.payload ? jsonArtifact(input.payload) : undefined,
    },
  });
}

function artifactOutput(
  artifact: Awaited<ReturnType<typeof createArtifact>>,
  options: { includePayload?: boolean } = {},
) {
  return jsonObject({
    id: artifact.id,
    name: artifact.name,
    type: artifact.artifactType,
    mimeType: artifact.mimeType,
    location: artifact.location,
    payload: options.includePayload === false ? undefined : artifact.payload,
    status: "ready",
  });
}

function toolCallOutput(input: {
  id: string;
  toolName: string;
  status: string;
  summary?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
}) {
  return jsonObject({
    id: input.id,
    toolName: input.toolName,
    status: input.status.toLowerCase(),
    summary: input.summary,
    args: input.args,
    result: input.result,
  });
}

function readKpiValue(manifest: QbrManifest, key: string) {
  const metrics = manifest.metrics;
  const overall =
    metrics.overall && typeof metrics.overall === "object" && !Array.isArray(metrics.overall)
      ? (metrics.overall as Record<string, unknown>)
      : {};
  const kpis = Array.isArray(overall.kpis) ? overall.kpis : [];
  const match = kpis.find(
    (item): item is Record<string, unknown> =>
      Boolean(item) &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item.key === key || item.label === key),
  );
  return typeof match?.value === "string" ? match.value : "n/a";
}

async function readCalculationBlueprint(
  outputJsonPath: string,
): Promise<QbrCalculationBlueprintRead> {
  const payload = JSON.parse(await readFile(outputJsonPath, "utf8")) as Record<string, unknown>;
  const rendererInstructions = Array.isArray(payload.rendererInstructions)
    ? payload.rendererInstructions.filter((item): item is string => typeof item === "string")
    : undefined;

  return {
    payload,
    summary: {
      outputJsonPath,
      mode: "calculation_blueprint",
      slideCount: Array.isArray(payload.slideBlueprint) ? payload.slideBlueprint.length : 0,
      rowCount: typeof payload.rowCount === "number" ? payload.rowCount : 0,
      referenceDeckUrl:
        typeof payload.referenceDeckUrl === "string" ? payload.referenceDeckUrl : undefined,
      rendererInstructions,
    },
  };
}

function qbrRunSummary(manifest: QbrManifest, blockers: string[]) {
  const summary = [
    `Generated ${manifest.input.client_name} ${manifest.quarter.label} QBR deck from ${manifest.row_count.toLocaleString()} source rows.`,
    `Leads: ${readKpiValue(manifest, "Sales Leads")}, spend: ${readKpiValue(manifest, "Cost")}, CPL: ${readKpiValue(manifest, "CPL")}.`,
  ];

  if (blockers.length > 0) {
    summary.push(`Publishing blockers: ${blockers.join(" ")}`);
  }

  return summary.join(" ");
}

export async function executeQbrGenerateDeckTool(input: {
  agentRunId: string;
  workspaceId: string;
  agent: QbrAgent;
}): Promise<QbrToolOutput> {
  const db = getDb();
  const startedAt = Date.now();
  const csvPath = getDefaultCsvPath();
  const reportPeriod = getReportPeriod();
  const outputDir = path.join(
    os.tmpdir(),
    "summon-agent-runs",
    input.agentRunId,
    "qbr",
  );
  await mkdir(outputDir, { recursive: true });

  const toolCall = await db.toolCall.create({
    data: {
      agentRunId: input.agentRunId,
      connectorType: "sandbox",
      toolName: QBR_GENERATE_DECK_TOOL,
      status: "RUNNING",
      startedAt: new Date(),
      request: {
        action: "generate_qbr_deck",
        parameters: {
          clientId: "wendy_wu",
          csvPath,
          outputDir,
          ...reportPeriod,
          referenceDeckUrl: DEFAULT_REFERENCE_DECK_URL,
        },
      },
      metadata: {
        approvalRequired: false,
        riskLevel: "LOW",
        execution: "trusted_vendored_python",
      },
    },
  });

  try {
    const calculationResult = await runQbrMetricsCompile({
      inputCsv: csvPath,
      outputDir,
      calculationJson: "qbr_calculation_blueprint.json",
      clientId: "wendy_wu",
      python: getEnv("QBR_PYTHON_BIN") ?? getEnv("PYTHON_BIN") ?? "python3",
      ...reportPeriod,
    });
    if (calculationResult.status === "error") {
      throw new Error(calculationResult.error);
    }
    const calculationBlueprintRecord = await readCalculationBlueprint(
      calculationResult.output_json,
    );
    const calculationBlueprint = calculationBlueprintRecord.summary;

    const result = await runQbrReport({
      inputCsv: csvPath,
      outputDir,
      outputPptx: "wendy_wu_qbr.pptx",
      outputJson: "metrics.json",
      clientId: "wendy_wu",
      python: getEnv("QBR_PYTHON_BIN") ?? getEnv("PYTHON_BIN") ?? "python3",
      ...reportPeriod,
    });
    if (result.status === "error") {
      throw new Error(result.error);
    }
    const manifest = result as QbrManifest;
    const blockers: string[] = [];
    const artifacts: Prisma.InputJsonValue[] = [
      artifactOutput(
        await createArtifact({
          agentRunId: input.agentRunId,
          toolCallId: toolCall.id,
          artifactType: "calculation_blueprint_json",
          name: "QBR calculation blueprint JSON",
          location: calculationBlueprint.outputJsonPath,
          mimeType: "application/json",
          payload: {
            ...(await fileMetadata(calculationBlueprint.outputJsonPath)),
            mode: calculationBlueprint.mode,
            slideCount: calculationBlueprint.slideCount,
            referenceDeckUrl: calculationBlueprint.referenceDeckUrl,
            blueprint: calculationBlueprintRecord.payload,
          },
        }),
        { includePayload: false },
      ),
      artifactOutput(
        await createArtifact({
          agentRunId: input.agentRunId,
          toolCallId: toolCall.id,
          artifactType: "metrics_json",
          name: "QBR metrics JSON",
          location: manifest.outputs.metrics_json_path,
          mimeType: "application/json",
          payload: await fileMetadata(manifest.outputs.metrics_json_path),
        }),
      ),
      artifactOutput(
        await createArtifact({
          agentRunId: input.agentRunId,
          toolCallId: toolCall.id,
          artifactType: "pptx",
          name: "Generated QBR PPTX",
          location: manifest.outputs.pptx_path,
          mimeType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          payload: await fileMetadata(manifest.outputs.pptx_path),
        }),
      ),
    ];

    let googleSlides: QbrToolOutput["googleSlides"] = null;
    try {
      const pptx = await readFile(manifest.outputs.pptx_path);
      const imported = await importPptxAsGoogleSlides({
        workspaceId: input.workspaceId,
        fileName: path.basename(manifest.outputs.pptx_path),
        slideName: `${manifest.input.client_name} ${manifest.quarter.label} QBR - generated by Summon`,
        pptx,
      });
      googleSlides = {
        fileId: imported.fileId,
        fileName: imported.fileName,
        webViewLink: imported.webViewLink,
      };
      artifacts.push(
        artifactOutput(
          await createArtifact({
            agentRunId: input.agentRunId,
            toolCallId: toolCall.id,
            artifactType: "google_slides",
            name: imported.fileName,
            location: imported.webViewLink,
            mimeType: imported.mimeType,
            payload: {
              fileId: imported.fileId,
              webViewLink: imported.webViewLink,
            },
          }),
        ),
      );
    } catch (error) {
      blockers.push(
        error instanceof Error
          ? `Google Slides publish failed: ${error.message}`
          : "Google Slides publish failed.",
      );
    }

    let notionMemory: QbrToolOutput["notionMemory"] = null;
    try {
      const memory = await createNotionMemoryPageFromRunArtifacts({
        workspaceId: input.workspaceId,
        runId: input.agentRunId,
        agentName: input.agent.name,
        runSummary: qbrRunSummary(manifest, blockers),
        runOutput: {
          text: qbrRunSummary(manifest, blockers),
          connectorResults: [
            {
              source: "google-drive",
              title: googleSlides?.fileName ?? "Generated QBR PPTX",
              url: googleSlides?.webViewLink,
              query: "QBR generated artifact",
              snippet: qbrRunSummary(manifest, blockers),
            },
          ],
        },
        memoryTitle: `${manifest.input.client_name} ${manifest.quarter.label} QBR generated by Summon`,
      });
      notionMemory = {
        pageId: memory.pageId,
        pageUrl: memory.pageUrl,
      };
      artifacts.push(
        artifactOutput(
          await createArtifact({
            agentRunId: input.agentRunId,
            toolCallId: toolCall.id,
            artifactType: "notion_memory",
            name: "Notion memory page",
            location: memory.pageUrl,
            mimeType: "text/uri-list",
            payload: {
              pageId: memory.pageId,
              pageUrl: memory.pageUrl,
            },
          }),
        ),
      );
    } catch (error) {
      blockers.push(
        error instanceof Error
          ? `Notion memory publish failed: ${error.message}`
          : "Notion memory publish failed.",
      );
    }

    const response = {
      manifest,
      calculationBlueprint,
      googleSlides,
      notionMemory,
      blockers,
    };
    await db.toolCall.update({
      where: { id: toolCall.id },
      data: {
        status: "SUCCEEDED",
        completedAt: new Date(),
        durationMs: Date.now() - startedAt,
        response: jsonArtifact(response),
      },
    });

    return {
      mode: "tool_execution",
      toolName: QBR_GENERATE_DECK_TOOL,
      referenceDeckUrl: DEFAULT_REFERENCE_DECK_URL,
      manifest,
      calculationBlueprint,
      googleSlides,
      notionMemory,
      blockers,
      toolCalls: [
        toolCallOutput({
          id: toolCall.id,
          toolName: QBR_GENERATE_DECK_TOOL,
          status: "SUCCEEDED",
          summary: qbrRunSummary(manifest, blockers),
          args: { csvPath, clientId: "wendy_wu", ...reportPeriod },
          result: {
            metrics: manifest.metrics,
            quarter: manifest.quarter,
            calculationBlueprint,
            googleSlides,
            notionMemory,
            blockers,
          },
        }),
      ] as Prisma.InputJsonArray,
      artifacts: artifacts as Prisma.InputJsonArray,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "QBR deck generation failed.";
    await db.toolCall.update({
      where: { id: toolCall.id },
      data: {
        status: "FAILED",
        error: message,
        completedAt: new Date(),
        durationMs: Date.now() - startedAt,
      },
    });
    throw new Error(message);
  }
}

export function buildQbrPromptSection(output: QbrToolOutput | null) {
  if (!output) {
    return "";
  }

  return [
    "QBR generation tool output:",
    JSON.stringify(
      {
        metrics: output.manifest.metrics,
        calculationBlueprint: output.calculationBlueprint,
        googleSlides: output.googleSlides,
        notionMemory: output.notionMemory,
        blockers: output.blockers,
        localArtifacts: output.artifacts,
      },
      null,
      2,
    ),
  ].join("\n");
}
