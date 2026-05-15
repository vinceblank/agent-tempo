# Ensembles: Lineups, Player Types, and Agent Type Discovery

## Ensemble Lineups

Define reusable ensemble configurations as YAML files. A lineup specifies which players to recruit, what instructions to give them, what schedules to create, and optionally which custom agent files to use.

### Example Lineup

```yaml
name: my-project
conductor:
  instructions: "Coordinate the frontend and backend teams"
players:
  - name: frontend
    workDir: /repos/my-app
    instructions: "Build the React dashboard in src/components"
  - name: backend
    workDir: /repos/my-api
    instructions: "Implement the REST endpoints in src/routes"
  - name: ops
    workDir: /repos/infra
    agent: agents/ops-agent.md
    instructions: "Monitor deployments and run health checks"
schedules:
  - name: status-check
    message: "Report your current progress and any blockers"
    target: all
    every: 30m
  - name: deploy-reminder
    message: "Check if the staging deploy succeeded"
    target: ops
    delay: 10m
```

### Three Ways to Use Lineups

1. **From the CLI** — load a lineup when starting an ensemble:

   ```bash
   agent-tempo up --lineup my-lineup.yaml
   ```

2. **From inside a session** — use the `load_lineup` tool:

   *"Load the lineup from ~/.agent-tempo/ensembles/my-project.yaml"*

3. **Save the current state** — snapshot a running ensemble as a lineup (conductor only):

   *"Save this ensemble as a lineup called my-project"*

### Natural Language Examples

Tell your session things like:

- *"Load the my-project lineup"*
- *"Save this ensemble as a lineup"*
- *"Load the lineup from /repos/configs/team.yaml"*

### Fan-out Schedules

Use `target: "all"` in a schedule to deliver a message to every active player (excluding the conductor). This is useful for periodic status checks or broadcast announcements:

- *"Schedule a message every 30 minutes to all players asking for a progress update"*

See [scheduling.md](scheduling.md) for full scheduling reference.

### Custom Agents

The `agent` field on a player can be a path to a `.md` file that will be used as the session's system prompt via `--system-prompt`. This lets you create specialized agents with domain-specific instructions:

```yaml
players:
  - name: security-reviewer
    workDir: /repos/my-app
    agent: agents/security-review.md
    instructions: "Review the latest PR for security issues"
```

## Player Types

Player types are reusable agent definitions in Claude Code's standard subagent format — `.md` files with YAML frontmatter specifying name, description, optional model, and optional tool restrictions. They let you define specialized roles once and reuse them across lineups.

### How Player Types Work

Reference a type by name in a lineup's `type` field:

```yaml
players:
  - name: arch
    type: tempo-composer
  - name: eng
    type: tempo-soloist
```

When a player is recruited with a type, the agent definition is resolved and passed to the session. Players know their type via the `who_am_i` tool.

### Tool Restrictions (`allowedTools`)

Agent type frontmatter may include an `allowedTools` array to restrict which tools the spawned session can use. When present, it is passed to the Claude Code session via `--allowedTools` and overrides any lineup-level setting.

```yaml
---
name: tempo-reviewer
description: Read-only code reviewer
allowedTools:
  - Read
  - Glob
  - Grep
---
```

This is useful for security-sensitive roles (read-only reviewers, auditors) or to prevent specific players from making changes outside their scope. Sessions launched without a type, or with a type that omits `allowedTools`, receive no tool restrictions.

### Three-tier Lookup

Player types are resolved in order (first match wins):

1. **Project** — `.claude/agents/` in the project directory
2. **User** — `~/.claude/agents/` in the user's home directory
3. **Shipped** — `examples/agents/` bundled with agent-tempo

Project and user types are resolved natively by Claude Code via `--agent <name>`. Shipped types fall back to `--system-prompt <path>`.

### Shipped Player Types

| Type | Description |
|------|-------------|
| `tempo-conductor` | Orchestrates the ensemble — breaks down tasks, delegates to players, tracks progress |
| `tempo-composer` | Software architect — designs system structure, defines interfaces, makes technology decisions |
| `tempo-soloist` | Senior engineer — implements features, fixes bugs, writes tests, delivers working code |
| `tempo-tuner` | QA engineer — designs test strategies, finds bugs, validates edge cases |
| `tempo-critic` | Code reviewer — evaluates changes for correctness, security, performance, maintainability |
| `tempo-roadie` | DevOps engineer — manages CI/CD, deployments, infrastructure, environment configuration |
| `tempo-improv` | Researcher and explorer — investigates unknowns, runs spikes, evaluates options |
| `tempo-liner` | Documentation specialist — owns README, CHANGELOG, CLAUDE.md, and PR descriptions |

### Shipped Lineups

| Lineup | Description |
|--------|-------------|
| `tempo-big-band` | Full-lifecycle ensemble with all 8 player types — design, implement, test, review, and ship |
| `tempo-dev-team` | Feature development — conductor, composer, two soloists, and a tuner |
| `tempo-review-squad` | Three critics with different focus areas for thorough parallel code review |
| `tempo-jam-session` | Exploratory ensemble for spikes, research, and problems where the path is unclear |
| `tempo-mock-jam` | All-mock ensemble (dev mode only) — mixes all four mock modes (`echo`, `scripted`, `silent`, `chaos`) for end-to-end adapter testing |

## Agent Type Discovery

Use the `agent_types` MCP tool inside a session or the CLI:

```bash
agent-tempo agent-types list          # show available types
agent-tempo agent-types show <name>   # print full definition
agent-tempo agent-types init          # copy shipped examples to ~/.claude/agents/
```

## Related

- [tools.md](tools.md) — `load_lineup`, `save_lineup`, `agent_types`, `recruit` tool reference
- [scheduling.md](scheduling.md) — schedule timing modes for lineup schedules
- [orchestration.md](orchestration.md) — quality gates, stages, and worktrees for conductor workflows
