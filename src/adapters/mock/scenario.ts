/**
 * Mock-adapter scenario format — Zod schema, YAML parser, rule matcher,
 * and action types (ADR 0014 §4.3).
 *
 * Pure module: no Temporal, fs, or process imports. Safe to import from
 * tests, CLI subcommands, and the adapter subprocess alike.
 *
 * Wire shape (ADR 0014 §4.3):
 *
 *     name: simple-handoff
 *     description: alice receives a task, asks bob, reports done
 *     defaultDelayMs: 1500
 *     rules:
 *       - when: "what's the time"
 *         do:
 *           - cue: { to: "@sender", message: "It's mock-time" }
 *       - when: "*"        # catch-all
 *         do:
 *           - cue: { to: "@sender", message: "echo: $message" }
 *
 * Match strategy: case-insensitive substring on the inbound message body.
 * First matching rule wins; `*` is the catch-all and SHOULD be the last entry.
 */
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { PLAYER_NAME_REGEX } from '../../utils/validation';

/** Hard cap on scenario file size (architect §4.3). Prevents config bombs. */
export const MAX_SCENARIO_BYTES = 64 * 1024;
/** Max actions per rule (architect §4.3). Prevents runaway scenarios. */
export const MAX_ACTIONS_PER_RULE = 20;
/** Max delayMs per `delayMs` action — hard cap so a scenario can't park forever. */
export const MAX_DELAY_MS = 60_000;
/** Default delay between actions when the scenario omits `defaultDelayMs`. */
export const DEFAULT_DELAY_MS = 500;

/** Special target tokens that scenario authors can use in `cue.to`. */
export const TARGET_SENDER = '@sender';
export const TARGET_CONDUCTOR = '@conductor';

// ── Action schemas ──────────────────────────────────────────────────────────

const targetSchema = z.string().refine(
  (v) => v === TARGET_SENDER || v === TARGET_CONDUCTOR || PLAYER_NAME_REGEX.test(v),
  { message: `must be a valid player name, "${TARGET_SENDER}", or "${TARGET_CONDUCTOR}"` },
);

const cueAction = z.object({
  cue: z.object({
    to: targetSchema,
    message: z.string().min(1).max(102_400),
  }),
});

const reportAction = z.object({
  report: z.object({
    type: z.enum(['result', 'blocker', 'question', 'update']),
    text: z.string().min(1).max(102_400),
  }),
});

const recruitAction = z.object({
  recruit: z.object({
    name: z.string().regex(PLAYER_NAME_REGEX),
    workDir: z.string().min(1),
    agent: z.enum(['claude', 'copilot', 'mock']).optional(),
  }),
});

const releaseAction = z.object({
  release: z.object({
    target: targetSchema,
  }),
});

const delayAction = z.object({
  delayMs: z.number().int().positive().max(MAX_DELAY_MS),
});

const crashAction = z.object({
  crash: z.object({
    message: z.string().min(1).max(1024),
  }),
});

/** Discriminated-by-presence — exactly one key on each entry. */
const actionSchema = z.union([
  cueAction,
  reportAction,
  recruitAction,
  releaseAction,
  delayAction,
  crashAction,
]);

const ruleSchema = z.object({
  when: z.string().min(1),
  do: z.array(actionSchema).min(1).max(MAX_ACTIONS_PER_RULE),
});

const scenarioSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(1024).optional(),
  defaultDelayMs: z.number().int().nonnegative().max(MAX_DELAY_MS).optional(),
  rules: z.array(ruleSchema).min(1).max(64),
});

/** Inferred TypeScript types for action consumers (the dispatcher in adapter.ts). */
export type ScenarioAction = z.infer<typeof actionSchema>;
export type ScenarioRule = z.infer<typeof ruleSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;

// ── Parser + matcher ────────────────────────────────────────────────────────

/**
 * Parse + validate a scenario from raw YAML text. Throws with a descriptive
 * message on schema failure — callers should surface the message verbatim so
 * scenario authors can fix their YAML without grep-spelunking.
 */
export function parseScenario(yamlText: string): Scenario {
  if (yamlText.length > MAX_SCENARIO_BYTES) {
    throw new Error(
      `Scenario YAML exceeds ${MAX_SCENARIO_BYTES} bytes (got ${yamlText.length}). ` +
      `If you need a larger fixture, split it into multiple scenarios.`,
    );
  }
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new Error(`Scenario YAML failed to parse: ${(err as Error)?.message ?? err}`);
  }
  const result = scenarioSchema.safeParse(raw);
  if (!result.success) {
    // Fold Zod's tree into a single-line summary so the error fits in a CLI
    // / log line without losing the offending path.
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Scenario validation failed: ${issues}`);
  }
  return result.data;
}

/**
 * Match an inbound message body against a scenario's rules using
 * case-insensitive substring containment. First matching rule wins; `*` is
 * the documented catch-all. Returns `null` if no rule (including `*`) matches.
 */
export function matchRule(scenario: Scenario, inbound: string): ScenarioRule | null {
  const haystack = inbound.toLowerCase();
  for (const rule of scenario.rules) {
    if (rule.when === '*') return rule;
    if (haystack.includes(rule.when.toLowerCase())) return rule;
  }
  return null;
}

/**
 * Resolve a `cue.to` target against the inbound sender. `@sender` becomes
 * `inboundFrom`; `@conductor` is left as a sentinel that the dispatcher swaps
 * for the ensemble's actual conductor playerId at call time. Plain names pass
 * through unchanged.
 */
export function resolveTarget(rawTarget: string, inboundFrom: string): string {
  if (rawTarget === TARGET_SENDER) return inboundFrom;
  return rawTarget;
}

/** `$message` substitution for cue messages (architect §4.3). */
export function expandTemplate(template: string, inboundText: string): string {
  return template.replace(/\$message/g, inboundText);
}
