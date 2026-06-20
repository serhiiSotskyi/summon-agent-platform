import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentFile } from "@prisma/client";
import { getEnv } from "@/lib/env";

const MAX_STDIO_CHARS = 40_000;
const MAX_CAPTURED_FILE_BYTES = 250_000;
const DEFAULT_TIMEOUT_MS = 45_000;

type SandboxFile = Pick<
  AgentFile,
  "name" | "role" | "sourceType" | "originalFileName" | "contentText" | "mimeType"
>;

type PythonRunInput = {
  runId: string;
  files: SandboxFile[];
  code?: string;
  entryFile?: string;
  args?: string[];
  timeoutMs?: number;
};

function safeFileName(value: string) {
  const cleaned = value
    .replace(/[/\\\0]/g, "_")
    .replace(/[\x00-\x1F\x7F]/g, "_")
    .trim()
    .slice(0, 120);

  return cleaned || `file_${Date.now()}`;
}

function truncate(value: string, max = MAX_STDIO_CHARS) {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`;
}

function sandboxEnv() {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin",
    HOME: os.tmpdir(),
    PYTHONIOENCODING: "utf-8",
    PYTHONDONTWRITEBYTECODE: "1",
  };
}

async function writeUploadedFiles(workspaceDir: string, files: SandboxFile[]) {
  const written: Array<{ role: string; name: string; path: string; mimeType?: string | null }> = [];

  for (const file of files) {
    if (file.sourceType !== "uploaded_text" || !file.contentText) {
      continue;
    }

    const name = safeFileName(file.originalFileName ?? file.name);
    const filePath = path.join(workspaceDir, name);
    await writeFile(filePath, file.contentText, "utf8");
    written.push({
      role: file.role,
      name,
      path: filePath,
      mimeType: file.mimeType,
    });
  }

  return written;
}

async function walkFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(rootDir, entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function listGeneratedFiles(workspaceDir: string) {
  const filePaths = await walkFiles(workspaceDir);
  const files = [];

  for (const filePath of filePaths) {
    const relativePath = path.relative(workspaceDir, filePath);
    const fileStat = await stat(filePath);
    let contentPreview: string | undefined;

    if (fileStat.size <= MAX_CAPTURED_FILE_BYTES) {
      try {
        const bytes = await readFile(filePath);
        if (!bytes.includes(0)) {
          contentPreview = truncate(bytes.toString("utf8"), 20_000);
        }
      } catch {
        contentPreview = undefined;
      }
    }

    files.push({
      name: path.basename(filePath),
      relativePath,
      path: filePath,
      sizeBytes: fileStat.size,
      contentPreview,
    });
  }

  return files;
}

function pickEntryFile(input: {
  workspaceDir: string;
  writtenFiles: Array<{ role: string; name: string; path: string }>;
  requestedEntryFile?: string;
}) {
  if (input.requestedEntryFile) {
    const safeRequested = safeFileName(input.requestedEntryFile);
    const match = input.writtenFiles.find((file) => file.name === safeRequested);
    if (match) {
      return match.path;
    }
  }

  const helperPython = input.writtenFiles.find(
    (file) => file.role === "helper_code" && file.name.endsWith(".py"),
  );
  if (helperPython) {
    return helperPython.path;
  }

  const anyPython = input.writtenFiles.find((file) => file.name.endsWith(".py"));
  return anyPython?.path;
}

export async function runPythonInSandbox(input: PythonRunInput) {
  const workspaceDir = path.join(os.tmpdir(), "summon-agent-runs", input.runId, "python");
  await mkdir(workspaceDir, { recursive: true });

  const writtenFiles = await writeUploadedFiles(workspaceDir, input.files);
  let entryFile = pickEntryFile({
    workspaceDir,
    writtenFiles,
    requestedEntryFile: input.entryFile,
  });

  if (input.code?.trim()) {
    entryFile = path.join(workspaceDir, "main.py");
    await writeFile(entryFile, input.code, "utf8");
    writtenFiles.push({
      role: "helper_code",
      name: "main.py",
      path: entryFile,
    });
  }

  if (!entryFile) {
    throw new Error(
      "No Python entry file found. Upload a .py helper file or provide code for python.run.",
    );
  }

  const timeoutMs = input.timeoutMs ?? Number(getEnv("PYTHON_SANDBOX_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS);
  const python = getEnv("PYTHON_BIN") ?? "python3";
  const args = [entryFile, ...(Array.isArray(input.args) ? input.args.map(String) : [])];
  const startedAt = Date.now();

  const processResult = spawnSync(python, args, {
    cwd: workspaceDir,
    encoding: "utf8",
    env: sandboxEnv() as unknown as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });

  if (processResult.error && processResult.error.name !== "TimeoutError") {
    throw processResult.error;
  }

  const result = {
    exitCode: processResult.status,
    stdout: truncate(processResult.stdout ?? ""),
    stderr: truncate(processResult.stderr ?? ""),
    timedOut: processResult.error?.name === "TimeoutError",
  };

  const generatedFiles = await listGeneratedFiles(workspaceDir);

  return {
    workspaceDir,
    entryFile,
    command: [python, ...args.map((arg) => path.relative(workspaceDir, arg) || arg)].join(" "),
    durationMs: Date.now() - startedAt,
    ...result,
    generatedFiles,
  };
}
