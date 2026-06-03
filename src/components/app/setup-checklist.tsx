import { Check, Circle } from "lucide-react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function SetupChecklist({
  items,
  workspaceId,
  demo,
}: {
  items: Array<{ label: string; complete: boolean; href: string }>;
  workspaceId: string;
  demo: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Setup checklist</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((item) => {
          const params = new URLSearchParams({ workspace: workspaceId });
          if (demo) {
            params.set("demo", "1");
          }

          return (
            <Link
              className="flex items-center gap-3 rounded-md border border-white/10 bg-black/20 px-3 py-3 text-sm transition hover:bg-white/[0.06]"
              href={`${item.href}?${params.toString()}`}
              key={item.label}
            >
              <span className="grid size-7 place-items-center rounded-md bg-white/5">
                {item.complete ? (
                  <Check aria-hidden className="size-4 text-emerald-200" />
                ) : (
                  <Circle aria-hidden className="size-4 text-zinc-500" />
                )}
              </span>
              <span className={item.complete ? "text-zinc-400" : "text-white"}>
                {item.label}
              </span>
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}
