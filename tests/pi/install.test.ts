/**
 * Unit tests for the Pi extension install helper (#700 P1, src/pi/install.ts).
 *
 * Locks the load-bearing invariants from the design (§8) + the conductor's
 * must-fix:
 *   - INSTALL-BY-REFERENCE, never a loose copy — the only file written is
 *     settings.json; no extension `.js` is ever copied into ~/.pi/agent/extensions/.
 *   - IDEMPOTENT — re-running adds nothing and produces no duplicates.
 *   - MUST-FIX 1 — both paths resolve DIRECTLY from __dirname (co-located
 *     `pi/extension.js` + `pi/mission-control/extension.js`), NOT `../…`
 *     (which would yield a doubled / wrong dir).
 *   - Preserves existing settings keys + existing extension entries.
 *   - Project scope writes `.pi/settings.json` under cwd.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  installPiExtensions,
  isAgentTempoExtensionPath,
  piExtensionPaths,
  piSettingsPath,
} from '../../src/pi/install';

describe('pi install (#700 P1)', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-pi-install-home-'));
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-pi-install-cwd-'));
  });
  afterEach(() => {
    for (const d of [tmpHome, tmpCwd]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('★ MUST-FIX 1: paths resolve co-located off __dirname (pi/…, never doubled)', () => {
    const { player, missionControl } = piExtensionPaths();
    // The bug would be `resolve(__dirname,'..',…)` → a path NOT ending in
    // `pi/extension.js`. Lock the exact co-located suffixes.
    expect(player.endsWith(path.join('pi', 'extension.js'))).toBe(true);
    expect(missionControl.endsWith(path.join('pi', 'mission-control', 'extension.js'))).toBe(true);
    expect(path.isAbsolute(player)).toBe(true);
    expect(path.isAbsolute(missionControl)).toBe(true);
    // No doubled segment like dist/dist or pi/pi.
    expect(player).not.toContain(`${path.sep}dist${path.sep}dist${path.sep}`);
    expect(missionControl).not.toContain(`${path.sep}pi${path.sep}pi${path.sep}`);
  });

  it('fresh install creates settings.json referencing both extension paths', () => {
    const result = installPiExtensions({ home: tmpHome });
    const expectedPath = path.join(tmpHome, '.pi', 'agent', 'settings.json');
    expect(result.settingsPath).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);

    const { player, missionControl } = piExtensionPaths();
    expect(result.added).toEqual([player, missionControl]);
    expect(result.extensions).toEqual([player, missionControl]);

    const written = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
    expect(written.extensions).toEqual([player, missionControl]);
  });

  it('is IDEMPOTENT — a second run adds nothing and never duplicates', () => {
    installPiExtensions({ home: tmpHome });
    const second = installPiExtensions({ home: tmpHome });
    expect(second.added).toEqual([]);
    expect(second.alreadyPresent.length).toBe(2);
    expect(second.removed).toEqual([]); // #52 — nothing stale to prune
    expect(second.extensions.length).toBe(2); // no duplicates
  });

  it('★ #52 UPGRADE: prunes stale version-hashed agent-tempo paths; user extensions preserved', () => {
    const settingsPath = path.join(tmpHome, '.pi', 'agent', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    // A prior pnpm-global install whose version-hashed dir is now stale, plus an
    // unrelated user extension. (Real-world #52 bug: the add-only install left
    // BOTH the stale + new paths, and `pi` then failed on the missing stale one.)
    const stalePlayer =
      '/home/u/.local/share/pnpm/global/5/.pnpm/agent-tempo@1.7.0-beta.5_abc123/node_modules/agent-tempo/dist/pi/extension.js';
    const staleMc =
      '/home/u/.local/share/pnpm/global/5/.pnpm/agent-tempo@1.7.0-beta.5_abc123/node_modules/agent-tempo/dist/pi/mission-control/extension.js';
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ theme: 'dark', extensions: ['/user/ext.js', stalePlayer, staleMc] }, null, 2),
    );

    const result = installPiExtensions({ home: tmpHome });
    const { player, missionControl } = piExtensionPaths();

    expect(result.removed).toEqual([stalePlayer, staleMc]); // both stale entries pruned
    expect(result.added).toEqual([player, missionControl]); // current paths added
    // User extension kept in place; no stale entries remain; no duplicates.
    expect(result.extensions).toEqual(['/user/ext.js', player, missionControl]);
    expect(result.extensions).not.toContain(stalePlayer);
    expect(result.extensions).not.toContain(staleMc);

    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(written.theme).toBe('dark'); // unrelated key untouched
    expect(written.extensions).toEqual(['/user/ext.js', player, missionControl]);
  });

  it('★ #52 prune is SCOPED — never removes a user extension that merely ends in extension.js', () => {
    const settingsPath = path.join(tmpHome, '.pi', 'agent', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const userExtensionJs = '/home/u/my-tools/dist/pi/extension.js'; // no agent-tempo marker
    fs.writeFileSync(settingsPath, JSON.stringify({ extensions: [userExtensionJs] }, null, 2));

    const result = installPiExtensions({ home: tmpHome });
    expect(result.removed).toEqual([]); // not an agent-tempo path → untouched
    expect(result.extensions).toContain(userExtensionJs);
  });

  it('★ NO LOOSE COPY — only settings.json is written; no extension .js is copied', () => {
    installPiExtensions({ home: tmpHome });
    const agentDir = path.join(tmpHome, '.pi', 'agent');
    const entries = fs.readdirSync(agentDir);
    expect(entries).toEqual(['settings.json']);
    // The notorious wrong path: a loose copy into an extensions/ dir.
    expect(fs.existsSync(path.join(agentDir, 'extensions'))).toBe(false);
    // The settings reference the install-tree paths, not a copy under tmpHome.
    const { player } = piExtensionPaths();
    const written = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    expect(written.extensions).toContain(player);
    expect(player.startsWith(tmpHome)).toBe(false); // referenced in place, not copied into home
  });

  it('preserves existing settings keys and existing extension entries', () => {
    const settingsPath = path.join(tmpHome, '.pi', 'agent', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ theme: 'dark', extensions: ['/some/user/ext.js'] }, null, 2),
    );

    const result = installPiExtensions({ home: tmpHome });
    const { player, missionControl } = piExtensionPaths();
    expect(result.extensions).toEqual(['/some/user/ext.js', player, missionControl]);

    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(written.theme).toBe('dark'); // unrelated key untouched
    expect(written.extensions).toContain('/some/user/ext.js');
  });

  it('project scope writes .pi/settings.json under cwd', () => {
    const result = installPiExtensions({ project: true, cwd: tmpCwd });
    expect(result.settingsPath).toBe(path.join(tmpCwd, '.pi', 'settings.json'));
    expect(fs.existsSync(result.settingsPath)).toBe(true);
    // Global location untouched.
    expect(fs.existsSync(path.join(tmpHome, '.pi', 'agent', 'settings.json'))).toBe(false);
  });

  it('piSettingsPath resolves global vs project scope', () => {
    expect(piSettingsPath({ home: tmpHome })).toBe(path.join(tmpHome, '.pi', 'agent', 'settings.json'));
    expect(piSettingsPath({ project: true, cwd: tmpCwd })).toBe(path.join(tmpCwd, '.pi', 'settings.json'));
  });
});

describe('isAgentTempoExtensionPath (#52)', () => {
  it('matches pnpm version-hashed + node_modules agent-tempo extension paths (both entry points)', () => {
    expect(isAgentTempoExtensionPath('/x/.pnpm/agent-tempo@1.7.0_h/node_modules/agent-tempo/dist/pi/extension.js')).toBe(true);
    expect(isAgentTempoExtensionPath('/x/.pnpm/agent-tempo@1.7.0_h/node_modules/agent-tempo/dist/pi/mission-control/extension.js')).toBe(true);
    expect(isAgentTempoExtensionPath('/usr/lib/node_modules/agent-tempo/dist/pi/extension.js')).toBe(true);
    expect(isAgentTempoExtensionPath('/usr/lib/node_modules/agent-tempo/dist/pi/mission-control/extension.js')).toBe(true);
  });

  it('normalizes Windows separators', () => {
    expect(isAgentTempoExtensionPath('C:\\Users\\u\\AppData\\npm\\node_modules\\agent-tempo\\dist\\pi\\extension.js')).toBe(true);
    expect(isAgentTempoExtensionPath('C:\\pnpm\\agent-tempo@1.7.0_h\\node_modules\\agent-tempo\\dist\\pi\\mission-control\\extension.js')).toBe(true);
  });

  it('requires BOTH an agent-tempo marker AND an extension suffix (never prunes unrelated entries)', () => {
    expect(isAgentTempoExtensionPath('/user/my-ext.js')).toBe(false); // neither
    expect(isAgentTempoExtensionPath('/some/other-pkg/dist/pi/extension.js')).toBe(false); // suffix but no agent-tempo marker
    expect(isAgentTempoExtensionPath('/node_modules/agent-tempo/dist/pi/cue-pump.js')).toBe(false); // agent-tempo but not an extension entry
    expect(isAgentTempoExtensionPath('/node_modules/agent-tempo/package.json')).toBe(false);
  });
});
