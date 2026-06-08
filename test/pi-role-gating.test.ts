/**
 * #729 — role-gated mutual exclusion dormancy matrix (the gate).
 *
 * Both Pi extensions auto-load from settings.json and both register `cue`/`recruit`
 * by name; loading both collides and the command-center never starts. {@link
 * resolvePiRole} makes them mutually exclusive: the PLAYER extension activates only
 * in 'player' role, the MISSION-CONTROL board only in 'command-center', and a bare
 * `pi` ('none') keeps BOTH dormant (the clean-coding-pi guarantee).
 *
 * Pure — fake ExtensionAPIs + the injected client factory; no Temporal, no Pi, no
 * network. The headline regression lock: in the dormant player path the client
 * factory is NEVER called and NO workflow runtime is created (the phantom
 * `pi-${pid}` orphan can't be born).
 */
import { expect } from 'chai';
import type { Client } from '@temporalio/client';
import type { ExtensionAPI } from '../src/pi/pi-types';
import type { McExtensionAPI } from '../src/pi/mission-control/pi-ui';
import {
  createPiExtension,
  __setPiClientFactoryForTests,
  __resetPiRuntimesForTests,
  __getPiRuntimeForTests,
} from '../src/pi/extension';
import { createMissionControlExtension } from '../src/pi/mission-control/extension';
import { ENV, getConfig, sessionWorkflowId } from '../src/config';

// ── Player-extension fake (records the registration surface) ──
interface PlayerFake {
  pi: ExtensionAPI;
  toolCount: () => number;
  onEvents: () => string[];
  commandNames: () => string[];
}
function makePlayerFake(): PlayerFake {
  let tools = 0;
  const ons = new Set<string>();
  const commands = new Set<string>();
  const pi = {
    on: (event: string) => { ons.add(event); },
    registerTool: () => { tools += 1; },
    registerCommand: (name: string) => { commands.add(name); },
    sendMessage: () => { /* no-op */ },
    sendUserMessage: () => { /* no-op */ },
  } as unknown as ExtensionAPI;
  return { pi, toolCount: () => tools, onEvents: () => [...ons], commandNames: () => [...commands] };
}

// ── Mission-control fake (records the registration surface) ──
interface McFake {
  pi: McExtensionAPI;
  toolCount: () => number;
  onEvents: () => string[];
  commandNames: () => string[];
}
function makeMcFake(): McFake {
  let tools = 0;
  const ons = new Set<string>();
  const commands = new Set<string>();
  const pi = {
    on: (event: string) => { ons.add(event); },
    registerCommand: (name: string) => { commands.add(name); },
    registerShortcut: () => { /* no-op */ },
    registerTool: () => { tools += 1; },
  } as unknown as McExtensionAPI;
  return { pi, toolCount: () => tools, onEvents: () => [...ons], commandNames: () => [...commands] };
}

const ROLE_ENV_KEYS = [ENV.PLAYER_NAME, ENV.MISSION_CONTROL, ENV.PI_ROLE] as const;
function clearRoleEnv(): void { for (const k of ROLE_ENV_KEYS) delete process.env[k]; }

describe('#729 player extension — role gate', () => {
  let factoryCalled = false;
  beforeEach(() => {
    clearRoleEnv();
    factoryCalled = false;
    // A factory that flips the flag and returns a never-resolving connection — a
    // DORMANT session must never reach it (the phantom-orphan lock).
    __setPiClientFactoryForTests(async () => {
      factoryCalled = true;
      return {} as unknown as Client;
    });
  });
  afterEach(() => { __resetPiRuntimesForTests(); clearRoleEnv(); });

  it("bare pi (role 'none') → DORMANT: no tools, no client connect, no workflow runtime", () => {
    const f = makePlayerFake();
    createPiExtension({ mode: 'interactive' })(f.pi);
    expect(f.toolCount(), 'no tools registered').to.equal(0);
    expect(f.onEvents(), 'no event handlers registered').to.have.length(0);
    expect(factoryCalled, 'client factory NOT invoked (no connection)').to.equal(false);
    // The phantom orphan would live at sessionWorkflowId(ensemble, `pi-${pid}`).
    const orphanId = sessionWorkflowId(getConfig().ensemble, `pi-${process.pid}`);
    expect(__getPiRuntimeForTests(orphanId), 'no phantom workflow runtime').to.equal(undefined);
  });

  it("command-center seat (MISSION_CONTROL set) → player ext DORMANT", () => {
    process.env[ENV.MISSION_CONTROL] = '1';
    const f = makePlayerFake();
    createPiExtension({ mode: 'interactive' })(f.pi);
    expect(f.toolCount()).to.equal(0);
    expect(factoryCalled).to.equal(false);
  });

  it("player spawn (PLAYER_NAME set) → player ext ACTIVE: tools + handlers + client connect", () => {
    process.env[ENV.PLAYER_NAME] = 'pi-role-active';
    const f = makePlayerFake();
    createPiExtension({ mode: 'interactive' })(f.pi);
    expect(f.toolCount(), 'tools registered').to.be.greaterThan(0);
    expect(f.onEvents(), 'session_start handler registered').to.include('session_start');
    expect(factoryCalled, 'client factory invoked (connection kicked off)').to.equal(true);
  });

  it("headless mode forces 'player' even with NO PLAYER_NAME → ACTIVE", () => {
    // No PLAYER_NAME in env (cleared) — headless must NOT rely on the heuristic.
    const f = makePlayerFake();
    createPiExtension({ mode: 'headless' })(f.pi);
    expect(f.toolCount(), 'tools registered (forced player)').to.be.greaterThan(0);
    expect(factoryCalled, 'client factory invoked (forced player)').to.equal(true);
  });
});

describe('#729 mission-control extension — role gate (deps.role seam)', () => {
  it("role 'command-center' → board ACTIVE: commands + planner tools registered", () => {
    const f = makeMcFake();
    createMissionControlExtension({
      role: 'command-center', ensemble: 'demo', adminToken: 'tok', baseUrl: 'http://127.0.0.1:9',
    })(f.pi);
    expect(f.commandNames(), 'operator commands registered').to.include.members(['players', 'cue', 'recruit']);
    expect(f.toolCount(), 'planner tools registered').to.be.greaterThan(0);
    expect(f.onEvents(), 'session_start handler registered').to.include('session_start');
  });

  it("role 'player' → board DORMANT: no commands, no tools, no handlers", () => {
    const f = makeMcFake();
    createMissionControlExtension({ role: 'player', ensemble: 'demo' })(f.pi);
    expect(f.commandNames()).to.have.length(0);
    expect(f.toolCount()).to.equal(0);
    expect(f.onEvents()).to.have.length(0);
  });

  it("role 'none' (bare pi) → board DORMANT: no commands, no tools, no handlers", () => {
    const f = makeMcFake();
    createMissionControlExtension({ role: 'none', ensemble: 'demo' })(f.pi);
    expect(f.commandNames()).to.have.length(0);
    expect(f.toolCount()).to.equal(0);
    expect(f.onEvents()).to.have.length(0);
  });
});
