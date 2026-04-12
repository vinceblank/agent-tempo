/**
 * Re-export TempoClient from src/client/ for backward compatibility.
 * All new consumers should import from '../client' directly.
 */
export { createTempoClient } from '../client';
export type { TempoClient, EnsembleSummary } from '../client';
