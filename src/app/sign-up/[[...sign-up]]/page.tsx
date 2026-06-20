import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0d0f0f] px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8">
          <div className="mb-4 flex size-12 items-center justify-center rounded-lg border border-emerald-400/30 bg-emerald-400/10 text-lg font-semibold text-emerald-200">
            S
          </div>
          <h1 className="text-2xl font-semibold text-white">Create your Summon account</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Join the workspace, then build and run agents with the team.
          </p>
        </div>
        <SignUp
          fallbackRedirectUrl="/app"
          path="/sign-up"
          routing="path"
          signInUrl="/sign-in"
        />
      </div>
    </main>
  );
}
