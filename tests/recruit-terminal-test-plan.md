# Recruit Terminal Spawn — Manual Test Plan

Tests for `src/tools/recruit.ts` terminal spawning across platforms and configurations.

## Prerequisites

- Temporal dev server running (`temporal server start-dev`)
- Project built (`npm run build`)
- Claude Code installed and on PATH
- `AGENT_TEMPO_ENSEMBLE` set in the conductor session

---

## macOS — Ghostty

### GT-1: Basic recruit opens Ghostty window
- **Setup**: Ghostty is the active terminal
- **Steps**: Call `recruit` with a name and workDir
- **Expected**: A new Ghostty window opens, fish (or default shell) initializes, `claude` launches with the correct name in the title bar
- **Verify**: `ensemble` shows the new session within 30 seconds

### GT-2: Environment variables are passed through
- **Setup**: Conductor is in ensemble "myband"
- **Steps**: Recruit a new session
- **Expected**: The recruited session's MCP server activates (not idle mode), confirming `AGENT_TEMPO_ENSEMBLE=myband` was received
- **Verify**: New session appears in `ensemble` output with matching ensemble

### GT-3: Node manager (fnm/nvm) PATH is preserved
- **Setup**: Node is managed via fnm or nvm (not a system install)
- **Steps**: Recruit a new session
- **Expected**: The MCP server starts successfully (requires `node` on PATH)
- **Verify**: `/mcp` in the new session shows agent-tempo connected, not failed

### GT-4: Shell with slow startup
- **Setup**: Add `sleep 2` to fish config (`~/.config/fish/config.fish`)
- **Steps**: Recruit a new session
- **Expected**: `initial input` waits for the shell prompt; claude command runs correctly after shell init completes
- **Verify**: Session registers in ensemble (may take longer than usual)
- **Cleanup**: Remove the `sleep 2` from fish config

### GT-5: Working directory is set correctly
- **Setup**: Use a workDir different from the conductor's (e.g., `/tmp`)
- **Steps**: `recruit({ workDir: "/tmp", name: "test-dir" })`
- **Expected**: New Ghostty window opens in `/tmp`
- **Verify**: `ensemble` shows `Dir: /tmp` for the new session

### GT-6: Special characters in workDir
- **Setup**: Create a directory with spaces: `mkdir -p "/tmp/my project"`
- **Steps**: `recruit({ workDir: "/tmp/my project", name: "test-spaces" })`
- **Expected**: Claude launches in the correct directory without shell quoting errors
- **Cleanup**: `rm -rf "/tmp/my project"`

---

## macOS — iTerm2

### IT-1: Basic recruit opens iTerm2 window
- **Setup**: iTerm2 is the active terminal (Ghostty not running)
- **Steps**: Call `recruit`
- **Expected**: A new iTerm2 window opens with default profile, shell initializes, `claude` launches
- **Verify**: `ensemble` shows the new session

### IT-2: Environment and PATH preserved
- **Setup**: Node managed via nvm/fnm, iTerm2 as terminal
- **Steps**: Recruit a new session
- **Expected**: MCP server connects to Temporal (node is on PATH, env vars passed)
- **Verify**: `/mcp` in new session shows agent-tempo connected

### IT-3: Uses `write text` not `command`
- **Setup**: iTerm2 active
- **Steps**: Recruit and observe the new window
- **Expected**: Shell prompt appears briefly, then the claude command is typed in (not a direct command execution). Shell profile is fully loaded before claude starts.

---

## macOS — Terminal.app

### TA-1: Basic recruit opens Terminal.app window
- **Setup**: Neither Ghostty nor iTerm2 running; Terminal.app is default
- **Steps**: Call `recruit`
- **Expected**: Terminal.app opens via `.command` file, shell profiles are sourced, `claude` launches
- **Verify**: `ensemble` shows the new session

### TA-2: zsh user with nvm
- **Setup**: Terminal.app, zsh default shell, nvm installed
- **Steps**: Recruit a new session
- **Expected**: `.command` script sources `.zshrc` and `.nvm/nvm.sh`, node is available
- **Verify**: MCP server connects successfully

### TA-3: fish user on Terminal.app
- **Setup**: Terminal.app, `SHELL=/usr/local/bin/fish` (or `/opt/homebrew/bin/fish`)
- **Steps**: Recruit a new session
- **Expected**: `.command` script detects fish and re-execs into `fish -c` for proper environment
- **Verify**: MCP server connects, node is on PATH

### TA-4: .command file cleanup
- **Steps**: Recruit a session, note the timestamp
- **Expected**: A `.command` file exists in `$TMPDIR` named `agent-tempo-recruit-<timestamp>.command`
- **Note**: These are not auto-cleaned; consider periodic cleanup in future

---

## Terminal Detection

### TD-1: TERM_PROGRAM takes priority
- **Setup**: `TERM_PROGRAM=ghostty` in environment, iTerm2 also running
- **Steps**: Recruit a new session
- **Expected**: Ghostty path is used (not iTerm2)
- **Verify**: Check MCP server logs for "Using Ghostty initial-input path"

### TD-2: Frontmost app fallback when TERM_PROGRAM missing
- **Setup**: Unset `TERM_PROGRAM` in MCP server env, Ghostty is frontmost app
- **Steps**: Recruit a new session
- **Expected**: AppleScript detects Ghostty as frontmost app, uses Ghostty path
- **Verify**: Check MCP server logs

### TD-3: pgrep fallback
- **Setup**: `TERM_PROGRAM` unset, AppleScript frontmost detection returns a non-terminal app (e.g., Finder is focused)
- **Steps**: Recruit a new session
- **Expected**: Falls back to pgrep, finds the correct terminal
- **Verify**: Check MCP server logs

### TD-4: No terminal detected defaults to Terminal.app
- **Setup**: Neither Ghostty nor iTerm2 installed/running
- **Steps**: Recruit a new session
- **Expected**: Falls through to Terminal.app `.command` file path
- **Verify**: Terminal.app opens

---

## Claude Binary Resolution

### CB-1: claude on PATH via node manager
- **Setup**: `claude` installed in `~/.local/bin/` or via npm global
- **Steps**: Recruit a new session
- **Expected**: `resolveClaudePath()` returns the absolute path, used in spawn command

### CB-2: claude not on MCP server PATH
- **Setup**: `claude` is only on the user's shell PATH (via fnm), not in the MCP server's PATH
- **Steps**: Recruit a new session
- **Expected**: `resolveClaudePath()` falls back to bare `claude`, but the `initial input` approach runs in the user's shell where `claude` is on PATH
- **Verify**: Session starts successfully despite MCP server not finding claude

---

## Error Handling

### EH-1: Duplicate name rejected
- **Steps**: Recruit "Alice", then recruit "Alice" again
- **Expected**: Second recruit returns error: "Session Alice is already active"

### EH-2: Invalid name rejected
- **Steps**: `recruit({ name: "bad name!", workDir: "/tmp" })`
- **Expected**: Returns error about invalid characters

### EH-3: Session spawned but slow to register
- **Steps**: Recruit with a very slow workDir (e.g., network mount)
- **Expected**: Returns "spawned but did not register within 15 seconds" message
- **Verify**: Session eventually appears in `ensemble`

### EH-4: Initial message delivered after registration
- **Steps**: Recruit with an `initialMessage`
- **Expected**: After the session registers, it receives the name instruction AND the initial message
- **Verify**: New session calls `set_name` and then acts on the initial message

---

## Cross-Platform (if applicable)

### WIN-1: Windows recruit opens cmd.exe window
- **Setup**: Windows with Claude Code installed
- **Steps**: Call `recruit`
- **Expected**: New cmd.exe window opens with `claude` running, env vars set via process env

### LIN-1: Linux with gnome-terminal
- **Setup**: GNOME desktop with gnome-terminal
- **Steps**: Call `recruit`
- **Expected**: New gnome-terminal window opens with `claude` running

### LIN-2: Linux headless fallback
- **Setup**: No GUI terminal emulator available
- **Steps**: Call `recruit`
- **Expected**: Falls back to headless `bash -c` spawn, logs warning
- **Verify**: Session registers in ensemble (no visible window)

---

## Regression Checks

### RG-1: Ghostty `command` property is NOT used
- **Verify**: The Ghostty AppleScript uses `initial input`, not `set command of cfg`
- **Why**: `command` bypasses shell init, breaking node managers

### RG-2: No `export` syntax in Ghostty/iTerm2 paths
- **Verify**: The command typed into the shell uses inline `KEY=val` syntax, not `export KEY=val`
- **Why**: `export` is not valid fish syntax

### RG-3: Shell quoting handles single quotes in paths
- **Steps**: Create dir `/tmp/it's-a-test`, recruit into it
- **Expected**: shellQuote escapes the apostrophe correctly
- **Cleanup**: Remove the directory
