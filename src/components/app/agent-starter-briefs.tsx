import { ClipboardList, SearchCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export const AGENT_STARTER_BRIEFS = [
  {
    title: "Client report or QBR deck",
    bestFor:
      "Turning uploaded CSVs, helper Python, and a Google Slides template into a client-ready draft.",
    prompt: `Create an editable client report deck from the attached inputs.

Use Notion and Google Drive as Summon memory first. Search for the client, reporting templates, PPC, budget, Google Ads, and Summon Memory. Cite source titles and links.

Use the uploaded CSV as the source of fresh numbers. Use any uploaded Python as reference or helper code, but write a self-contained sandbox script if imports are missing. Produce structured metrics, tables, and chart data before editing any deck.

Copy the linked Google Slides template into a new run-owned deck. Do not edit the original template. Preserve the template design language, but replace stale template numbers, titles, charts, tables, and commentary with fresh evidence-based content.

If data is missing, leave a clear human-editable placeholder instead of inventing it. Create a Notion memory page with the final Slides link, evidence used, metrics calculated, placeholders left, and recommendations.`,
  },
  {
    title: "Budget pacing review",
    bestFor:
      "Reviewing spend trackers and reporting notes without direct Google Ads API access.",
    prompt: `Review budget pacing and performance for the requested client or account.

Search Notion and Google Drive first for budget trackers, PPC reports, Google Ads exports, reporting docs, and Summon Memory. Prefer Sheets and files that are clearly current. Cite every source used.

Read the relevant Sheet or uploaded CSV. Use Python to calculate spend pace, remaining budget, expected end-of-period spend, CPL/CPA/ROAS where available, and the biggest risk areas.

Do not change budgets, campaign settings, or source trackers. Create a concise run-owned summary with findings, evidence, recommended actions, and what could not be verified. Mark any recommended budget or campaign change as approval-required.`,
  },
  {
    title: "Data cleanup or Sheet transform",
    bestFor:
      "Reading messy uploaded data or a Google Sheet, transforming it, and writing a clean run-owned output.",
    prompt: `Clean and transform the provided data into a useful run-owned output.

Search Notion and Drive for context about the data source and expected format. Read the uploaded file or linked Sheet. Use Python to profile columns, detect missing values, normalize names, calculate any requested fields, and produce a validation summary.

Create or copy a Google Sheet as the output and write only to that run-owned file. Do not mutate the original source Sheet unless explicitly approved.

Return the output Sheet link, transformation notes, validation checks, rows changed, assumptions, unresolved issues, and a Notion memory page with the summary.`,
  },
  {
    title: "Client research pack",
    bestFor:
      "Collecting evidence from Notion and Drive into a reusable brief or planning doc.",
    prompt: `Create a client research pack from Summon memory.

Search Notion and Google Drive for the client name, strategy docs, reports, meeting notes, budget trackers, PPC/SEO/social notes, and Summon Memory. Use only cited evidence and clearly mark anything not found.

Create a run-owned research brief with executive summary, source list, active workstreams, recent performance context, known risks, open questions, and recommended next steps.

Save the final link and evidence summary into a Notion memory page so future agents can reuse it.`,
  },
];

export function AgentStarterBriefs() {
  return (
    <section className="space-y-3 rounded-md border border-emerald-300/20 bg-emerald-300/5 p-4">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-md bg-emerald-300 text-zinc-950">
          <ClipboardList aria-hidden className="size-4" />
        </div>
        <div>
          <p className="text-sm font-semibold text-white">Starter briefs</p>
          <p className="mt-1 text-sm leading-6 text-zinc-400">
            Use these as copy-ready starting points, then add the exact client,
            files, links, and success criteria for the job.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {AGENT_STARTER_BRIEFS.map((brief) => (
          <details
            className="group rounded-md border border-white/10 bg-black/25 p-3 open:border-emerald-300/30"
            key={brief.title}
          >
            <summary className="flex cursor-pointer list-none items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-medium text-white">
                  <SearchCheck
                    aria-hidden
                    className="size-4 shrink-0 text-emerald-200"
                  />
                  {brief.title}
                </span>
                <span className="mt-1 block text-sm leading-5 text-zinc-500">
                  {brief.bestFor}
                </span>
              </span>
              <Badge className="shrink-0">Open</Badge>
            </summary>
            <div className="mt-4 space-y-3">
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-white/10 bg-zinc-950/70 p-3 font-mono text-xs leading-5 text-zinc-200">
                {brief.prompt}
              </pre>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
