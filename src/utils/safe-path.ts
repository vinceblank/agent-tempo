import { resolve, normalize } from 'path';

/**
 * Assert that a resolved file path falls within one of the allowed root directories.
 * Throws if the path escapes all allowed roots (path traversal attempt).
 */
export function assertSafePath(filePath: string, allowedRoots: string[]): void {
  const resolved = normalize(resolve(filePath));
  const isAllowed = allowedRoots.some((root) => {
    const normalizedRoot = normalize(resolve(root));
    // Ensure the path starts with root + separator (or is exactly the root)
    return resolved === normalizedRoot || resolved.startsWith(normalizedRoot + getSep(normalizedRoot));
  });
  if (!isAllowed) {
    throw new Error(
      `Path traversal blocked: "${filePath}" resolves to "${resolved}" which is outside allowed roots: ${allowedRoots.join(', ')}`,
    );
  }
}

/**
 * Validate and resolve a lineup file path, ensuring it stays within allowed directories.
 * Allowed roots: ~/.agent-tempo/ensembles/, cwd, and optionally a project dir.
 */
export function safeLineupPath(filePath: string, cwd: string, projectDir?: string): string {
  const { join } = require('path') as typeof import('path');
  const { homedir } = require('os') as typeof import('os');

  const allowedRoots = [
    join(homedir(), '.agent-tempo', 'ensembles'),
    cwd,
  ];
  if (projectDir && projectDir !== cwd) {
    allowedRoots.push(projectDir);
  }

  const resolved = normalize(resolve(filePath));
  assertSafePath(resolved, allowedRoots);
  return resolved;
}

/** Get the path separator used in a given path string. */
function getSep(p: string): string {
  // Use backslash if path contains backslashes (Windows), forward slash otherwise
  return p.includes('\\') ? '\\' : '/';
}
