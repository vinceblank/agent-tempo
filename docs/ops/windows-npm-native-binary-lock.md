# Windows npm global install — native binary lock (EPERM)

## Symptom

```
npm error code EPERM
npm error syscall unlink
npm error path C:\Users\<user>\AppData\Roaming\npm\node_modules\.agent-tempo-XXXXXXXX\node_modules\@temporalio\core-bridge\releases\x86_64-pc-windows-msvc\index.node
npm error errno -4048
```

Occurs when running `npm install -g agent-tempo` (or `npm unlink -g agent-tempo`) on Windows
while a Temporal-using process (daemon, MCP server, or anything loading
`@temporalio/core-bridge`) is running.

## Root Cause

`@temporalio/core-bridge` ships a native `.node` binary (the Rust Temporal core). On
Windows, a loaded native module is memory-mapped by Node.js and cannot be deleted or
renamed while the owning process is alive. npm stages new installs into a temp directory
(`.agent-tempo-XXXXXXXX`) and runs lifecycle scripts as part of the install — one of
those scripts (from `@temporalio/worker` or `@temporalio/core-bridge`) loads the `.node`
file to verify the binary, locking it. When npm subsequently tries to clean up or atomically
replace the staging dir, the unlink fails with `EPERM`.

## Fix — apply in order

1. **Stop the daemon** (releases the worker's hold on the production binary):
   ```
   agent-tempo daemon stop
   ```

2. **Remove the stale temp staging directory** (from any prior failed attempt):
   ```powershell
   Remove-Item -Recurse -Force "C:\Users\<user>\AppData\Roaming\npm\node_modules\.agent-tempo-XXXXXXXX"
   ```
   The suffix is deterministic per-install-attempt; find it in the npm error log.

3. **Remove the existing global junction** (the `npm link` from dev leaves a Junction, not a
   real directory; npm can't atomically replace a Junction cleanly):
   ```powershell
   Remove-Item -Force "C:\Users\<user>\AppData\Roaming\npm\node_modules\agent-tempo"
   ```

4. **Install with `--ignore-scripts`** (skips the lifecycle binary-test that causes the lock):
   ```
   npm install -g agent-tempo@beta --ignore-scripts
   ```
   The `--ignore-scripts` flag skips the post-install smoke-test only — the binary is still
   downloaded and works correctly at runtime; the skipped test is redundant for a stable
   release tarball.

5. **Verify** then **restart the daemon**:
   ```
   agent-tempo --version
   agent-tempo daemon start
   ```

## Why `--ignore-scripts` is safe

The lifecycle script that triggers the lock is `@temporalio/core-bridge`'s post-install
step, which loads the binary to verify it runs on the current platform. For a published
release tarball from the agent-tempo npm registry, the binary was already validated in CI
(Linux/macOS) before publish; the Windows runtime test is redundant. Skipping it has no
effect on the functionality of the installed package.

## History

- First observed: 2026-06-11 (beta.8 install after daemon was running)
- Confirmed reproducible: 2026-06-13 (beta.9 release publish verify)
- Workaround codified: 2026-06-13

## Future mitigation

Consider adding to `release-process.md` and the post-publish checklist:
> On Windows: stop daemon before `npm install -g`, use `--ignore-scripts` if EPERM recurs.

A longer-term fix would be to remove the binary-load from `@temporalio/core-bridge`'s
postinstall lifecycle, but that is upstream of this project.
