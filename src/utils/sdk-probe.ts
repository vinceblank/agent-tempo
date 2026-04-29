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
 */
import { existsSync } from 'fs';
import { dirname, join } from 'path';

/**
 * @param pkgName Bare specifier (e.g. `'@opencode-ai/sdk'`).
 * @param fromDir Where to start the walk. Defaults to the caller's
 *   `__dirname`-equivalent — pass an explicit value if you need to anchor
 *   the search elsewhere.
 * @returns `true` if `<dir>/node_modules/<pkgName>/package.json` exists
 *   anywhere on the walk up the filesystem.
 */
export function probeSdkInstall(pkgName: string, fromDir: string = __dirname): boolean {
  let dir = fromDir;
  while (true) {
    const candidate = join(dir, 'node_modules', pkgName, 'package.json');
    if (existsSync(candidate)) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}
