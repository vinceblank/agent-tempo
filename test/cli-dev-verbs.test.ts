/**
 * Mechanical-enforcement test for the dev-mode verbs (#432) boundary.
 *
 * "Live verb" status must be single-sourced. This suite reads source files
 * only and pins four invariants between `DEV_VERBS`, `REMOVED_VERBS`, and
 * the `cli.ts` dispatch:
 *
 *   1. No verb appears in BOTH `DEV_VERBS` and `REMOVED_VERBS`.
 *   2. No `REMOVED_VERBS` key has a matching `case` in the `cli.ts` switch.
 *   3. Every `DEV_VERBS` verb has a matching `case` in `dispatchDevVerb()`.
 *   4. The dev-mode gate in `cli.ts` runs BEFORE the removed-verbs check
 *      and is wrapped in `if (isDevMode())`.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

// `__dirname` at runtime is `<repo>/dist-test/test/`. Repo root is two
// levels up — matches the pattern in `test/cli-crash-proof-isolation.test.ts`.
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const CLI_TS = path.join(REPO_ROOT, 'src', 'cli.ts');
const DEV_VERBS_TS = path.join(REPO_ROOT, 'src', 'cli', 'dev-verbs.ts');
const REMOVED_VERBS_TS = path.join(REPO_ROOT, 'src', 'cli', 'removed-verbs.ts');

/**
 * Regex-extract the contents of an exported `Set([...])` literal. Returns
 * the bare string members (no quotes, no whitespace).
 *
 * Format expected: `export const X: ReadonlySet<string> = new Set([\n  'a',\n  'b',\n]);`
 */
function parseSetLiteral(src: string, exportName: string): string[] {
  const re = new RegExp(`export\\s+const\\s+${exportName}[^=]*=\\s*new\\s+Set\\(\\s*\\[([^\\]]+)\\]`, 'm');
  const match = src.match(re);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s.length > 0);
}

/**
 * Regex-extract the keys of an exported `Record<string, string>` object
 * literal. Returns bare string keys.
 *
 * Format expected: `export const X: Record<string, string> = {\n  foo: '...',\n  bar: '...',\n};`
 */
function parseRecordKeys(src: string, exportName: string): string[] {
  const re = new RegExp(`export\\s+const\\s+${exportName}[^=]*=\\s*\\{([^}]+)\\}`, 'm');
  const match = src.match(re);
  if (!match) return [];
  // Keys: at-line-start (after optional whitespace), word, optional quotes,
  // followed by `:`. Skip pure-comment / blank lines.
  const keys: string[] = [];
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    const keyMatch = trimmed.match(/^['"]?([A-Za-z][A-Za-z0-9_-]*)['"]?\s*:/);
    if (keyMatch) keys.push(keyMatch[1]);
  }
  return keys;
}

describe('CLI dev-mode verbs boundary (#432)', function () {
  let cliSrc: string;
  let devVerbsSrc: string;
  let removedVerbsSrc: string;

  before(function () {
    cliSrc = fs.readFileSync(CLI_TS, 'utf8');
    devVerbsSrc = fs.readFileSync(DEV_VERBS_TS, 'utf8');
    removedVerbsSrc = fs.readFileSync(REMOVED_VERBS_TS, 'utf8');
  });

  describe('parser sanity (test fixture self-check)', function () {
    it('parses DEV_VERBS as a non-empty set of identifiers', function () {
      const verbs = parseSetLiteral(devVerbsSrc, 'DEV_VERBS');
      expect(verbs).to.be.an('array').that.is.not.empty;
      // Spot-check: at least one verb we know is in the set.
      expect(verbs).to.include('cue');
    });

    it('parses REMOVED_VERBS as a non-empty record of identifiers', function () {
      const keys = parseRecordKeys(removedVerbsSrc, 'REMOVED_VERBS');
      expect(keys).to.be.an('array').that.is.not.empty;
      // Spot-check: `stop` was removed in #288 and stays removed.
      expect(keys).to.include('stop');
    });
  });

  describe('DEV_VERBS ↔ REMOVED_VERBS overlap rule', function () {
    it('no DEV_VERBS verb appears in REMOVED_VERBS (single-source live/removed status)', function () {
      const devVerbs = parseSetLiteral(devVerbsSrc, 'DEV_VERBS');
      const removedKeys = new Set(parseRecordKeys(removedVerbsSrc, 'REMOVED_VERBS'));
      const overlap = devVerbs.filter((v) => removedKeys.has(v));
      expect(
        overlap,
        `Verbs appear in BOTH DEV_VERBS and REMOVED_VERBS: ${overlap.join(', ')}. ` +
        `Remove from REMOVED_VERBS — the dev-mode gate intercepts before the removed-verbs check, ` +
        `so the hint never fires for dev users; the duplication is dead UX with mixed-status ambiguity.`,
      ).to.deep.equal([]);
    });
  });

  describe('REMOVED_VERBS ↔ cli.ts switch rule', function () {
    it('no REMOVED_VERBS key has a matching `case` in cli.ts main switch', function () {
      const removedKeys = parseRecordKeys(removedVerbsSrc, 'REMOVED_VERBS');
      // Strip block comments so doc-strings that mention `case 'foo'` don't false-positive.
      const stripped = cliSrc
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      const offenders: string[] = [];
      for (const verb of removedKeys) {
        // Match `case 'verb':` and `case "verb":` with surrounding whitespace.
        const re = new RegExp(`\\bcase\\s+['"]${verb}['"]\\s*:`);
        if (re.test(stripped)) offenders.push(verb);
      }
      expect(
        offenders,
        `These verbs are in REMOVED_VERBS AND have a matching case in cli.ts: ${offenders.join(', ')}. ` +
        `If you intend the verb to be live again, delete its row from REMOVED_VERBS in the same PR; ` +
        `otherwise the hint fires before dispatch and the verb is silently unreachable.`,
      ).to.deep.equal([]);
    });
  });

  describe('dev-verbs dispatcher coverage', function () {
    it('every DEV_VERBS verb has a matching `case` in dispatchDevVerb()', function () {
      const verbs = parseSetLiteral(devVerbsSrc, 'DEV_VERBS');
      const stripped = devVerbsSrc
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      const missing: string[] = [];
      for (const verb of verbs) {
        const re = new RegExp(`\\bcase\\s+['"]${verb}['"]\\s*:`);
        if (!re.test(stripped)) missing.push(verb);
      }
      expect(
        missing,
        `These verbs are in DEV_VERBS but dispatchDevVerb() has no case for them: ${missing.join(', ')}. ` +
        `Add a switch case in dev-verbs.ts that wires the verb to its handler.`,
      ).to.deep.equal([]);
    });
  });

  describe('cli.ts precedence: dev-mode gate BEFORE removed-verbs check', function () {
    it('the dev-verbs dynamic import appears before the removed-verbs dynamic import', function () {
      const devGateIdx = cliSrc.indexOf("import('./cli/dev-verbs')");
      const removedGateIdx = cliSrc.indexOf("import('./cli/removed-verbs')");
      expect(devGateIdx, 'dev-verbs dynamic import not found in cli.ts').to.be.greaterThan(-1);
      expect(removedGateIdx, 'removed-verbs dynamic import not found in cli.ts').to.be.greaterThan(-1);
      expect(
        devGateIdx,
        `dev-verbs gate (offset ${devGateIdx}) must precede removed-verbs gate (offset ${removedGateIdx}). ` +
        `Otherwise dev verbs that overlap with removed verbs silently fall through to the hint.`,
      ).to.be.lessThan(removedGateIdx);
    });

    it('the dev-mode gate is wrapped in `if (isDevMode())` so production dispatch is unaffected', function () {
      // Match: `if (isDevMode()) {` followed within the next ~20 lines by
      // the dev-verbs import. Allows for the architect's idiom but doesn't
      // pin exact whitespace.
      const re = /if\s*\(\s*isDevMode\s*\(\s*\)\s*\)\s*\{[\s\S]{0,800}import\(['"]\.\/cli\/dev-verbs['"]\)/;
      expect(
        re.test(cliSrc),
        `cli.ts must wrap the dev-verbs import in an \`if (isDevMode()) { ... }\` block ` +
        `so production dispatch never loads dev-verbs.ts (keeps the production module graph clean).`,
      ).to.equal(true);
    });
  });
});
