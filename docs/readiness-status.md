# Summon Agent Platform Readiness Status

Last updated: 2026-06-20  
Production app: https://summon-agent-platform.vercel.app  
Workspace checked: `Summon Team` (`cmpy69ti10033bsmqz2ll3lko`)  
Worker checked: Railway `summon-agent-platform-worker` / `agent-run-worker`

## Current Verdict

The platform is usable for controlled internal QA and early team trials. It is not yet fully ready for broad non-technical rollout because invite email delivery still depends on Resend domain verification, and native Google Docs/Sheets API readiness still needs to be enabled/confirmed in Google Cloud.

The core agent runtime is no longer blocked by Redis. Production is using the Postgres-backed worker path and recent evidence shows successful manual runs, scheduled runs, and approved-action processing.

## Production Evidence

### App And Worker

- Latest Vercel production deployment: ready and aliased to `summon-agent-platform.vercel.app`.
- Railway worker status: online.
- Worker log shows:
  - `worker ready (queue=agent-runs, backend=pg-boss, mode=tool-loop)`
  - successful manual QBR-style run
  - successful scheduled trigger run
  - successful approved-action execution

### Workspace State

`Summon Team` is a shared workspace with one active owner:

| Member | Role | Status |
| --- | --- | --- |
| Serge / `serge@summon.co` | Owner | Active |

Identity sync is currently good for the owner account. The previous placeholder-email issue is not present for the checked owner record.

### Connected Memory And Files

Active production credentials in `Summon Team`:

| Connector | Status | Notes |
| --- | --- | --- |
| Notion | Active | Shared workspace credential. Used as Summon memory. |
| Google Drive | Active | Shared workspace credential. Write-capable scope is configured in the catalog. |

Google Ads and GA4 direct API access are optional for now. Budget/reporting agents should continue to use Notion and Google Drive/Sheets as the source of truth until Google Ads API access is approved and connected.

### Agent Coverage

Current production agent counts:

| Status | Trigger | Count |
| --- | --- | ---: |
| Active | Manual | 8 |
| Draft | Manual | 2 |
| Paused | Scheduled | 1 |

Recent production run evidence includes:

| Run | Agent | Type | Status | Cost evidence |
| --- | --- | --- | --- | --- |
| `cmqmdgoph0001bswlptl8e1a2` | QA - Wendy Wu Australia QBR Agent | Manual | Success | `0.712140` |
| `cmqmdw6ez0019pi2615n5tu5a` | QA - Scheduled Agent | Scheduled | Success | `0.037968` |
| `cmqmeayc40001bsspeokbf9z4` | QA - Approval Test Agent | Manual | Success | Approval execution record |

The run evidence proves:

- manual queue execution works
- scheduled triggers fire through Railway
- successful runs store estimated cost
- approved actions can be queued and completed

## What Is Ready For Internal Trials

- Sign-in and shared workspace access.
- Agent creation with natural-language prompts.
- Starter briefs on the new-agent page for common Summon workflows such as report decks, budget pacing, data cleanup, and client research.
- Multiple reference links and multi-file uploads for small text/code/data files.
- Manual runs and scheduled runs.
- Postgres-backed worker execution through Railway.
- Notion and Google Drive memory reads.
- Python sandbox execution.
- Run-owned Google Drive/Slides/Docs/Sheets artifact workflows where APIs are enabled and available.
- Tool-call logs, artifacts, run output, duration, token usage, and estimated cost.
- Approval queue display and approved-action job execution.
- In-app Help page at `/app/help`.
- Project operator README with local/dev/deploy commands.
- Lightweight smoke tests with `npm run test:smoke`.

## Current Blockers And Degraded Areas

### P1: Resend Domain Verification Still Blocks Invite Emails

DNS records for `summon.co` are present:

| Record | Current DNS state |
| --- | --- |
| `TXT resend._domainkey.summon.co` | Present |
| `MX send.summon.co` | `feedback-smtp.eu-west-1.amazonses.com`, priority 10 |
| `TXT send.summon.co` | `v=spf1 include:amazonses.com ~all` |

However, invite email delivery is still failing in production with:

```text
Resend returned 403.
```

The local Resend key is restricted to sending emails only, so it cannot trigger domain verification through the Resend API. The required action is to click/restart verification in the Resend dashboard, or temporarily provide a Resend API key with domain-management access.

Product workaround: workspace owners/admins can use **Get link** on a pending invite to rotate the secure invite token and copy a manual invite link without attempting email delivery.

Pending invites currently affected:

| Email | Role | Status |
| --- | --- | --- |
| `developer@summon.co` | Creator | Pending, email not sent |
| `stella@summon.co` | Creator | Pending, email not sent |
| `paul@summon.co` | Creator | Pending, email not sent |

### P1: Native Google Docs/Sheets API Readiness Needs Google Cloud Action

The app has direct Google Cloud action links on the Google Drive connector diagnostics page. `gcloud` is not available in the local Codex environment, so API enablement cannot be completed from this machine right now.

Required action in Google Cloud:

- enable Google Docs API
- enable Google Sheets API
- keep Google Drive API and Google Slides API enabled
- then reconnect Google Drive if scope consent changes

### P2: Authenticated Browser QA Needs A Signed-In Browser Session

Unauthenticated route smoke tests pass, but browser-level inspection of authenticated app pages requires the in-app browser to be signed in. Current browser session is signed out and only sees the public auth entry.

## Latest Validation Commands

Passed locally:

```bash
npx prisma validate
npm run db:generate
npm run lint
npm run test:smoke
npx tsc --noEmit
npm run build
```

Production route smoke checks returned 200:

```text
/app/help
/app/settings?workspace=cmpy69ti10033bsmqz2ll3lko
/app/agents/new?workspace=cmpy69ti10033bsmqz2ll3lko
```

## Recommended Next QA Pass

After Resend verification and Google Docs/Sheets API enablement:

1. Sign into the in-app browser as the owner/admin account.
2. Re-run invite delivery to `developer@summon.co`.
3. Create a new QA agent from the UI using:
   - multiple uploaded files
   - at least two reference links
   - Notion and Google Drive tools
   - Python sandbox
   - Google Docs/Sheets/Slides write tools
4. Run it manually and confirm:
   - evidence citations
   - generated artifacts
   - token/cost metadata
   - Notion memory page
   - copied/run-owned Google output files
5. Activate a short scheduled QA agent, confirm one scheduled run fires, then pause it.
6. Trigger one protected action and verify pending, approve, reject, and post-approval execution behavior.

## Readiness Guidance For The Team

For now, onboard only a small internal pilot group. Ask them to create agents from clear existing workflows where:

- source files are attached explicitly
- Notion or Drive evidence exists
- the expected output is reviewable
- any client-facing output is checked by a human before sending

Do not treat generated decks, Docs, Sheets, or recommendations as client-final without review. The platform is strong enough for production-grade drafts and internal automation trials, but the remaining external setup items should be completed before broad rollout.
