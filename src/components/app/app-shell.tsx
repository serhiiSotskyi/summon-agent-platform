"use client";

import { UserButton } from "@clerk/nextjs";
import {
  BadgeCheck,
  BookOpenText,
  Bot,
  Cable,
  CheckCircle2,
  ClipboardCheck,
  History,
  LayoutDashboard,
  Menu,
  Settings,
  Sparkles,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type WorkspaceShellItem = {
  id: string;
  name: string;
  type: "PERSONAL" | "SHARED";
  role: string;
};

const navItems = [
  { href: "/app", label: "Dashboard", icon: LayoutDashboard },
  { href: "/app/agents", label: "Agents", icon: Bot },
  { href: "/app/runs", label: "Runs", icon: History },
  { href: "/app/connectors", label: "Connectors", icon: Cable },
  { href: "/app/approvals", label: "Approvals", icon: ClipboardCheck },
  { href: "/app/workspaces", label: "Workspaces", icon: Users },
  { href: "/app/settings", label: "Settings", icon: Settings },
  { href: "/app/help", label: "Help", icon: BookOpenText },
];

function withWorkspace(href: string, workspaceId: string, demo: boolean) {
  const params = new URLSearchParams();
  params.set("workspace", workspaceId);
  if (demo) {
    params.set("demo", "1");
  }

  return `${href}?${params.toString()}`;
}

function NavList({
  workspaceId,
  demo,
}: {
  workspaceId: string;
  demo: boolean;
}) {
  const pathname = usePathname();

  return (
    <nav className="space-y-1" aria-label="Primary">
      {navItems.map(({ href, label, icon: Icon }) => {
        const active = pathname === href;
        return (
          <Link
            className={cn(
              "flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition",
              active
                ? "bg-emerald-300 text-zinc-950"
                : "text-zinc-400 hover:bg-white/10 hover:text-white",
            )}
            href={withWorkspace(href, workspaceId, demo)}
            key={href}
          >
            <Icon aria-hidden className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function DemoToggle({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const demo = searchParams.get("demo") === "1";
  const nextParams = new URLSearchParams(searchParams.toString());
  nextParams.set("workspace", workspaceId);
  if (demo) {
    nextParams.delete("demo");
  } else {
    nextParams.set("demo", "1");
  }

  return (
    <Button asChild size="sm" variant={demo ? "default" : "secondary"}>
      <Link href={`${pathname}?${nextParams.toString()}`}>
        {demo ? (
          <CheckCircle2 aria-hidden className="size-4" />
        ) : (
          <Sparkles aria-hidden className="size-4" />
        )}
        Demo mode
      </Link>
    </Button>
  );
}

export function AppShell({
  children,
  workspace,
  workspaces,
  needsOnboarding,
}: {
  children: ReactNode;
  workspace: WorkspaceShellItem;
  workspaces: WorkspaceShellItem[];
  needsOnboarding: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const demo = searchParams.get("demo") === "1";
  const activeWorkspace =
    workspaces.find((item) => item.id === searchParams.get("workspace")) ??
    workspace;

  return (
    <div className="min-h-screen bg-[#0d0f0f] text-zinc-50">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 border-r border-white/10 bg-[#101313] p-4 lg:block">
        <Link
          className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.035] p-3"
          href={withWorkspace("/app", activeWorkspace.id, demo)}
        >
          <span className="grid size-10 place-items-center rounded-md border border-emerald-300/25 bg-emerald-300/10 text-sm font-semibold text-emerald-100">
            S
          </span>
          <span>
            <span className="block text-sm font-semibold">Summon</span>
            <span className="block text-xs text-zinc-500">Agent Platform</span>
          </span>
        </Link>

        <div className="mt-5 rounded-lg border border-white/10 bg-black/20 p-3">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">
            Workspace
          </p>
          <p className="mt-2 truncate text-sm font-semibold text-white">
            {activeWorkspace.name}
          </p>
          <div className="mt-3 flex gap-2">
            <Badge variant={activeWorkspace.type === "SHARED" ? "info" : "default"}>
              {activeWorkspace.type === "SHARED" ? "Shared" : "Personal"}
            </Badge>
            <Badge>{activeWorkspace.role.toLowerCase()}</Badge>
          </div>
        </div>

        <div className="mt-5">
          <NavList demo={demo} workspaceId={activeWorkspace.id} />
        </div>
      </aside>

      <div className="lg:pl-72">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-white/10 bg-[#0d0f0f]/90 px-4 backdrop-blur-xl sm:px-6">
          <div className="flex items-center gap-3">
            <Sheet>
              <SheetTrigger asChild>
                <Button className="lg:hidden" size="icon" variant="secondary">
                  <Menu aria-hidden className="size-4" />
                  <span className="sr-only">Open navigation</span>
                </Button>
              </SheetTrigger>
              <SheetContent>
                <SheetTitle className="pr-10 text-base font-semibold">
                  Summon Agent Platform
                </SheetTitle>
                <div className="mt-6">
                  <NavList demo={demo} workspaceId={activeWorkspace.id} />
                </div>
              </SheetContent>
            </Sheet>
            <div>
              <p className="text-sm font-semibold text-white">
                {activeWorkspace.name}
              </p>
              <p className="text-xs text-zinc-500">
                {needsOnboarding
                  ? "Set up your first shared workspace"
                  : "Workspace control plane"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {demo ? <Badge variant="demo">Demo</Badge> : null}
            <DemoToggle workspaceId={activeWorkspace.id} />
            <Button asChild className="hidden sm:inline-flex" size="sm">
              <Link href={withWorkspace("/app/agents/new", activeWorkspace.id, demo)}>
                <Bot aria-hidden className="size-4" />
                New agent
              </Link>
            </Button>
            <UserButton />
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6">
          {needsOnboarding && pathname !== "/app/onboarding" ? (
            <Link
              className="mb-5 flex items-center justify-between rounded-lg border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-50/90"
              href={withWorkspace("/app/onboarding", workspace.id, demo)}
            >
              <span className="flex items-center gap-2">
                <BadgeCheck aria-hidden className="size-4" />
                Create a shared workspace to invite the team and share agents.
              </span>
              <span className="hidden text-xs font-medium sm:block">
                Start setup
              </span>
            </Link>
          ) : null}
          {workspaces.length > 1 ? (
            <div className="mb-5 flex flex-wrap gap-2">
              {workspaces.map((item) => (
                <Button
                  asChild
                  key={item.id}
                  size="sm"
                  variant={item.id === activeWorkspace.id ? "default" : "secondary"}
                >
                  <Link href={withWorkspace(pathname, item.id, demo)}>
                    {item.name}
                  </Link>
                </Button>
              ))}
            </div>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}
