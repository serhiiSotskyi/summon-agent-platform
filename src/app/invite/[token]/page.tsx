import { SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import { CheckCircle2, LockKeyhole, Mail, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getAuthenticatedDbUser } from "@/lib/app/context";
import {
  getWorkspaceInvitationPreview,
  normalizeInviteEmail,
} from "@/lib/app/invitations";
import { acceptWorkspaceInvitation } from "./actions";

type Params = Promise<{ token: string }>;
type SearchParams = Promise<{ error?: string }>;

const errorMessages: Record<string, string> = {
  "auth-required": "Sign in or create an account before accepting this invitation.",
  expired: "This invitation has expired. Ask the workspace owner to send a new one.",
  invalid: "This invitation link is invalid.",
  "not-pending": "This invitation has already been used or is no longer pending.",
};

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { token } = await params;
  const query = await searchParams;
  const [preview, authenticatedUser] = await Promise.all([
    getWorkspaceInvitationPreview(token),
    getAuthenticatedDbUser(),
  ]);
  const inviteUrl = `/invite/${token}`;
  const signedInEmail = authenticatedUser?.user.email ?? null;
  const emailMismatch =
    preview &&
    signedInEmail &&
    normalizeInviteEmail(preview.email) !== normalizeInviteEmail(signedInEmail);
  const explicitError = query.error
    ? errorMessages[query.error] ?? "This invitation could not be accepted."
    : null;

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(110,231,183,0.14),transparent_32rem),#0d0f0f] px-5 py-10 text-zinc-50">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-3xl items-center justify-center">
        <Card className="w-full overflow-hidden">
          <CardHeader className="border-b border-white/10 bg-white/[0.025]">
            <div className="mb-5 flex size-12 items-center justify-center rounded-lg border border-emerald-300/20 bg-emerald-300/10 text-emerald-100">
              <Mail aria-hidden />
            </div>
            <CardTitle className="text-3xl">Workspace invitation</CardTitle>
            <CardDescription>
              Join a Summon Agent Platform workspace with the email address that
              was invited.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 pt-5">
            {!preview ? (
              <Alert className="border-red-300/20 bg-red-400/10 text-red-50/90">
                This invitation link is invalid. Ask the workspace owner to send
                a new invite.
              </Alert>
            ) : null}

            {preview ? (
              <>
                <div className="rounded-lg border border-white/10 bg-black/20 p-5">
                  <div className="text-xs uppercase tracking-[0.18em] text-emerald-200/70">
                    Invited workspace
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-white">
                    {preview.workspaceName}
                  </div>
                  <div className="mt-4 grid gap-3 text-sm text-zinc-300 sm:grid-cols-2">
                    <div>
                      <div className="text-zinc-500">Invited email</div>
                      <div className="mt-1 font-medium text-white">
                        {preview.email}
                      </div>
                    </div>
                    <div>
                      <div className="text-zinc-500">Role</div>
                      <div className="mt-1 font-medium text-white">
                        {preview.role.toLowerCase()}
                      </div>
                    </div>
                    <div>
                      <div className="text-zinc-500">Invited by</div>
                      <div className="mt-1 font-medium text-white">
                        {preview.invitedBy ?? "Workspace admin"}
                      </div>
                    </div>
                    <div>
                      <div className="text-zinc-500">Expires</div>
                      <div className="mt-1 font-medium text-white">
                        {preview.expiresAt
                          ? preview.expiresAt.toLocaleDateString("en-GB")
                          : "No expiry"}
                      </div>
                    </div>
                  </div>
                </div>

                {explicitError ? (
                  <Alert className="border-red-300/20 bg-red-400/10 text-red-50/90">
                    {explicitError}
                  </Alert>
                ) : null}

                {preview.status !== "PENDING" ? (
                  <Alert>
                    This invitation is currently {preview.status.toLowerCase()}.
                  </Alert>
                ) : null}

                {preview.isExpired ? (
                  <Alert className="border-red-300/20 bg-red-400/10 text-red-50/90">
                    This invitation has expired. Ask the workspace owner to send
                    a new one.
                  </Alert>
                ) : null}

                {!authenticatedUser ? (
                  <div className="rounded-lg border border-white/10 bg-black/20 p-5">
                    <div className="flex items-start gap-3">
                      <LockKeyhole
                        aria-hidden
                        className="mt-1 size-4 text-emerald-200"
                      />
                      <div>
                        <div className="font-medium text-white">
                          Sign in to accept
                        </div>
                        <p className="mt-1 text-sm leading-6 text-zinc-400">
                          Use {preview.email}. If you do not have an account
                          yet, create one with that same email.
                        </p>
                      </div>
                    </div>
                    <div className="mt-5 flex flex-wrap gap-3">
                      <SignInButton
                        forceRedirectUrl={inviteUrl}
                        mode="redirect"
                      >
                        <Button type="button" variant="secondary">
                          Sign in
                        </Button>
                      </SignInButton>
                      <SignUpButton
                        forceRedirectUrl={inviteUrl}
                        mode="redirect"
                      >
                        <Button type="button">
                          Create account
                        </Button>
                      </SignUpButton>
                    </div>
                  </div>
                ) : null}

                {authenticatedUser && emailMismatch ? (
                  <Alert className="border-red-300/20 bg-red-400/10 text-red-50/90">
                    <div className="flex items-start gap-3">
                      <ShieldAlert aria-hidden className="mt-1 size-4" />
                      <div>
                        This invite is for {preview.email}, but you are signed
                        in as {signedInEmail}. Switch accounts to accept it.
                        <div className="mt-3">
                          <UserButton />
                        </div>
                      </div>
                    </div>
                  </Alert>
                ) : null}

                {authenticatedUser &&
                !emailMismatch &&
                preview.status === "PENDING" &&
                !preview.isExpired ? (
                  <form action={acceptWorkspaceInvitation}>
                    <input name="token" type="hidden" value={token} />
                    <Button type="submit">
                      <CheckCircle2 aria-hidden />
                      Accept invitation
                    </Button>
                  </form>
                ) : null}
              </>
            ) : null}

            <div className="border-t border-white/10 pt-5">
              <Button asChild variant="ghost">
                <Link href="/app">Back to app</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
