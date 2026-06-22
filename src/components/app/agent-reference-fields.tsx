"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
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
  count = 1,
  idPrefix,
}: {
  count?: number;
  idPrefix: string;
}) {
  const [rows, setRows] = useState(() =>
    Array.from({ length: Math.max(1, count) }, (_, index) => ({
      id: `${idPrefix}-${index + 1}`,
    })),
  );

  function addReference() {
    setRows((currentRows) => [
      ...currentRows,
      {
        id: `${idPrefix}-${Date.now()}-${currentRows.length + 1}`,
      },
    ]);
  }

  function removeReference(rowId: string) {
    setRows((currentRows) => {
      if (currentRows.length === 1) {
        return currentRows;
      }

      return currentRows.filter((row) => row.id !== rowId);
    });
  }

  return (
    <div className="space-y-4">
      {rows.map((row, index) => {
        const rowNumber = index + 1;
        const fieldId = `${row.id}-${rowNumber}`;

        return (
          <div
            className="space-y-3 rounded-md border border-white/10 bg-black/20 p-3"
            key={row.id}
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-zinc-200">
                Reference {rowNumber}
              </p>
              {rows.length > 1 ? (
                <Button
                  aria-label={`Remove reference ${rowNumber}`}
                  onClick={() => removeReference(row.id)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 aria-hidden />
                  Remove
                </Button>
              ) : null}
            </div>
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
      <Button onClick={addReference} type="button" variant="secondary">
        <Plus aria-hidden />
        Add reference
      </Button>
    </div>
  );
}
