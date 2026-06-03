import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const [tool, ...toolArgs] = process.argv.slice(2);

const toolEntrypoints = {
  next: "node_modules/next/dist/bin/next",
  prisma: "node_modules/prisma/build/index.js",
  tsx: "node_modules/tsx/dist/cli.mjs",
};

if (!tool || !(tool in toolEntrypoints)) {
  console.error(
    `Usage: node scripts/run-with-system-node.mjs ${Object.keys(toolEntrypoints).join("|")} [...args]`,
  );
  process.exit(1);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function isCodexBundledNode(candidate) {
  return candidate.includes("/Applications/Codex.app/");
}

function canLoadNativePackages(candidate) {
  const check = spawnSync(
    candidate,
    [
      "-e",
      [
        "require('lightningcss');",
        "require('@clerk/nextjs');",
        "console.log(process.execPath);",
      ].join(""),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    },
  );

  return {
    ok: check.status === 0,
    output: `${check.stdout ?? ""}${check.stderr ?? ""}`.trim(),
  };
}

function resolveNodeBinary() {
  const candidates = unique([
    process.env.SUMMON_NODE_BIN,
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    process.execPath,
  ]);

  const failures = [];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    const result = canLoadNativePackages(candidate);
    if (result.ok && !isCodexBundledNode(candidate)) {
      return candidate;
    }

    failures.push({
      candidate,
      output: result.output || "native package check failed",
    });
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    const result = canLoadNativePackages(candidate);
    if (result.ok) {
      return candidate;
    }
  }

  console.error("No usable Node binary could load the project's native packages.");
  console.error("Set SUMMON_NODE_BIN to your system Node binary, for example:");
  console.error("  SUMMON_NODE_BIN=/usr/local/bin/node /usr/local/bin/npm run dev:clean");
  for (const failure of failures) {
    console.error(`\n${failure.candidate}\n${failure.output}`);
  }
  process.exit(1);
}

const nodeBinary = resolveNodeBinary();
const entrypoint = path.join(root, toolEntrypoints[tool]);
const child = spawn(nodeBinary, [entrypoint, ...toolArgs], {
  cwd: root,
  env: {
    ...process.env,
    npm_node_execpath: nodeBinary,
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
