import { Input, Label, Select } from "@/components/ui/form";

const REFERENCE_ROLES = [
  ["template", "Template"],
  ["input_data", "Input data"],
  ["helper_code", "Helper code"],
  ["reference", "Reference"],
  ["output_destination", "Output destination"],
  ["other", "Other"],
] as const;

export function AgentReferenceFields({
  count = 3,
  idPrefix,
}: {
  count?: number;
  idPrefix: string;
}) {
  return (
    <div className="space-y-4">
      {Array.from({ length: count }, (_, index) => {
        const rowNumber = index + 1;
        const fieldId = `${idPrefix}-${rowNumber}`;

        return (
          <div
            className="space-y-3 rounded-md border border-white/10 bg-black/20 p-3"
            key={fieldId}
          >
            <div className="grid gap-4 md:grid-cols-[1fr_180px]">
              <div className="space-y-2">
                <Label htmlFor={`${fieldId}-url`}>
                  Reference URL {rowNumber}
                </Label>
                <Input
                  id={`${fieldId}-url`}
                  name="referenceUrl"
                  placeholder="Google Slides, Sheets, Drive, Notion, or Looker Studio URL"
                  type="url"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${fieldId}-role`}>Role</Label>
                <Select
                  defaultValue="reference"
                  id={`${fieldId}-role`}
                  name="referenceRole"
                >
                  {REFERENCE_ROLES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={`${fieldId}-name`}>Reference name</Label>
                <Input
                  id={`${fieldId}-name`}
                  name="referenceName"
                  placeholder="Optional label, e.g. report template"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${fieldId}-description`}>
                  Reference notes
                </Label>
                <Input
                  id={`${fieldId}-description`}
                  name="referenceDescription"
                  placeholder="Optional instruction for this source"
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
