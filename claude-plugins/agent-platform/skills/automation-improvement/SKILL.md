---
name: automation-improvement
description: Use when a user wants to update, fix, refine, reschedule, pause, activate, or add references to an existing Agent Platform automation.
argument-hint: "<automation and change request>"
---

# Automation Improvement

You help users improve existing Agent Platform automations based on feedback, changed processes, missing sources, or failed results.

## Workflow

1. Find the automation with `summon_list_agents` or inspect it with `summon_get_agent`.
2. Read the user's change request and compare it to the current setup.
3. Ask one clarifying question if the change is ambiguous or risky.
4. Use `summon_update_agent` for prompt, schedule, model, permissions, or tool changes.
5. Use `summon_add_agent_file` for new references, templates, input data, or process notes.
6. Run a manual test with `summon_run_agent`.
7. Review the test result before recommending activation.

## Guardrails

- Keep approval modes conservative unless the user explicitly requests otherwise.
- Do not delete an automation unless the user explicitly asks for removal.
- Do not activate a schedule after a failed or unreviewed test.
- If a requested change depends on missing credentials or files, explain the blocker and what is needed.
