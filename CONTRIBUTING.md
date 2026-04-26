# Contributing to claude-tempo

Thank you for your interest in contributing to claude-tempo! This guide will help you get started.

## Development Setup

### Prerequisites

- Node.js 20+
- A running [Temporal](https://temporal.io/) dev server

### Getting Started

```bash
# Clone the repository
git clone https://github.com/vinceblank/claude-tempo.git
cd claude-tempo

# Install dependencies
npm install

# Start the Temporal dev server (in a separate terminal)
temporal server start-dev

# Run in development mode
npx ts-node src/server.ts
```

### Building

```bash
npm run build
```

> **Important**: Always run `npm run build` after changing workflow code in `src/workflows/`. The build pre-bundles workflows into `workflow-bundle.js` so all workers use identical code.

### Running Tests

```bash
npm test
```

#### Windows: Defender exclusion (recommended)

The Mocha integration suite spawns a per-process Temporal ephemeral server.
The first run downloads and extracts a ~350 MB binary to
`%TEMP%\temporal-sdk-typescript-<version>.exe`. **Windows Defender's
real-time scan can lock that file for 100 ms – 2 s while it scans the
freshly-extracted executable**, which surfaces as:

```
Failed to start ephemeral server: Access is denied. (os error 5)
```

The test suite ships with a retry layer (`createLocalWithRetry` in
`test/helpers.ts`) that rides out most of these flakes — but the cleaner
fix is to tell Defender not to scan the binary in the first place.

In an **elevated** PowerShell:

```powershell
Add-MpPreference -ExclusionPath "$env:TEMP\temporal-sdk-typescript-1.15.0.exe"
```

Or exclude the broader pattern (any version):

```powershell
Add-MpPreference -ExclusionPath "$env:TEMP\temporal-sdk-typescript*"
```

This is **local-dev only**; CI runs on Linux + Windows and doesn't need it
(GitHub-hosted runners aren't running Defender real-time scans against
your test binaries). Issue #150 has the full diagnosis.

## Making Changes

1. **Fork** the repository and create a feature branch from `main`.
2. **Write tests** alongside your code changes.
3. **Run the full test suite** before submitting: `npm test`
4. **Ensure the project builds** cleanly: `npm run build`
5. **Annotate any `this.skip()` calls** with `// SKIP-REASON: <why>` on the same line or the line above. CI fails on unannotated skips.

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): message
```

**Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

**Examples**:
- `feat(tools): add ensemble discovery tool`
- `fix(workflow): handle signal delivery edge case`
- `docs: update getting started guide`
- `refactor(config): extract env var handling`

## Pull Requests

1. Keep PRs focused — one feature or fix per PR.
2. Include a clear description of **what** changed and **why**.
3. Add a test plan describing how to verify the change.
4. Link any related issues.

## Project Structure

See [CLAUDE.md](./CLAUDE.md) for a detailed overview of the codebase structure, key concepts, and architecture.

## Code Style

- TypeScript strict mode is enabled.
- No additional linter/formatter is configured — follow the patterns in existing code.
- Prefer explicit types over `any`.
- Use the `log` pattern (`const log = (...args: unknown[]) => console.error('[claude-tempo:module]', ...args)`) for debug logging.

## Questions?

Open an issue or start a discussion on the [GitHub repository](https://github.com/vinceblank/claude-tempo).
