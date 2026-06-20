# Summon Agent Platform

Internal Summon platform for creating workspace agents that can search Notion and Google Drive, run Python in a sandbox, create run-owned Google Drive artifacts, write client-ready outputs, schedule recurring work, and route protected actions through approvals.

## Production

- App: https://summon-agent-platform.vercel.app
- Web hosting: Vercel project `summon-agent-platform`
- Worker hosting: Railway project `summon-agent-platform-worker`, service `agent-run-worker`
- Queue backend: Postgres via `pg-boss`
- Database: Supabase Postgres through Prisma

## What The Platform Supports

- Clerk sign-in, personal workspaces, shared workspaces, roles, and invite links.
- Agent creation with provider/model selection, manual or scheduled triggers, connector selection, file uploads, and reference links.
- Default Summon memory through Notion and Google Drive.
- Python sandbox runs for uploaded or generated helper code.
- Run-owned Google Drive, Docs, Sheets, and Slides outputs.
- Tool-call logs, generated artifacts, run output, token usage, and estimated LLM cost.
- Approval-gated protected actions.

## Local Development

```bash
cd /Users/sergeysotskiy/Documents/summon/agentic-platform/my-clerk-app
npm run dev
```

On this Mac, if native Next.js bindings fail because of local code-signing issues, use the existing script command as-is. The app script already runs webpack rather than Turbopack.

Start the worker in a second terminal:

```bash
cd /Users/sergeysotskiy/Documents/summon/agentic-platform/my-clerk-app
npm run worker:agent-runs
```

## Required Runtime Environment

The app and worker both need database and model/provider keys. Production values live in Vercel and Railway; do not commit `.env`.

Core:

```env
DATABASE_URL=
DIRECT_URL=
CONNECTOR_ENCRYPTION_KEY=
OPENAI_API_KEY=
DEFAULT_LLM_PROVIDER=openai
DEFAULT_LLM_MODEL=
```

Auth and app:

```env
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
```

Connectors and email:

```env
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=
NOTION_OAUTH_CLIENT_ID=
NOTION_OAUTH_CLIENT_SECRET=
NOTION_OAUTH_REDIRECT_URI=
RESEND_API_KEY=
INVITE_FROM_EMAIL=
```

Optional:

```env
ANTHROPIC_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=
GOOGLE_ADS_DEVELOPER_TOKEN=
GOOGLE_ADS_CUSTOMER_ID=
GOOGLE_ADS_LOGIN_CUSTOMER_ID=
GOOGLE_ADS_API_VERSION=
GA4_PROPERTY_ID=
NOTION_TOKEN=
NOTION_PARENT_PAGE_ID=
```

## Verification Commands

Run these before deploying code changes:

```bash
npx prisma validate
npm run db:generate
npm run lint
npx tsc --noEmit
npm run build
```

Useful production checks:

```bash
/opt/homebrew/bin/vercel ls summon-agent-platform --scope serges-projects-c7c3148b
/opt/homebrew/bin/railway status
/opt/homebrew/bin/railway logs --service agent-run-worker --lines 50
```

## Team Usage Guide

Inside the app, open **Help** from the sidebar. The guide covers:

- creating the first agent
- attaching multiple files and reference links
- running and scheduling agents
- reviewing run evidence, artifacts, costs, and approvals
- QBR/report, budget pacing, and client research task patterns

## Current External Setup Notes

- Resend DNS records are present, but invite email delivery depends on Resend domain verification completing in the Resend dashboard.
- Google Drive and Slides are working for the current production connector. Native Google Docs and Sheets APIs may need enabling in the Google Cloud project before direct API probes show fully ready.
- Google Ads direct API access is optional for now. Agents can work through Google Sheets, Drive, and Notion budget/reporting memory until Ads API access is approved.
