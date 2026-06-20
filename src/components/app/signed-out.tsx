import { Bot, ShieldCheck, Sparkles } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export function SignedOutApp() {
  return (
    <main className="grid min-h-screen place-items-center bg-[#0d0f0f] px-4 text-zinc-50">
      <section className="w-full max-w-xl rounded-lg border border-white/10 bg-white/[0.035] p-8 text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-lg border border-emerald-300/25 bg-emerald-300/10 text-emerald-100">
          <Bot aria-hidden className="size-7" />
        </div>
        <h1 className="mt-6 text-3xl font-semibold tracking-normal">
          Summon Agent Platform
        </h1>
        <p className="mt-3 text-sm leading-6 text-zinc-400">
          Sign in to create workspaces, connect tools, and run agents with
          approval controls.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Button asChild variant="secondary">
            <Link href="/sign-in?redirect_url=/app">Sign in</Link>
          </Button>
          <Button asChild>
            <Link href="/sign-up?redirect_url=/app">Sign up</Link>
          </Button>
        </div>
        <div className="mt-8 grid gap-3 text-left sm:grid-cols-3">
          {[
            [Sparkles, "Prompt agents"],
            [ShieldCheck, "Review actions"],
            [Bot, "Track runs"],
          ].map(([Icon, label]) => (
            <div
              className="rounded-md border border-white/10 bg-black/20 p-3 text-sm text-zinc-300"
              key={label as string}
            >
              <Icon aria-hidden className="mb-3 size-4 text-emerald-200" />
              {label as string}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
