import { Badge } from "@/components/ui/badge";
import type { GenericAgentTool } from "@/lib/tools/definitions";

function riskVariant(riskLevel: GenericAgentTool["riskLevel"]) {
  if (riskLevel === "read" || riskLevel === "review") {
    return "info";
  }

  if (riskLevel === "sandbox" || riskLevel === "run_owned_write") {
    return "warning";
  }

  return "default";
}

function riskLabel(riskLevel: GenericAgentTool["riskLevel"]) {
  return riskLevel.replaceAll("_", " ");
}

export function GenericToolOption({
  defaultChecked,
  tool,
}: {
  defaultChecked?: boolean;
  tool: GenericAgentTool;
}) {
  return (
    <label
      className="flex cursor-pointer items-start gap-3 rounded-md border border-emerald-300/20 bg-emerald-300/10 p-3 text-sm"
      key={tool.key}
    >
      <input
        className="mt-1 accent-emerald-300"
        defaultChecked={defaultChecked}
        name="tools"
        type="checkbox"
        value={tool.key}
      />
      <span className="min-w-0">
        <span className="block font-medium text-white">{tool.name}</span>
        <span className="mt-1 block leading-5 text-emerald-100/80">
          {tool.summary}
        </span>
        <span className="mt-3 flex flex-wrap gap-2">
          <Badge variant={riskVariant(tool.riskLevel)}>
            {riskLabel(tool.riskLevel)}
          </Badge>
          <Badge>{tool.category}</Badge>
          <Badge>{Math.round(tool.timeoutMs / 1000)}s timeout</Badge>
        </span>
        <span className="mt-2 block text-xs leading-5 text-emerald-50/70">
          {tool.approvalPolicy}
        </span>
      </span>
    </label>
  );
}
