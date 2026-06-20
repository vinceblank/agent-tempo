# GitHub App: `agent-tempo[bot]`

Players in the ensemble can interact with GitHub (issues, PRs, commits, CI) under
a dedicated bot identity instead of the maintainer's personal account. This gives
contributors a clear visual signal that the actor is AI, while still letting the
ensemble do real work end-to-end.

## What the bot can do

The installed permissions match a full "shipping team":

| Capability | Backed by |
| --- | --- |
| Read/create/edit/comment/delete **issues** | `issues: write` |
| Create/review/merge **pull requests** | `pull_requests: write` |
| Create commits, branches, tags | `contents: write` |
| Edit `.github/workflows/*.yml` | `workflows: write` |
| Trigger / re-run / cancel workflow runs | `actions: write` |
| Post check runs and commit statuses | `checks: write`, `statuses: write` |
| Create deployments, manage environments | `deployments: write`, `environments: write` |
| Read branch protection rules & repo settings | `administration: read` |

Deliberately **not** granted: secrets management, collaborator/settings mutation,
repo deletion. Those stay human-only.

GitHub always blocks self-approval, so a PR opened by `agent-tempo[bot]` cannot
be approved by `agent-tempo[bot]`. That guardrail is the point — a human (or a
different identity) must approve before merge.

## Credentials layout

Everything lives outside the repo at `~/.agent-tempo/`:

```
~/.agent-tempo/
├── github-app.env                # App ID, Installation ID, key path (sourceable)
├── github-app.private-key.pem    # RSA private key (chmod 600 — never commit)
└── github-app.token.json         # Auto-managed token cache (55-min TTL)
```

The repo itself gitignores `secrets/`, `*.pem`, `*.p12`, `*.pfx`, `*.key` as a
defense-in-depth measure — the real credentials should never land in the repo
tree at all.

## Using the wrapper

`scripts/ensemble-gh` is a thin wrapper around the `gh` CLI. It mints a fresh
installation token (or reuses a cached one) and injects it as `GH_TOKEN` for a
single invocation.

```bash
# Post an issue comment as the bot
./scripts/ensemble-gh issue comment 42 --body "Looking into this."

# Open a PR as the bot
./scripts/ensemble-gh pr create --title "..." --body "..."

# Raw API call as the bot
./scripts/ensemble-gh api repos/vinceblank/agent-tempo/issues
```

The wrapper exec's `gh` directly, so every flag and subcommand works. It also
clears `GITHUB_TOKEN` in its own environment to prevent CI-inherited tokens
from outranking the installation token.

> **Windows / PowerShell** — `scripts/ensemble-gh.cmd` is a sibling Windows shim
> (#741). PowerShell's PATHEXT resolution picks up the `.cmd` file, so
> `./scripts/ensemble-gh` works directly from PowerShell — no `bash` prefix needed.
> The shim locates Git Bash relative to `git.exe` on PATH (falling back to
> `C:\Program Files\Git\bin\bash.exe`) and fails **loudly** with a non-zero exit if
> Bash cannot be found, so the silent-no-op failure mode is gone.
>
> If for any reason the shim cannot be used, you can still invoke via `bash` explicitly:
>
> ```bash
> bash ./scripts/ensemble-gh pr create --title "..." --body "..."
> ```

### When to use `ensemble-gh` vs plain `gh`

| Use `ensemble-gh` when… | Use plain `gh` when… |
| --- | --- |
| Posting issue or PR comments from a player | Commands purely for local dev (e.g. `gh auth status`, `gh repo clone`) |
| Opening PRs from ensemble work | Reading repo data where attribution doesn't matter (e.g. `gh pr view`) |
| Creating commits/branches from automation | You explicitly want the action attributed to the human |
| Adding labels, closing issues, editing descriptions | Anything that requires `admin:*` scopes the bot doesn't have |

**Rule of thumb:** anything that writes something a human contributor will see —
goes through `ensemble-gh`. Anything that only reads, or that you want
attributed to you personally — use `gh`.

## AI attribution footer

Every comment, PR body, and issue body the bot posts must end with this
attribution block. Contributors should never have to guess whether they're
talking to a human.

```markdown

---
🎼 _Posted by [agent-tempo\[bot\]](https://github.com/apps/agent-tempo) —
an AI ensemble acting on behalf of @vinceblank. For a human, mention @vinceblank directly._
```

Single-line variant (for terse comments):

```markdown
— 🎼 _agent-tempo[bot] (AI). Mention @vinceblank for a human._
```

Include it in the body you pass to `ensemble-gh`, not via a server-side
post-processor — the footer should be part of the authored text so edits
preserve it.

## Token minter

`scripts/gh-app-token.js` is the underlying helper. You rarely need to call it
directly, but it supports:

```bash
node scripts/gh-app-token.js            # prints the installation token
node scripts/gh-app-token.js --json     # prints full API response with expiry
node scripts/gh-app-token.js --force    # bypasses the local cache
```

It self-loads `~/.agent-tempo/github-app.env` if the env vars aren't already
set, mints an RS256 JWT from the private key, exchanges it for an installation
token via GitHub's `/app/installations/{id}/access_tokens` endpoint, and caches
the result at `~/.agent-tempo/github-app.token.json` (refreshed when <5 min
remain).

Plain CommonJS, no npm dependencies — runs without `npm run build`.

## Troubleshooting

**`missing env: CLAUDE_TEMPO_GH_APP_*`**  
The helper couldn't find credentials. Either the env file is missing, or its
values aren't loaded. Verify `~/.agent-tempo/github-app.env` exists and has
all three of `APP_ID`, `INSTALLATION_ID`, `PRIVATE_KEY`.

**`GitHub API 401: Bad credentials`**  
The JWT was rejected. Usually means the clock is skewed (>60 s off) or the
private key doesn't match the App ID. Regenerate a key at
`https://github.com/settings/apps/agent-tempo` if in doubt.

**`GitHub API 404: Not Found` from `/installations/{id}/access_tokens`**  
Installation ID is wrong or the app has been uninstalled. Check
`https://github.com/settings/installations` and update the env file.

**`Resource not accessible by integration`**  
The bot is trying to do something beyond its granted permissions. Review the
permissions block at the top of this doc and widen via the app settings page
if appropriate.

**Git Bash path rewriting (`invalid API endpoint: "C:/..."`)**  
Omit the leading slash on `gh api` endpoints: `gh api installation/repositories`
instead of `gh api /installation/repositories`. Git Bash's MSYS layer rewrites
anything that looks like a Unix absolute path.

## Rotating the private key

Keys are long-lived and have no automatic expiry. Rotate whenever:

- a new key is strictly better (e.g. longer modulus)
- the existing key may have been exposed

Procedure:

1. `https://github.com/settings/apps/agent-tempo` → **Private keys** → **Generate a private key** (downloads `.pem`).
2. Move to `~/.agent-tempo/github-app.private-key.pem` (overwriting). `chmod 600`.
3. Click **Delete** next to the old key on the app settings page.
4. Delete the cache: `rm ~/.agent-tempo/github-app.token.json`.
5. Smoke test: `node scripts/gh-app-token.js --json` should print a fresh token.

## Smoke test

```bash
# Mint a token and check what it can see
./scripts/ensemble-gh api installation/repositories --jq '.repositories[].full_name'

# Post and immediately delete a test comment
url=$(./scripts/ensemble-gh issue comment <issue-number> \
  --body "smoke test — will be deleted" --repo vinceblank/agent-tempo)
# verify identity shows as agent-tempo[bot], then:
comment_id="${url##*issuecomment-}"
./scripts/ensemble-gh api -X DELETE \
  repos/vinceblank/agent-tempo/issues/comments/"$comment_id"
```
