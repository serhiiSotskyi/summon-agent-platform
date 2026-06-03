import { Users } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/form";
import { getCurrentUserContext } from "@/lib/app/context";
import { createSharedWorkspace } from "../actions";

export default async function OnboardingPage() {
  const context = await getCurrentUserContext();

  if (!context.isAuthenticated) {
    return null;
  }

  return (
    <>
      <PageHeader
        description="Create the shared workspace Summon will use for team agents, shared connectors, approvals, and run history."
        eyebrow="Onboarding"
        title="Set up your team workspace"
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(360px,0.6fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Create shared workspace</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={createSharedWorkspace} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="name">Workspace name</Label>
                <Input
                  defaultValue="Summon team"
                  id="name"
                  name="name"
                  placeholder="Summon team"
                />
              </div>
              <Button type="submit">
                <Users aria-hidden />
                Create shared workspace
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What this unlocks</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-6 text-zinc-400">
            <p>
              Personal workspaces stay private. Shared workspaces are where the
              team connects credentials, creates agents, reviews protected
              actions, and sees run history.
            </p>
            <Alert>
              Invite management will use Clerk Organizations. This first screen
              creates the Prisma workspace and owner membership now.
            </Alert>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
