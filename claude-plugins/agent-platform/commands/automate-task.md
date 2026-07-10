---
description: Turn a recurring task into a shared Agent Platform automation
argument-hint: "<task, process, or recurring Claude request>"
---

# /automate-task

> If you see unfamiliar connector placeholders or need to check available tools, see [CONNECTORS.md](../CONNECTORS.md).

Turn a recurring manual task into a shared Agent Platform automation.

## Usage

```text
/automate-task $ARGUMENTS
```

Users may also ask naturally:

```text
This is a task I do regularly with you. Can you automate it in the Agent Platform? Ask me anything you need and set it up so my team can see it, run it, and review the results.
```

## Workflow

1. Restate the task in plain language and identify whether it is recurring, one-off, or not yet clear.
2. Ask only for missing details that block a useful automation:
   - cadence or trigger
   - workspace/team ownership
   - source systems or files
   - desired output
   - who needs to see results
   - approval rules for sends, edits, deletes, budgets, or client-facing changes
3. Use `summon_get_context` to confirm the authorized user and default workspace.
4. Use `summon_health_check` and `summon_list_connectors` when the task depends on external sources.
5. If the request sounds like an existing automation, use `summon_list_agents` before creating a duplicate.
6. Create the automation with `summon_create_automation_from_brief`.
7. Prefer `status: "DRAFT"` and `run_test: true` once the user has answered the missing questions.
8. Show the automation link and test-run link.
9. Ask the user to review the test result before activating a schedule.

## Automation Brief Shape

When calling `summon_create_automation_from_brief`, include:

- `task_brief`: the user's recurring task in their own words
- `desired_outcome`: what a good run should produce
- `success_criteria`: how the team will know the run worked
- `audience`: who will use or review the result
- `sharing_notes`: how results should be shared in the team workspace
- `schedule`: only when cadence is known
- `references`: links, templates, output destinations, or inline process notes
- `run_test`: true when the setup is ready to test

## Default Behavior

- Create as draft unless the user explicitly asks to activate.
- Run a manual test before activating scheduled work.
- Use `ASK_BEFORE_CHANGES` and `ASK_BEFORE_SENDING` unless the user explicitly grants broader permission.
- If a connector, credential, file, or permission is missing, report it as a blocker and explain what is needed.

## Response Format

After setup, respond with:

```markdown
Created: [Automation name]
Workspace: [Workspace name]
Status: Draft / Active / Paused
Test run: [link or not run]
What it will do: [one paragraph]
What the team should review: [short checklist]
Next step: [activate schedule / adjust prompt / add missing source]
```
