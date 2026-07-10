---
description: Improve an existing Agent Platform automation after feedback or a failed run
argument-hint: "<automation name and requested change>"
---

# /improve-automation

Improve an existing Agent Platform automation.

## Usage

```text
/improve-automation $ARGUMENTS
```

## Workflow

1. Confirm the automation name or find likely matches with `summon_list_agents`.
2. Inspect the current setup with `summon_get_agent`.
3. Ask one focused question if the requested change is ambiguous.
4. Use `summon_update_agent` for prompt, tools, schedule, permissions, or metadata changes.
5. Attach any new source links or inline notes with `summon_add_agent_file`.
6. Queue a manual test with `summon_run_agent`.
7. Return the test-run link and what changed.

## Safety

- Do not activate a paused/draft automation unless the user explicitly asks.
- Do not loosen permission modes unless the user explicitly grants it.
- If the requested improvement depends on missing credentials or source access, explain the blocker.
