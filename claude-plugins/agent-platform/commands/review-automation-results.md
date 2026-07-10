---
description: Review Agent Platform automation runs, outputs, blockers, and approvals
argument-hint: "<automation name, run, or timeframe>"
---

# /review-automation-results

Review automation results from Agent Platform and explain what the team should do next.

## Usage

```text
/review-automation-results $ARGUMENTS
```

## Workflow

1. Use `summon_get_context` to confirm workspace.
2. Use `summon_list_agents` or `summon_get_agent` to find the automation.
3. Use `summon_get_run` for a specific run or inspect recent runs from `summon_get_agent`.
4. If a run is still queued or running, use `summon_wait_for_run`.
5. Use `summon_list_approvals` if the result mentions blocked or protected actions.
6. Summarize the result for a nontechnical teammate.

## Output

Return:

- what ran
- whether it succeeded
- what result or artifact was produced
- what evidence was used
- any blockers or missing credentials
- pending approvals
- recommended next action

Do not mark an automation as reliable unless a recent run succeeded with usable evidence.
