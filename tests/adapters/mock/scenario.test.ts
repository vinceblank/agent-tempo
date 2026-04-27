/**
 * Unit tests for the mock-adapter scenario parser, matcher, and helpers
 * (ADR 0014 §4.3). Pure module — no Temporal, no fs.
 */
import { describe, expect, it } from 'vitest';
import {
  parseScenario,
  matchRule,
  resolveTarget,
  expandTemplate,
  TARGET_SENDER,
  TARGET_CONDUCTOR,
  MAX_DELAY_MS,
  MAX_ACTIONS_PER_RULE,
  MAX_SCENARIO_BYTES,
} from '../../../src/adapters/mock/scenario';

const VALID_MIN = `
name: t
rules:
  - when: "*"
    do:
      - cue: { to: "@sender", message: "hi" }
`;

describe('parseScenario', () => {
  it('accepts a minimal valid scenario', () => {
    const s = parseScenario(VALID_MIN);
    expect(s.name).toBe('t');
    expect(s.rules).toHaveLength(1);
    expect(s.rules[0].when).toBe('*');
  });

  it('parses every action shape', () => {
    const yaml = `
name: all-actions
rules:
  - when: "*"
    do:
      - cue: { to: "@sender", message: "x" }
      - report: { type: "result", text: "done" }
      - recruit: { name: alice, workDir: "/tmp", agent: mock }
      - release: { target: "@conductor" }
      - delayMs: 500
      - crash: { message: "boom" }
`;
    const s = parseScenario(yaml);
    expect(s.rules[0].do).toHaveLength(6);
  });

  it('rejects YAML that fails to parse', () => {
    expect(() => parseScenario('name: t\nrules: [')).toThrow(/YAML failed to parse/);
  });

  it('rejects an action with no recognized verb', () => {
    const yaml = `
name: t
rules:
  - when: "*"
    do:
      - foo: { bar: 1 }
`;
    expect(() => parseScenario(yaml)).toThrow(/Scenario validation failed/);
  });

  it('rejects an empty rules list', () => {
    expect(() => parseScenario(`name: t\nrules: []`)).toThrow(/Scenario validation failed/);
  });

  it(`rejects more than ${MAX_ACTIONS_PER_RULE} actions per rule`, () => {
    const actions = Array(MAX_ACTIONS_PER_RULE + 1)
      .fill(0)
      .map(() => `      - delayMs: 100`)
      .join('\n');
    const yaml = `
name: t
rules:
  - when: "*"
    do:
${actions}
`;
    expect(() => parseScenario(yaml)).toThrow(/Scenario validation failed/);
  });

  it(`rejects delayMs above ${MAX_DELAY_MS}`, () => {
    const yaml = `
name: t
rules:
  - when: "*"
    do:
      - delayMs: ${MAX_DELAY_MS + 1}
`;
    expect(() => parseScenario(yaml)).toThrow(/Scenario validation failed/);
  });

  it(`rejects scenarios above ${MAX_SCENARIO_BYTES} bytes`, () => {
    const huge = 'x'.repeat(MAX_SCENARIO_BYTES + 1);
    expect(() => parseScenario(huge)).toThrow(/exceeds .* bytes/);
  });

  it('rejects an invalid cue target (not @sender, not @conductor, not a name)', () => {
    const yaml = `
name: t
rules:
  - when: "*"
    do:
      - cue: { to: "has spaces!", message: "x" }
`;
    expect(() => parseScenario(yaml)).toThrow(/Scenario validation failed/);
  });

  it('rejects an invalid report.type', () => {
    const yaml = `
name: t
rules:
  - when: "*"
    do:
      - report: { type: "fancy", text: "x" }
`;
    expect(() => parseScenario(yaml)).toThrow(/Scenario validation failed/);
  });
});

describe('matchRule', () => {
  const scenario = parseScenario(`
name: t
rules:
  - when: "discuss"
    do: [ { cue: { to: "@sender", message: "ok" } } ]
  - when: "ROARING"
    do: [ { cue: { to: "@sender", message: "ok" } } ]
  - when: "*"
    do: [ { cue: { to: "@sender", message: "default" } } ]
`);

  it('matches case-insensitive substring', () => {
    expect(matchRule(scenario, 'Please discuss the API')).toBe(scenario.rules[0]);
    expect(matchRule(scenario, 'i AM ROaring')).toBe(scenario.rules[1]);
  });

  it('falls through to the catch-all', () => {
    expect(matchRule(scenario, 'unrelated message')).toBe(scenario.rules[2]);
  });

  it('returns null when there is no match and no catch-all', () => {
    const noWildcard = parseScenario(`
name: t
rules:
  - when: "specific-trigger"
    do: [ { cue: { to: "@sender", message: "ok" } } ]
`);
    expect(matchRule(noWildcard, 'completely unrelated body')).toBeNull();
  });

  it('returns the FIRST matching rule (order matters)', () => {
    // Both rules contain "the" — the first one should win.
    const ordered = parseScenario(`
name: t
rules:
  - when: "the"
    do: [ { cue: { to: "@sender", message: "first" } } ]
  - when: "the"
    do: [ { cue: { to: "@sender", message: "second" } } ]
`);
    expect(matchRule(ordered, 'the answer')).toBe(ordered.rules[0]);
  });
});

describe('resolveTarget', () => {
  it('rewrites @sender to the inbound sender', () => {
    expect(resolveTarget(TARGET_SENDER, 'alice')).toBe('alice');
  });

  it('passes @conductor through unchanged (dispatcher resolves)', () => {
    expect(resolveTarget(TARGET_CONDUCTOR, 'alice')).toBe(TARGET_CONDUCTOR);
  });

  it('passes plain names through unchanged', () => {
    expect(resolveTarget('bob', 'alice')).toBe('bob');
  });
});

describe('expandTemplate', () => {
  it('substitutes $message', () => {
    expect(expandTemplate('echo: $message', 'hello')).toBe('echo: hello');
  });

  it('replaces every occurrence', () => {
    expect(expandTemplate('$message and $message', 'x')).toBe('x and x');
  });

  it('leaves text without $message untouched', () => {
    expect(expandTemplate('static reply', 'whatever')).toBe('static reply');
  });
});
