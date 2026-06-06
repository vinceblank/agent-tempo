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
    expect(second.extensions.length).toBe(2); // no duplicates
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
