/**
 * Singleton {@link DashboardTempoClient} accessor — shared by every
 * hook in `lib/queries.ts` and `lib/sse.ts`.
 *
 * Production: `getDashboardClient()` lazily builds one client at first
 * call and reuses it forever. The client itself is stateless beyond
 * the bearer-from-localStorage read inside `authHeaders`, so a single
 * instance is correct.
 *
 * Tests: `__setDashboardClientForTests(mock)` replaces the singleton;
 * `__setDashboardClientForTests(null)` restores the production default.
 * The `__` prefix marks this as a test escape hatch (ADR 0006). One
 * setter, one `cachedClient` — tests don't have to remember to reset
 * two parallel modules like the previous draft required.
 */
import { createDashboardClient, type DashboardTempoClient } from './client';

let cachedClient: DashboardTempoClient | null = null;

export function getDashboardClient(): DashboardTempoClient {
  if (!cachedClient) cachedClient = createDashboardClient();
  return cachedClient;
}

/** Test-only — override the cached singleton. Pass `null` to restore. */
export function __setDashboardClientForTests(client: DashboardTempoClient | null): void {
  cachedClient = client;
}
