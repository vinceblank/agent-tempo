/**
 * Multi-host integration test (PR-F acceptance gate).
 *
 * Exercises cross-host `restart` end-to-end against the docker-compose
 * harness in `test/fixtures/multi-host/`. **Gated on the
 * `INTEGRATION_MULTI_HOST=1` env var** — the default `npm test` run
 * skips this file with `describe.skip` so CI unit-only runs don't depend
 * on Docker.
 *
 * Manual flow (from repo root):
 *
 *   docker-compose -f test/fixtures/multi-host/docker-compose.yml up -d --build
 *   INTEGRATION_MULTI_HOST=1 npx mocha dist-test/test/multi-host-cross-host-restart.test.js
 *   docker-compose -f test/fixtures/multi-host/docker-compose.yml down
 *
 * Scenario:
 *   1. Connect a TempoClient to the shared Temporal dev server.
 *   2. Recruit a session with `host: 'host-a'` — expect it to land on
 *      daemon-a's task queue and `ClaudeTempoAttachedHost=host-a` after boot.
 *   3. Call `restart({ host: 'host-b', force: true,
 *      confirmStealFromHost: 'host-a' })`.
 *   4. Poll `attachmentInfo` until `currentAttachment.hostname === 'host-b'`
 *      or a 60s deadline expires.
 *   5. Verify message history is preserved (length ≥ original).
 *
 * Rejection paths (fast, no spawn required):
 *   - Cross-host force without `confirmStealFromHost` → error from the guard.
 *   - Cross-host force with `confirmStealFromHost: 'wrong-host'` → error.
 *
 * Note: this is a **skeleton**. The full flow requires the docker-compose
 * harness to be up + a path to create sessions on a specific host task
 * queue. The current recruit path runs locally via `spawnInTerminal`,
 * which does not fit inside a headless container. Full integration will
 * need a `recruit --host` plumbing extension or a container-specific
 * entry point — tracked as a follow-up (not blocking PR-F merge).
 */
import { expect } from 'chai';
import { Client, Connection } from '@temporalio/client';
import { createTempoClient } from '../src/client';

const INTEGRATION = process.env.INTEGRATION_MULTI_HOST === '1';
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE || 'default';

// When the env-var gate is off, all cases are skipped with a single
// describe.skip wrapper so CI doesn't try to connect to Temporal.
const describeIf = INTEGRATION ? describe : describe.skip;

describeIf('multi-host cross-host restart (PR-F acceptance gate)', function () {
  this.timeout(120_000);

  let client: Client;
  let connection: Connection;

  before(async function () {
    connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
    client = new Client({ connection, namespace: TEMPORAL_NAMESPACE });
  });

  after(async function () {
    await connection?.close();
  });

  it('skeleton — harness reachable, createTempoClient succeeds', async function () {
    const tempo = createTempoClient(client);
    const ensembles = await tempo.discoverEnsembles();
    // Harness is up if this call returns any structure (may be empty).
    expect(Array.isArray(ensembles)).to.be.true;
  });

  // TODO: expand with the full restart-host-b cross-host path once
  // `recruit --host` has a container-friendly spawn path. For now the
  // unit tests in test/restart-host-routing.test.ts + test/yes-steal-guard.test.ts
  // cover the tool-level correctness; this harness exists so the
  // integration rehearsal is one env-var flip away when container spawn
  // lands.
});
