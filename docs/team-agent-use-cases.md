# Summon Agent Platform - Team Use Cases

Use this document to run the first team walkthrough. The goal is to show that agents are practical work assistants: they can read Summon memory in Notion and Google Drive, use uploaded files, run calculations, create Google Docs/Sheets/Slides outputs, and keep a run history.

Production app: https://summon-agent-platform.vercel.app/app

## Before The Session

Each team member should:

1. Sign in to the platform.
2. Select the `Summon Team` workspace.
3. Open `Connectors` and confirm Notion and Google Drive are connected.
4. Create new agents as manual agents first. Only schedule an agent after one manual test run looks right.

Recommended provider/model choices:

| Task | Provider/model |
|---|---|
| Normal team testing | OpenAI / `gpt-4.1` |
| Cheap memory lookup or simple summary | Anthropic / `claude-haiku-4-5-20251001` |
| Complex judgement, messy data cleanup, QA review | Anthropic / `claude-sonnet-4-6` if available; otherwise OpenAI stronger model |
| Client-facing report/deck generation | OpenAI stronger model or Claude Sonnet, then inspect output carefully |

Safety rule:
- Reads are safe.
- Creating new Docs/Sheets/Slides in Drive is safe.
- Editing copied/run-owned files is safe.
- Deleting files, changing budgets, sending external messages, or mutating existing client assets should require approval.

## Demo 1: Budget Pacing Review

Purpose: show a daily PPC/account-management agent that reads budget trackers and Summon memory, then creates a client-ready summary.

Use this as the live demo because it maps to a real weekly/daily workflow.

### Agent Setup

Open `New agent`.

Fields:

| Field | Value |
|---|---|
| Agent name | `Budget pacing review` |
| Description | `Reviews budget trackers and reporting notes, then highlights pacing risks and recommended next actions.` |
| Provider | `OpenAI` |
| Model | `gpt-4.1` |
| Trigger | `Manual` for first test |
| References | Add the Google Sheet/Drive link for the relevant budget tracker if you have one |
| Uploads | Optional exported CSV if you want a file-specific review |

Prompt to paste:

```text
Review current budget pacing for the selected client or tracker.

Use Summon memory first:
- Search Notion for Summon Memory, budget tracker notes, reporting notes, PPC, Google Ads, and client-specific notes.
- Search Google Drive for budget trackers, reporting files, Google Sheets, and planning docs.

If I attached a CSV or provided a Google Sheet link, use that as the main data source.

Calculate and explain:
- Current spend vs planned budget.
- Ideal spend pace for the current month.
- Overpacing or underpacing risk.
- Campaigns or categories that need attention.
- Any missing data that blocks a confident recommendation.

Output:
- Create a clear client-ready summary.
- Include the key numbers.
- Cite the Notion/Drive sources used.
- Add a short "recommended next actions" section.
- Do not claim live Google Ads access unless a direct Google Ads source was actually used.
- Do not change budgets, campaigns, or existing files.
```

### What To Show The Team

1. Create the agent.
2. Run it manually.
3. Open the run page.
4. Show `Your output` first.
5. Show connector evidence below it.
6. Explain that the run history keeps the audit trail.

### Team Exercises

Ask each person to create one of these:

```text
Review [CLIENT NAME] budget pacing for this month. Use Summon Memory, Notion notes, and Google Drive budget/reporting files. Create a concise internal update with risks, missing data, and recommended next actions.
```

```text
Check whether [CLIENT NAME] has any budget tracker, reporting template, or paid media planning notes in Notion or Google Drive. Summarize what exists, link the sources, and list what still needs to be created.
```

## Demo 2: Client Research Pack

Purpose: show a research/onboarding agent that collects internal memory into a reusable brief.

### Agent Setup

Fields:

| Field | Value |
|---|---|
| Agent name | `Client research pack` |
| Description | `Builds an internal research brief from Notion and Google Drive.` |
| Provider | `OpenAI` or `Anthropic` |
| Model | `gpt-4.1` or `claude-haiku-4-5-20251001` |
| Trigger | `Manual` |
| References | Optional client folder, Google Doc, Sheet, or Slides link |

Prompt to paste:

```text
Create an internal research pack for [CLIENT NAME].

Use Summon memory first:
- Search Notion for Summon Memory, client notes, meeting notes, reporting notes, PPC, budget, and strategy.
- Search Google Drive for folders, Docs, Sheets, Slides, reports, QBRs, and trackers related to this client.

Output a structured research brief with:
- Who the client is.
- What we appear to work on for them.
- Known goals, KPIs, budgets, campaigns, markets, or services.
- Important links and source titles.
- Open questions or missing information.
- Suggested next steps for the account manager.

Rules:
- Cite every important fact with a source title and link.
- Say "not found" where information is missing.
- Do not invent facts.
- Do not edit existing files.
```

### What To Show The Team

1. Show how to add a client name.
2. Show that the agent searches memory instead of relying only on the prompt.
3. Show source links in the output.
4. Explain "not found" is a good result when data is missing.

### Team Exercises

```text
Create a research pack for [CLIENT NAME] using Notion and Drive. Focus on what the PPC team needs before a client call: goals, recent reporting, budgets, campaigns, open issues, and missing information.
```

```text
Find all reusable reporting or QBR materials for [CLIENT NAME]. Summarize what each file is, when it was last updated if available, and whether it looks reusable for the next report.
```

## Demo 3: Messy Data Cleanup To Google Sheet

Purpose: show a practical data-cleaning agent that can take an uploaded CSV and return a clean Google Sheet.

### Agent Setup

Fields:

| Field | Value |
|---|---|
| Agent name | `Messy data cleanup` |
| Description | `Cleans exported CSV data and creates a run-owned Google Sheet with review notes.` |
| Provider | `Anthropic` or `OpenAI` |
| Model | `claude-haiku-4-5-20251001` for cheap cleanup, or stronger model for messy judgement |
| Trigger | `Manual` |
| Uploads | Upload the messy CSV |

Prompt to paste:

```text
Clean the uploaded CSV and create a new run-owned Google Sheet.

Tasks:
- Standardise column names.
- Standardise dates to YYYY-MM-DD where possible.
- Standardise currency and numeric columns where possible.
- Normalise campaign names and text casing.
- Keep a "Needs Review" column for anything uncertain.
- Keep a "Cleaning Notes" column explaining what changed or what needs human review.
- Do not guess currency conversions unless the exchange rate is explicitly provided.
- Do not delete rows.
- Do not edit the original file.

Output:
- A link to the new Google Sheet.
- A short summary of what was cleaned.
- A list of rows or fields needing human review.
```

### What To Show The Team

1. Upload a CSV.
2. Run the agent.
3. Open the generated Google Sheet.
4. Show "Needs Review" and "Cleaning Notes".
5. Explain this is safer than silently changing ambiguous data.

### Team Exercises

```text
Clean this uploaded CSV for account-manager use. Create a Google Sheet with cleaned columns, preserved original rows, and a review flag for anything uncertain.
```

```text
Prepare this uploaded paid-media export for reporting. Clean dates, campaign names, spend, clicks, conversions, and notes. Add calculated CTR/CVR/CPC/CPL if the required columns exist.
```

## Demo 4: QBR Or Report Deck From Template

Purpose: show an advanced agent that uses a template deck, uploaded data, and optional helper Python to produce a copied editable deck.

Use this only after the simpler demos. It is more powerful but also easier to judge harshly because deck design has to be inspected manually.

### Agent Setup

Fields:

| Field | Value |
|---|---|
| Agent name | `Report deck generator` |
| Description | `Uses a template deck and uploaded performance data to create a new editable report deck.` |
| Provider | `OpenAI` stronger model or Claude Sonnet if available |
| Model | Stronger model preferred |
| Trigger | `Manual` |
| References | Add the Google Slides template URL |
| Uploads | Upload CSV data; optionally upload helper Python as reference |

Prompt to paste:

```text
Create a new editable Google Slides report deck from the uploaded data and the provided template deck.

Important:
- Copy the template deck first.
- Never edit the original template.
- Treat the template as design and structure only, not as trusted current data.
- Use the uploaded CSV as the source of fresh numbers.
- If helper Python is attached, use it as calculation reference. If imports are missing, write a self-contained Python script in the sandbox using the same formulas where possible.
- Search Notion and Google Drive for relevant client context, reporting notes, QBR notes, budget notes, and campaign context.

Required workflow:
1. Calculate KPIs from the uploaded CSV.
2. Create a copied run-owned Google Slides deck.
3. Replace old template numbers and commentary with fresh data.
4. Preserve the template design as closely as possible.
5. Create charts or tables where useful.
6. Leave clear placeholder text where required data is missing.
7. Add a final summary with:
   - Final deck link.
   - Metrics calculated.
   - Evidence used.
   - What could not be verified.
   - Placeholders left for human editing.

Do not invent data. Do not claim live Google Ads or GA4 access unless those direct APIs were actually used.
```

### What To Show The Team

1. Explain this is an advanced workflow.
2. Show the template deck link.
3. Show uploaded CSV.
4. Run the agent.
5. Inspect the generated deck manually.
6. Check whether old/template claims were replaced or marked as placeholders.

### Team Exercises

```text
Use this report template and uploaded CSV to create a first-draft client report. Keep the template design, update all numbers from the CSV, and leave placeholders where data is missing.
```

```text
Create a short internal performance deck from this uploaded data. Use the template only for design. Include KPI summary, trend slide, campaign breakdown slide, and next-action slide.
```

## Demo 5: Scheduled Agent

Purpose: show that an agent can run in the background once a manual test is approved.

Do this only with a safe read-only agent first.

### Agent Setup

Start from the Budget Pacing Review agent after it has produced a good manual result.

Change:

| Field | Value |
|---|---|
| Trigger | `Scheduled` |
| Frequency | `Daily` or `Weekly` |
| Timezone | `Europe/London` |
| Time | A real time the team understands |

Prompt addition:

```text
This is a scheduled background check. Keep the output concise. Focus only on changes, risks, blockers, and recommended next actions since the previous run where possible.
```

### What To Show The Team

1. Manual test first.
2. Edit schedule.
3. Activate.
4. Explain the worker runs the job in the background.
5. Explain that scheduled outputs stay in Runs.

### Team Exercises

```text
Create a weekly Monday morning agent for [CLIENT NAME] that reviews budget/reporting notes and produces a short internal risk update.
```

```text
Create a daily read-only check for [CLIENT NAME] that searches Drive and Notion for any newly updated reporting or budget files and summarizes changes.
```

## How To Judge Whether An Agent Is Good

An agent is ready to reuse when:

- It returns a clear output at the top of the run page.
- It links to any generated Doc/Sheet/Slide.
- It cites Notion/Drive evidence when making factual claims.
- It says what it could not verify.
- It does not invent direct Google Ads/GA4 access.
- It does not edit original files unless explicitly approved.
- It leaves uncertain data in "needs review" instead of guessing.
- The first manual run is reviewed by a human before scheduling.

## Suggested Team Assignment

Ask each team member to create two agents:

1. One safe memory/research agent:

```text
Search Summon Notion and Google Drive for [CLIENT NAME]. Create an internal briefing with source links, known goals, available reports, budget/tracker files, and missing information.
```

2. One practical operations agent:

```text
Use the uploaded CSV or linked Google Sheet to produce a cleaned, account-manager-ready output. Create a new Google Sheet, preserve the original data, add calculated metrics where possible, and flag anything that needs review.
```

Optional advanced task for confident users:

```text
Use this report template and uploaded performance data to create a first-draft client presentation. Copy the template, update the copied deck only, use fresh calculations, cite context sources, and leave placeholders for missing data.
```

## Facilitation Notes For Sergey

Recommended session structure:

1. Five minutes: explain the platform.
2. Ten minutes: demo Budget Pacing Review.
3. Ten minutes: demo Client Research Pack.
4. Ten minutes: demo Data Cleanup to Sheet.
5. Ten minutes: each person creates one agent.
6. Five minutes: review one or two outputs together.

Recommended message to the team:

```text
Treat agents like junior operators with tools. Give them the same context you would give a person: goal, data sources, output format, what not to do, and what needs human review. Start manual, inspect the output, then schedule only if the manual run is good.
```
