/**
 * Filesystem-walk probe for an installed npm package.
 *
 * Walks `node_modules` directories upward from `__dirname` looking for a
 * package's `package.json`. Returns whether the package is installed.
 *
 * **Why not `require.resolve(pkgName)` or `require.resolve(pkgName + '/package.json')`?**
 * Some packages publish with strict ESM `exports` maps that have no
 * `"require"` key and no `"./package.json"` sub-path entry — e.g.
 * `@opencode-ai/sdk`. CJS-side resolution then trips
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` even when the package is correctly
 * installed. The filesystem walk bypasses Node's exports-map gate
 * cleanly. The Copilot SDK works with `require('<pkg>/package.json')`
 * (`src/daemon-adapter-versions.ts:175`) because it doesn't have that
 * restriction; this helper is for packages that do.
 *
 * Used by:
 *   - `src/adapters/opencode/adapter.ts` — module-load optional-dep gate
 *   - `src/tools/recruit.ts` — recruit pre-flight check
 *   - `src/pi/probe.ts` — Pi / Copilot-via-Pi pre-flight (presence + version floor)
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Locate an installed package's `package.json` by walking `node_modules`
 * directories upward from `fromDir`. The single source of truth for the
 * filesystem walk — {@link probeSdkInstall} (presence) and
 * {@link readSdkPackageVersion} (version) both build on it.
 *
 * @param pkgName Bare specifier (e.g. `'@opencode-ai/sdk'`).
 * @param fromDir Where to start the walk. Defaults to the caller's
 *   `__dirname`-equivalent — pass an explicit value to anchor elsewhere.
 * @returns The absolute path to `<dir>/node_modules/<pkgName>/package.json`
 *   for the first match up the filesystem, or `null` if none is found.
 */
export function findSdkPackageJson(pkgName: string, fromDir: string = __dirname): string | null {
  let dir = fromDir;
  while (true) {
    const candidate = join(dir, 'node_modules', pkgName, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * @param pkgName Bare specifier (e.g. `'@opencode-ai/sdk'`).
 * @param fromDir Where to start the walk. Defaults to the caller's
 *   `__dirname`-equivalent — pass an explicit value if you need to anchor
 *   the search elsewhere.
 * @returns `true` if `<dir>/node_modules/<pkgName>/package.json` exists
 *   anywhere on the walk up the filesystem.
 */
export function probeSdkInstall(pkgName: string, fromDir: string = __dirname): boolean {
  return findSdkPackageJson(pkgName, fromDir) !== null;
}

/**
 * Read an installed package's `package.json#version` via the same filesystem
 * walk as {@link probeSdkInstall}. Returns `null` when the package isn't
 * installed, its `package.json` is unreadable, or its `version` field is
 * absent/non-string — callers treat `null` as "version unknown".
 *
 * @param pkgName Bare specifier (e.g. `'@earendil-works/pi-coding-agent'`).
 * @param fromDir Walk start (defaults to this module's `__dirname`).
 */
export function readSdkPackageVersion(pkgName: string, fromDir: string = __dirname): string | null {
  const pkgPath = findSdkPackageJson(pkgName, fromDir);
  if (!pkgPath) return null;
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}
