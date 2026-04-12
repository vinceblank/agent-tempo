/**
 * Base adapter infrastructure.
 *
 * This is the skeleton landed in PR-B (v0.25 rebuild step 2/7). The full lifecycle
 * contract — heartbeat loop, lease renewal, `claimAttachment`/`forceDetach`/
 * `requestDetach` integration, `WorkflowNotFound` handling, split-brain cancellation
 * — is filled in by PR-C. Adapters in PR-B continue to use the legacy wire surface
 * (`markDelivered`, `updateMetadata({ status })`), which the PR-A compat shim in
 * `src/workflows/session.ts` translates onto the attachment phase machine.
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §§4.1–4.3.
 */
import type { AdapterClass, AdapterDescriptor } from '../types';

/**
 * Abstract base class for session adapters.
 *
 * Currently a structural placeholder — concrete adapters (`InteractiveAttachment`,
 * `CopilotSdkAttachment`) extend this and own their own lifecycle today. PR-C
 * introduces the heartbeat/lease/detach machinery here; until then subclasses run
 * stand-alone.
 */
export abstract class BaseAttachment {
  abstract readonly descriptor: AdapterDescriptor;
}

/**
 * Registry of adapter descriptors keyed by `adapterId`.
 *
 * Look up the descriptor for a given session by `SessionMetadata.adapterId` (or
 * fall back to `'claude-code'` for pre-v0.25 sessions that have no adapterId set).
 * `src/adapters/index.ts` creates the singleton `registry` and registers all
 * shipped adapters at import time.
 */
export class AdapterRegistry {
  private readonly byId = new Map<string, AdapterDescriptor>();

  /** Register an adapter descriptor. Replaces any existing entry with the same id. */
  register(desc: AdapterDescriptor): void {
    this.byId.set(desc.adapterId, desc);
  }

  /**
   * Fetch the descriptor for `adapterId`. Throws if unregistered.
   *
   * Callers resolving from possibly-undefined metadata should coalesce first:
   * `registry.get(metadata.adapterId ?? 'claude-code')`.
   */
  get(adapterId: string): AdapterDescriptor {
    const desc = this.byId.get(adapterId);
    if (!desc) {
      const known = [...this.byId.keys()].join(', ') || '(none registered)';
      throw new Error(`Unknown adapter "${adapterId}". Registered: ${known}`);
    }
    return desc;
  }

  /** `true` if `adapterId` is registered. */
  has(adapterId: string): boolean {
    return this.byId.has(adapterId);
  }

  /** Snapshot of all registered descriptors. */
  all(): readonly AdapterDescriptor[] {
    return [...this.byId.values()];
  }

  /**
   * Resolve an `adapterId` from the legacy `agent` field on {@link SessionMetadata}.
   * Maps `'claude'` → `'claude-code'`, `'copilot'` → `'copilot'`.
   *
   * Used as a fallback when `adapterId` is not yet populated on the session metadata
   * (e.g. sessions started before PR-B landed). PR-D removes this mapping when the
   * legacy `AgentType` enum is retired.
   */
  resolveFromAgentType(agent: string | undefined): string {
    if (agent === 'copilot') return 'copilot';
    return 'claude-code';
  }
}

export type { AdapterClass, AdapterDescriptor };
