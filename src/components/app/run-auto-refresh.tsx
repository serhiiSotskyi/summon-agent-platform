"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const ACTIVE_STATUSES = new Set(["QUEUED", "RUNNING"]);

type RunAutoRefreshProps = {
  status: string;
};

export function RunAutoRefresh({ status }: RunAutoRefreshProps) {
  const router = useRouter();

  useEffect(() => {
    if (!ACTIVE_STATUSES.has(status)) {
      return;
    }

    const refresh = () => {
      router.refresh();
    };

    refresh();
    const interval = window.setInterval(refresh, 3000);

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router, status]);

  return null;
}
