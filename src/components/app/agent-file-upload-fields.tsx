import { FileCode2, FileSpreadsheet, FileText, Layers, Upload } from "lucide-react";
import { Input, Label } from "@/components/ui/form";

const UPLOAD_GROUPS = [
  {
    description: "CSV, JSON, YAML, or TXT files the agent should calculate from.",
    icon: FileSpreadsheet,
    label: "Input data",
    role: "input_data",
  },
  {
    description: "Python helpers the agent may run or adapt in the sandbox.",
    icon: FileCode2,
    label: "Helper code",
    role: "helper_code",
  },
  {
    description: "Small text templates or markdown outlines. Use links for large decks/docs.",
    icon: Layers,
    label: "Template files",
    role: "template",
  },
  {
    description: "Briefs, notes, examples, or supporting context.",
    icon: FileText,
    label: "Reference files",
    role: "reference",
  },
] as const;

export function AgentFileUploadFields({ idPrefix }: { idPrefix: string }) {
  return (
    <div className="space-y-3">
      <div>
        <p className="flex items-center gap-2 text-sm font-medium text-white">
          <Upload aria-hidden className="size-4 text-emerald-200" />
          Upload small text files
        </p>
        <p className="mt-1 text-xs leading-5 text-zinc-500">
          Attach multiple files in the right role group. CSV, Python, TXT,
          Markdown, JSON, or YAML only, up to 1 MB each. Use Drive links for
          large or binary files.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {UPLOAD_GROUPS.map((group) => {
          const Icon = group.icon;
          const fieldId = `${idPrefix}-${group.role}`;

          return (
            <div
              className="rounded-md border border-white/10 bg-black/20 p-3"
              key={group.role}
            >
              <Label
                className="flex items-center gap-2 text-sm text-white"
                htmlFor={fieldId}
              >
                <Icon aria-hidden className="size-4 text-emerald-200" />
                {group.label}
              </Label>
              <p className="mb-3 mt-1 text-xs leading-5 text-zinc-500">
                {group.description}
              </p>
              <Input
                accept=".csv,.py,.txt,.md,.json,.yaml,.yml,text/*,application/json"
                id={fieldId}
                multiple
                name={`agentFiles:${group.role}`}
                type="file"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
