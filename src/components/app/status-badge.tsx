import { Badge } from "@/components/ui/badge";

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const variant =
    normalized.includes("active") ||
    normalized.includes("success") ||
    normalized.includes("succeeded") ||
    normalized.includes("approved")
      ? "success"
      : normalized.includes("pending") ||
          normalized.includes("queued") ||
          normalized.includes("draft")
        ? "warning"
        : normalized.includes("failed") ||
            normalized.includes("error") ||
            normalized.includes("revoked") ||
            normalized.includes("rejected")
          ? "danger"
          : "default";

  return <Badge variant={variant}>{status.replaceAll("_", " ").toLowerCase()}</Badge>;
}
