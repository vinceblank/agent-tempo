/**
 * Mock adapter barrel — re-exports the subset of the mock module the registry
 * + recruit + tests need to import directly. The class itself lives in
 * `adapter.ts`; keeping the descriptor in `descriptor.ts` lets `index.ts`
 * (and the dynamic import gate in `src/adapters/index.ts`) reference the
 * descriptor without dragging in the subprocess-only `run()` machinery.
 *
 * **Production safety**: this file is included in the compiled tarball, but
 * `src/adapters/index.ts` only imports it inside an `if (isDevMode())` block
 * (gate 2 of ADR 0014 §7's defense-in-depth). The npm `prepack` script also
 * strips `dist/adapters/mock/` from the published tarball (gate 1). Either
 * gate alone is sufficient — together they're combinatorically unlikely to
 * fail.
 */
export { MockAttachment, MOCK_ENV, type MockMode, resolveScenarioPath } from './adapter';
export { mockDescriptor } from './descriptor';
export {
  parseScenario,
  matchRule,
  resolveTarget,
  expandTemplate,
  TARGET_SENDER,
  TARGET_CONDUCTOR,
  MAX_SCENARIO_BYTES,
  MAX_DELAY_MS,
  MAX_ACTIONS_PER_RULE,
  DEFAULT_DELAY_MS,
  type Scenario,
  type ScenarioAction,
  type ScenarioRule,
} from './scenario';
export { parsePrefixDirectives, PREFIX } from './prefix';
