import {
  ArrowRight,
  BookOpenText,
  CheckCircle2,
  Clock,
  FileUp,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/app/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUserContext } from "@/lib/app/context";

const workflowSteps = [
  {
    title: "Create the agent",
    text: "Give it a clear job, choose the model, select the connectors it can use, and attach explicit files or links when the task depends on a template, spreadsheet, or Python helper.",
  },
  {
    title: "Run or schedule it",
    text: "Use Run now for tests. Use a structured hourly, daily, or weekly schedule only after the output is reliable. Draft agents never run automatically.",
  },
  {
    title: "Review the result",
    text: "Open the run detail page to inspect evidence, tool calls, artifacts, costs, and final links before sharing work with the team or a client.",
  },
  {
    title: "Approve protected actions",
    text: "Reads, sandbox code, new file creation, copied template edits, and Notion memory pages are allowed. Destructive or external mutations stay approval-gated.",
  },
];

const taskPatterns = [
  {
    title: "QBR or report deck",
    tools: "CSV upload, Python sandbox, Google Slides template, Drive, Notion",
    prompt: "Calculate metrics from the uploaded data, copy the template deck, replace stale template content, create charts/tables, leave placeholders where data is missing, and publish the final link to Notion memory.",
  },
  {
    title: "Budget pacing check",
    tools: "Google Drive, Sheets, Notion, Python sandbox",
    prompt: "Find the budget tracker and reporting notes, calculate pacing, identify risks, cite evidence, and recommend actions without changing budgets.",
  },
  {
    title: "Client research pack",
    tools: "Notion, Google Drive, Docs writer",
    prompt: "Search Summon memory and client folders, summarize useful evidence, create a run-owned Google Doc, and save the summary link back into Notion.",
  },
];

const readinessNotes = [
  "Notion and Google Drive are the default Summon memory sources. Agents should cite what they found instead of inventing live account access.",
  "Google Ads and GA4 direct APIs are optional for now. Use Drive/Sheets and Notion trackers when Ads API access is not available.",
  "Generated or copied Drive files are safe for agents to edit without approval because they are run-owned outputs.",
  "Existing client files, budgets, campaign settings, deletes, and outbound sends require approval before execution.",
];

type SearchParams = Promise<{ workspace?: string }>;

export default async function HelpPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const context = await getCurrentUserContext(params.workspace);

  if (!context.isAuthenticated) {
    return null;
  }

  const workspaceId = context.workspace.id;

  return (
    <div>
      <PageHeader
        actions={
          <Button asChild>
            <Link href={`/app/agents/new?workspace=${workspaceId}`}>
              New agent
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        }
        description="A practical operating guide for creating, testing, scheduling, and reviewing Summon agents."
        eyebrow="Team guide"
        title="How to use the agent platform"
      />

      <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <BookOpenText aria-hidden className="size-5 text-emerald-200" />
              <CardTitle>Standard workflow</CardTitle>
            </div>
            <CardDescription>
              Use this sequence for every new agent until the team trusts the output.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              {workflowSteps.map((step, index) => (
                <div
                  className="rounded-md border border-white/10 bg-black/20 p-4"
                  key={step.title}
                >
                  <div className="flex items-center gap-2">
                    <span className="grid size-7 place-items-center rounded-md bg-emerald-300 text-sm font-semibold text-zinc-950">
                      {index + 1}
                    </span>
                    <h2 className="text-sm font-semibold text-white">{step.title}</h2>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-zinc-400">{step.text}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldCheck aria-hidden className="size-5 text-emerald-200" />
              <CardTitle>Safety rules</CardTitle>
            </div>
            <CardDescription>
              The platform is designed for useful output first, with risky actions gated.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {readinessNotes.map((note) => (
                <div className="flex gap-3 rounded-md border border-white/10 bg-black/20 p-3" key={note}>
                  <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-200" />
                  <p className="text-sm leading-6 text-zinc-300">{note}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        {taskPatterns.map((pattern) => (
          <Card key={pattern.title}>
            <CardHeader>
              <CardTitle className="text-lg">{pattern.title}</CardTitle>
              <CardDescription>{pattern.tools}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-6 text-zinc-300">{pattern.prompt}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FileUp aria-hidden className="size-5 text-emerald-200" />
              <CardTitle>Files and references</CardTitle>
            </div>
            <CardDescription>
              Attach inputs directly so the agent does not have to guess where source material lives.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-sm leading-6 text-zinc-300">
              <p>
                Use multiple file upload for small CSV, Python, TXT, Markdown, JSON, and YAML files.
                Use reference links for large Google Slides, Sheets, Docs, Drive folders, Notion pages,
                and Looker Studio reports.
              </p>
              <p>
                Give each reference a role such as <span className="font-medium text-white">Template</span>,{" "}
                <span className="font-medium text-white">Input data</span>,{" "}
                <span className="font-medium text-white">Helper code</span>, or{" "}
                <span className="font-medium text-white">Reference</span> so the agent can plan correctly.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Clock aria-hidden className="size-5 text-emerald-200" />
              <CardTitle>Launch checklist</CardTitle>
            </div>
            <CardDescription>
              Use this before letting a scheduled agent run for the team.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {[
                "Manual run has succeeded at least once with real evidence and usable output.",
                "Run detail shows expected artifacts, costs, and cited Notion or Drive sources.",
                "Any placeholder slides or missing data sections are intentional and visible.",
                "Approvals page is clear if the agent proposes a protected action.",
                "Schedule is active only after the output is trusted.",
              ].map((item) => (
                <div className="flex items-start gap-3" key={item}>
                  <Badge className="mt-0.5">Check</Badge>
                  <p className="text-sm leading-6 text-zinc-300">{item}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
