import { execSync } from 'child_process';

export function getGitInfo(workDir: string): { gitRoot?: string; gitBranch?: string } {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd: workDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    let gitBranch: string | undefined;
    try {
      gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: workDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // not on a branch
    }
    return { gitRoot, gitBranch };
  } catch {
    return {};
  }
}
