import { AppShell } from "@/components/app/app-shell";
import { SignedOutApp } from "@/components/app/signed-out";
import { getCurrentUserContext } from "@/lib/app/context";

export default async function PlatformLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const context = await getCurrentUserContext();

  if (!context.isAuthenticated) {
    return <SignedOutApp />;
  }

  return (
    <AppShell
      needsOnboarding={context.needsOnboarding}
      workspace={{
        id: context.workspace.id,
        name: context.workspace.name,
        type: context.workspace.type,
        role: context.role,
      }}
      workspaces={context.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        type: workspace.type,
        role: workspace.role,
      }))}
    >
      {children}
    </AppShell>
  );
}
