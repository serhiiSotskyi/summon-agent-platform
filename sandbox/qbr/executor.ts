import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export type QBRRunOutput = {
  status: "ok";
  outputs: {
    pptx_path: string;
    metrics_json_path: string;
  };
  quarter: {
    year: number;
    quarter: number;
    label: string;
    start: string;
    end: string;
  };
  metrics: Record<string, unknown>;
};

export type QBRRunError = {
  status: "error";
  error: string;
};

export type QBRRunResult = QBRRunOutput | QBRRunError;

type RunOptions = {
  inputCsv: string;
  outputDir?: string;
  clientId?: string;
  outputPptx?: string;
  outputJson?: string;
  trendsDir?: string;
  auctionCsv?: string;
  maxKpiRows?: number;
  reportYear?: number;
  reportQuarter?: 1 | 2 | 3 | 4;
  python?: string;
  scriptPath?: string;
};

const DEFAULT_ARGS = {
  outputPptx: "qbr_report.pptx",
  outputJson: "qbr_metrics.json",
  maxKpiRows: 20,
};

function ensureFileExists(label: string, filePath: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`${label} does not exist: ${filePath}`);
  }
}

function requireJsonObject(value: string): QBRRunResult {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reverse();

  for (const line of lines) {
    try {
      const payload = JSON.parse(line) as unknown;
      if (!payload || typeof payload !== "object") {
        continue;
      }
      if (!("status" in payload)) {
        continue;
      }
      return payload as QBRRunResult;
    } catch {
      // Ignore non-JSON lines while scanning backward for the final structured payload.
      continue;
    }
  }

  throw new Error("Sandbox result is not JSON.");
}

export async function runQbrReport(options: RunOptions): Promise<QBRRunResult> {
  const scriptPath = path.resolve(options.scriptPath ?? process.cwd(), "sandbox", "qbr", "sandbox_run.py");
  const python = options.python ?? "python3";
  const inputCsv = path.resolve(options.inputCsv);
  const outputDir = path.resolve(options.outputDir ?? path.join(process.cwd(), "sandbox", "qbr", "output"));
  const outputPptx = options.outputPptx ?? DEFAULT_ARGS.outputPptx;
  const outputJson = options.outputJson ?? DEFAULT_ARGS.outputJson;
  const maxKpiRows = options.maxKpiRows ?? DEFAULT_ARGS.maxKpiRows;

  if (!existsSync(scriptPath)) {
    throw new Error(`Sandbox runner script not found: ${scriptPath}`);
  }
  ensureFileExists("input CSV", inputCsv);

  const args = [
    scriptPath,
    "--input-csv",
    inputCsv,
    "--output-dir",
    outputDir,
    "--output-pptx",
    outputPptx,
    "--output-json",
    outputJson,
    "--max-kpi-rows",
    String(maxKpiRows),
  ];

  if (options.clientId) {
    args.push("--client-id", options.clientId);
  }
  if (options.trendsDir) {
    args.push("--trends-dir", path.resolve(options.trendsDir));
  }
  if (options.auctionCsv) {
    args.push("--auction-csv", path.resolve(options.auctionCsv));
  }
  if (options.reportYear || options.reportQuarter) {
    if (!options.reportYear || !options.reportQuarter) {
      throw new Error("Both reportYear and reportQuarter are required.");
    }
    args.push("--report-year", String(options.reportYear));
    args.push("--report-quarter", String(options.reportQuarter));
  }

  const spawned = spawnSync(python, args, {
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  if (spawned.error) {
    throw new Error(`Failed to spawn python3: ${(spawned.error as Error).message}`);
  }

  const stdout = (spawned.stdout ?? "").trim();
  const stderr = (spawned.stderr ?? "").trim();
  if (!stdout) {
    throw new Error(`No output returned from sandbox runner. stderr: ${stderr}`);
  }

  const parsed = requireJsonObject(stdout);
  if (spawned.status && spawned.status !== 0 && parsed.status === "ok") {
    throw new Error(`Sandbox runner exited with code ${spawned.status}. stderr: ${stderr}`);
  }
  if (parsed.status === "error") {
    return parsed;
  }

  if (parsed.outputs.pptx_path && !existsSync(parsed.outputs.pptx_path)) {
    throw new Error(`Runner reported missing PPTX output: ${parsed.outputs.pptx_path}`);
  }
  if (parsed.outputs.metrics_json_path && !existsSync(parsed.outputs.metrics_json_path)) {
    throw new Error(`Runner reported missing metrics JSON output: ${parsed.outputs.metrics_json_path}`);
  }

  return parsed;
}

export async function runQbrReportAndMetrics(options: RunOptions): Promise<QBRRunResult> {
  const result = await runQbrReport(options);
  if (result.status === "error") {
    return result;
  }
  return result;
}
