/**
 * Lazy resolution proxy (D11 — Phase 2).
 *
 * The Pi extension registers the FULL tool surface ONCE at extension load (Pi
 * tools are registered up-front, not per session), yet each tool's neutral
 * handler needs the player's live Temporal `Client` and session `WorkflowHandle`
 * — which only exist AFTER the extension connects and claims a session workflow
 * on `session_start`, and which are RE-ACQUIRED on a SessionManager switch
 * (newSession / continueSession / fork) without caching across the switch.
 *
 * `createLazyProxy` bridges that gap: it returns an object that forwards every
 * property access and method call to a target resolved FRESH per access via the
 * `resolve` callback. So `buildAllTempoTools(opts)` can be built once at load
 * with proxy `client` / `handle`, and each handler — invoked only during a live
 * session — transparently hits the CURRENT client/handle.
 *
 * Additive to Phase 1: the proxy IS a `Client` / `WorkflowHandle` structurally,
 * so the descriptor contract (`build*Tool(...)`) and the MCP renderer are
 * unchanged — MCP passes a concrete handle, Pi passes a lazily-resolved one.
 *
 * Determinism note: client-side only (src/pi).
 */

/**
 * Wrap a lazily-resolved target behind a transparent proxy.
 *
 * @param resolve Returns the current target, or `null`/`undefined` when none is
 *                active yet (e.g. before the first session attaches).
 * @param label   Human-readable name used in the "unavailable" error.
 *
 * Every property read resolves the target first:
 *   - methods are returned bound to the live target,
 *   - non-function properties (e.g. `client.workflow`) are returned as-is from
 *     the live target,
 *   - if no target is active, access throws a clear error (the calling tool
 *     handler catches it and returns a `fail(...)` result).
 */
export function createLazyProxy<T extends object>(
  resolve: () => T | null | undefined,
  label: string,
): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const live = resolve();
      if (!live) {
        throw new Error(`Pi: ${label} unavailable — no active session is attached`);
      }
      const value = (live as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(live) : value;
    },
    has(_target, prop) {
      const live = resolve();
      return live ? prop in (live as object) : false;
    },
  });
}
