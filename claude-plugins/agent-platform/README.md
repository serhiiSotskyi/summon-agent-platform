# Agent Platform Plugin

Agent Platform lets Claude/Cowork turn recurring team work into shared automations.

The intended user request is simple:

```text
This is a task I do regularly with you. Can you automate it in the Agent Platform? Ask me anything you need and set it up so my team can see it, run it, and review the results.
```

Claude should clarify the task, create a shared draft automation, queue a test run when ready, and return links to the automation and run result.

## Commands

| Command | Purpose |
|---|---|
| `/automate-task` | Convert a recurring manual task into a shared Agent Platform automation |
| `/review-automation-results` | Review recent automation runs, outputs, blockers, and approvals |
| `/improve-automation` | Update an existing automation after a bad result, changed process, or new source |

## Typical Workflow

1. Understand the recurring task the user already does with Claude.
2. Ask only for missing operational details.
3. Check Agent Platform context and workspace readiness.
4. Create a draft automation with `summon_create_automation_from_brief`.
5. Attach references, templates, output destinations, or inline process notes.
6. Queue a manual test run when the user confirms enough detail.
7. Review the test result with the user.
8. Activate the schedule only after the user approves the behavior.

## Safety Defaults

- Draft first, test second, activate third.
- Use the user's authorized Agent Platform workspace and role.
- Do not use a shared admin account.
- Ask before external sends, destructive changes, campaign/budget edits, or mutations to existing external files.
- Use `best_value` model cost by default. Premium recurring models require explicit user approval.
- Let Agent Platform infer the narrow connector/tool set from each brief instead of asking nontechnical users to pick tools manually.
- Make blockers explicit instead of pretending an automation is ready.

## Organization Rollout

Owners can distribute this plugin through Claude Organization settings > Plugins by uploading a ZIP or syncing the GitHub repository that contains `.claude-plugin/marketplace.json`.
