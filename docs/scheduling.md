# Scheduling

Players can set up schedules to send messages on timers — useful for periodic checks, reminders, and recurring coordination.

Three tools are available:
- **`schedule`** — Create a named schedule (one-shot or recurring)
- **`unschedule`** — Remove a schedule by name
- **`schedules`** — List all active schedules

## Examples

Tell your session things like:

- *"Schedule a check every hour called 'deploy-watch' — cue ops to check deployment status"*
- *"Remind me in 30 minutes to review PR #42"*
- *"Every 5 minutes for the next hour, ping frontend to check their progress"*
- *"Set up a daily standup at 9am New York time, weekdays only"*
- *"Cancel the deploy-watch schedule"*
- *"Show me all active schedules"*

## Timing Modes

Schedules support four timing modes — all accept optional bounds (`count` max fires, `until` end time):

| Mode | Parameter | Example |
|------|-----------|---------|
| One-shot delay | `delay` | `"10m"`, `"2h"`, `"1d"` |
| Fixed time | `at` | `"2026-04-03T20:00:00Z"` |
| Recurring interval | `every` | `"5m"`, `"1h"` |
| Cron expression | `cron` + optional `timezone` | `"0 9 * * 1-5"` (weekdays 9am) |

The `timezone` parameter accepts any IANA timezone (e.g. `"America/New_York"`, `"Europe/London"`). Defaults to UTC when omitted.

## How It Works

- Scheduled messages arrive with a `[scheduled: name]` prefix so recipients can distinguish them from direct cues
- The `from` field is set to the schedule creator, so replies go to the right person
- If the target player is gone when a schedule fires, the creator is notified so they can re-recruit if needed. Falls back to notifying the conductor if the creator is also unavailable
- Messages include `isScheduled` metadata for dashboard integrations
- `agent-tempo status` shows active schedules alongside sessions
- A single durable scheduler workflow per ensemble manages all schedules using Temporal timers

## Fan-out Schedules

Use `target: "all"` in a lineup schedule to deliver a message to every active player (excluding the conductor). Useful for periodic status checks or broadcast announcements:

- *"Schedule a message every 30 minutes to all players asking for a progress update"*

See [ensembles.md](ensembles.md) for how to define schedules inside lineup YAML files.
