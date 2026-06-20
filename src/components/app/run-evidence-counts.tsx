import { Badge } from "@/components/ui/badge";

export function RunEvidenceCounts({
  artifacts,
  toolCalls,
}: {
  artifacts: number;
  toolCalls: number;
}) {
  const hasEvidence = toolCalls > 0 || artifacts > 0;

  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant={hasEvidence ? "success" : "default"}>
        {toolCalls} tools
      </Badge>
      <Badge variant={artifacts > 0 ? "info" : "default"}>
        {artifacts} artifacts
      </Badge>
    </div>
  );
}
