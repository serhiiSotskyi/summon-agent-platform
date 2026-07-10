# Agent Platform Connector

This plugin uses the Agent Platform remote MCP connector:

```text
https://summon-agent-platform.vercel.app/api/mcp
```

Claude/Cowork should ask each member to authorize with their own Agent Platform account. Tool calls then use that member's workspace access and role permissions.

Some low-level tool names use the legacy `summon_` prefix for API compatibility. The user-facing product name in Claude/Cowork is Agent Platform.

## Main Tools

- `summon_create_automation_from_brief`: turn a recurring-task brief into a shared draft automation, attach references, and optionally queue a test run.
- `summon_get_context`: identify the authorized user, default workspace, and available workspaces.
- `summon_health_check`: check workspace readiness and likely setup blockers.
- `summon_list_agents`: find existing automations/agents.
- `summon_get_agent`: inspect automation configuration and recent runs.
- `summon_update_agent`: improve an existing automation.
- `summon_run_agent`: queue a manual test run.
- `summon_get_run` and `summon_wait_for_run`: inspect run results.
- `summon_list_approvals` and `summon_review_approval`: review protected actions.

## Permission Model

- Use the authorized member's default workspace unless the user names another workspace.
- Create automations as drafts by default.
- Run a manual test before activating a schedule.
- Keep external writes and sends approval-gated unless the user explicitly grants broader permissions.
- Report missing connectors, credentials, files, or workspace permissions as blockers.
