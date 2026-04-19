/**
 * Per-adapter conformance suite (§4.5 of the v0.25 design doc).
 *
 * This file is the shared contract every shipped adapter must satisfy. It is
 * parameterized over every descriptor registered with `src/adapters/index.ts`'s
 * singleton registry — adding a new adapter is automatic coverage here.
 *
 * **PR-G scaffolding (step 7/7 of the v0.25 rebuild ladder).** Most cases are
 * stubbed via `it.skip()` because they depend on adapter-surface work that lands
 * in PR-C (claim/heartbeat/detach wiring), PR-D (new verbs), or PR-E (daemon
 * reconcile). Each stub carries a clear `// TODO (PR-X): ...` comment naming the
 * enabling PR. When those PRs land, the engineer on duty un-skips the stub,
 * fills in the arrange/act/assert, and runs against every registered descriptor.
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §4.5.
 * Sequencing memo: §3 PR-G.
 *
 * Cross-reference with PR-A coverage: the `test/session-phase-{claim,processing,detach}.test.ts`
 * trio and `test/session-lease.test.ts` cover the workflow-side primitives directly
 * (claimAttachment, heartbeat, forceDetach, processingStart/End, destroy). The
 * conformance suite below exercises the same primitives from the ADAPTER side —
 * "does adapter X actually CALL claimAttachment when it attaches, and does its
 * heartbeat loop run on the descriptor's cadence?" — which is only meaningful
 * once PR-C removes the compat shim and adapters speak the attachment wire
 * protocol directly.
 */
import { registry } from '../../src/adapters';
import type { AdapterDescriptor } from '../../src/types';

/** Descriptors to run the conformance suite against. Sourced from the registry. */
const descriptors: readonly AdapterDescriptor[] = registry.all();

describe('adapter conformance suite (§4.5)', function () {
  if (descriptors.length === 0) {
    it('has at least one adapter registered', function () {
      throw new Error(
        'No adapter descriptors registered with the singleton registry. ' +
        'Import `src/adapters` should auto-register claude-code and copilot at module load.',
      );
    });
    return;
  }

  for (const descriptor of descriptors) {
    describe(`adapter: ${descriptor.adapterId} (class: ${descriptor.adapterClass})`, function () {
      // ── Case 1: Spawn ─────────────────────────────────────────────────
      // §4.5: "Adapter's spawn routine returns a handle whose child process
      //        reports `isAgentAlive() === true` within 5 s."
      it.skip('spawn — adapter child process reports isAgentAlive within 5s', async function () {
        // TODO (PR-C): requires BaseAttachment full spawn lifecycle + AttachmentContext.
        // Today adapters are spawned via src/spawn.ts (interactive) or entry-point
        // invocation (SDK); there is no BaseAttachment.spawn() yet. Un-skip when
        // PR-C lands the factory/spawn path.
      });

      // ── Case 2: Attach ────────────────────────────────────────────────
      // §4.5: "Adapter calls `claimAttachment`, workflow phase transitions to `attached`."
      it.skip('attach — adapter calls claimAttachment, phase transitions to attached', async function () {
        // TODO (PR-C): today the PR-A compat shim synthesizes a claim from the legacy
        // `updateMetadata({ status: 'active' })` signal. Adapters do not call
        // claimAttachment directly yet. Un-skip when PR-C rewires adapters to speak
        // the attachment wire protocol.
        //
        // Workflow-side claimAttachment → attached transition is already covered by
        // `test/session-phase-claim.test.ts` (search for title "booting -> attached via
        // claimAttachment"). This case adds the adapter-side contract assertion on top
        // of the workflow test. (Line-number reference dropped in the #233 split — the
        // title is the stable handle.)
      });

      // ── Case 3: Heartbeat ─────────────────────────────────────────────
      // §4.5: "Over 2 heartbeat intervals, `lastHeartbeatAt` advances; lease is not expired."
      it.skip('heartbeat — lastHeartbeatAt advances over 2× descriptor.heartbeatMs', async function () {
        // TODO (PR-C): requires BaseAttachment heartbeat loop. Today adapters do not
        // emit heartbeat signals on their own cadence. Un-skip when PR-C's heartbeat
        // loop runs on descriptor.heartbeatMs.
        //
        // Signal-side heartbeat handling is covered by the wire-protocol test and by
        // PR-A's `test/session-phase-claim.test.ts` (which sends heartbeats manually).
      });

      // ── Case 4: Receive message (push or pull) ────────────────────────
      // §4.5: "Workflow signals `receiveMessage`; adapter delivers; `reportDelivered` is
      //        called; for sdk adapters `processingStart` and `processingEnd` are paired
      //        with the correct `messageId`."
      it.skip('receive — adapter delivers inbound messages and reports delivery', async function () {
        // TODO (PR-C): requires BaseAttachment deliver() + SdkAttachment processingStart/End
        // wrapping. For push (interactive): assert MCP notification fires. For pull (sdk):
        // assert sendAndWait is called AND processingStart/End are paired with the batch's
        // messageId. Un-skip when PR-C centralizes the wrapping.
      });

      // ── Case 5: Detach graceful ───────────────────────────────────────
      // §4.5: "Workflow signals `requestDetach`; adapter runs `drain` → `shutdown` →
      //        `signalAdapterExited` within the drain deadline."
      it.skip('detach graceful — requestDetach → drain → shutdown → adapterExited', async function () {
        // TODO (PR-C): requires BaseAttachment.drain() + shutdown() + adapterExited
        // signal emission. Un-skip when PR-C implements the graceful-detach contract.
      });

      // ── Case 6: Detach forced ─────────────────────────────────────────
      // §4.5: "Workflow executes `forceDetach` update; adapter's `onLeaseRevoked` listener
      //        fires; adapter exits."
      it.skip('detach forced — forceDetach update triggers onLeaseRevoked, adapter exits', async function () {
        // TODO (PR-C): requires BaseAttachment lease-revoked poller + onLeaseRevoked hook.
        // Workflow-side forceDetach transaction is covered by PR-A; this case adds the
        // adapter reaction.
      });

      // ── Case 7: Re-attach ─────────────────────────────────────────────
      // §4.5: "After detach, a fresh adapter instance claims the attachment successfully
      //        and resumes delivery."
      it.skip('re-attach — fresh adapter instance claims + resumes after detach', async function () {
        // TODO (PR-D): requires the `restart` verb (or equivalent) to spawn a fresh adapter
        // process against an existing workflow. Cross-host variant is PR-F.
      });

      // ── Case 8: Crash recovery ────────────────────────────────────────
      // §4.5: "Adapter process is SIGKILL'd mid-delivery; after heartbeat timeout, workflow
      //        is in `detached`; a fresh adapter can claim."
      it.skip('crash recovery — SIGKILL adapter → heartbeat timeout → detached → fresh claim', async function () {
        // TODO (PR-C + PR-E): requires (a) PR-C heartbeat-timeout lease reap producing
        // `detached` phase, and (b) PR-E daemon reconcile-on-boot for the real-world
        // crash recovery flow. The workflow-side lease-expiry reap is covered by PR-A's
        // §9.5.a tests (though noted as fragile in the test harness).
      });

      // ── Case 9: WorkflowNotFound ──────────────────────────────────────
      // §4.5: "Destroy the workflow out-of-band; adapter's operations throw
      //        `WorkflowNotFoundError`; adapter exits cleanly without creating a new workflow."
      it.skip('WorkflowNotFound — destroyed workflow → adapter operations throw → clean exit', async function () {
        // TODO (PR-C): requires BaseAttachment WorkflowNotFound catch + shutdown path.
        // Today the copilot bridge has inline handling for this (src/adapters/copilot/
        // adapter.ts `recreateSession`); PR-C centralizes it in BaseAttachment per §9.4.
      });
    });
  }
});
