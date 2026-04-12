/**
 * Wire-protocol drift detector.
 *
 * Scans `src/workflows/{signals,maestro-signals,scheduler-signals}.ts` via a
 * ts-morph AST walker for every `defineSignal` / `defineQuery` / `defineUpdate`
 * call, extracts the string-literal wire name, and diffs the result against
 * the names documented in `docs/WIRE-PROTOCOL.md`.
 *
 * Fails CI if:
 *  - a handler exists in code but is absent from the docs (undocumented surface)
 *  - a name exists in docs but not in code (stale documentation / typo)
 *
 * PR-G lands the check itself; the commit-tag mechanic for non-breaking-additive
 * vs. breaking-rename updates (per §17.9) is wired up as a separate CI follow-up.
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §17.9
 * (superseded paragraph landing atomically in the same PR-G diff).
 * Sequencing memo: §3 PR-G.
 *
 * Robustness notes (per architect-2 adjudication):
 *  - Source-scan over `src/workflows/*signals.ts`, NOT dist-scan. ESBuild-minified
 *    bundles fold string literals and strip comments; AST over source is the
 *    canonical declaration site and catches declared-but-unwired handlers too.
 *  - ts-morph's AST walker (not regex) so template strings and renames surface as
 *    TypeScript-typed errors instead of silent misses.
 */
import { expect } from 'chai';
import * as path from 'path';
import * as fs from 'fs';
import { Project, SyntaxKind, StringLiteral } from 'ts-morph';

/** Kinds of wire-protocol handlers declared in `src/workflows/*signals.ts`. */
type DefineKind = 'signal' | 'query' | 'update';

/** A single wire-protocol handler declaration extracted from source or docs. */
interface WireName {
  kind: DefineKind;
  name: string;
  /** Source file path (code side) or `'docs/WIRE-PROTOCOL.md'` (docs side). */
  source: string;
}

/** Map from ts-morph call-expression name back to our union. */
const DEFINE_FN_MAP: Record<string, DefineKind> = {
  defineSignal: 'signal',
  defineQuery: 'query',
  defineUpdate: 'update',
};

/**
 * Walk the given signals file and extract every defineSignal/Query/Update call.
 * Returns the extracted wire names with source attribution for diagnostic output.
 */
function extractNamesFromSource(filePath: string): WireName[] {
  const project = new Project({
    compilerOptions: { allowJs: false, noEmit: true },
    skipAddingFilesFromTsConfig: true,
  });
  const sf = project.addSourceFileAtPath(filePath);

  const results: WireName[] = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const fnName = expr.getText();
    const kind = DEFINE_FN_MAP[fnName];
    if (!kind) continue;

    const args = call.getArguments();
    if (args.length === 0) continue;
    // The name is the first (and only) string-literal call argument. Generic
    // type parameters on defineSignal<[X]>(name) / defineQuery<T>(name) /
    // defineUpdate<R, [X]>(name) are syntactic type args accessed via
    // `call.getTypeArguments()`, not runtime call args, so they don't appear
    // in `args` at all.
    const nameArg = args.find((a): a is StringLiteral => a.isKind(SyntaxKind.StringLiteral));
    if (!nameArg) continue;

    results.push({
      kind,
      name: nameArg.getLiteralText(),
      source: path.basename(filePath),
    });
  }

  return results;
}

/**
 * Parse `docs/WIRE-PROTOCOL.md` and extract every wire name declared in a table
 * row. Table rows match the pattern `| \`name\` | ... | ... |` — the backtick-
 * quoted first column is the wire name.
 *
 * The doc intermixes several table categories (signals, queries, updates,
 * search attributes). This parser deliberately does not categorize by kind —
 * drift is detected on the flat set of names, and the kind is only attached
 * for diagnostic output. That means a documented name moved from the "signals"
 * table to the "queries" table would NOT be flagged as drift — the source-side
 * defineSignal-vs-defineQuery distinction guards that, and a mis-categorized
 * doc entry is a docs-only lint issue out of scope for this check.
 */
function extractNamesFromDocs(docPath: string): Set<string> {
  const text = fs.readFileSync(docPath, 'utf-8');
  const names = new Set<string>();

  // Structural row pattern: leading `|`, first cell is backtick-quoted name,
  // then further `|` separators. Tolerant of surrounding whitespace.
  // Only accepts identifier-shaped names so we don't pick up prose examples.
  const ROW_RE = /^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|/gm;

  let match: RegExpExecArray | null;
  while ((match = ROW_RE.exec(text)) !== null) {
    names.add(match[1]);
  }

  return names;
}

/** Search attribute names — declared in the docs but not in `defineSignal` calls. */
const SEARCH_ATTRIBUTE_NAMES = new Set([
  'ClaudeTempoEnsemble',
  'ClaudeTempoPlayerId',
  'ClaudeTempoHostname',
  'ClaudeTempoStatus',
  'ClaudeTempoGitRoot',
  'ClaudeTempoPlayerType',
  'ClaudeTempoIsConductor',
  'ClaudeTempoAttachedHost',
  'ClaudeTempoAttachmentState',
  'ClaudeTempoAttachmentId',
]);

/**
 * Workflow function names declared in `src/workflows/*.ts` — they're documented
 * in WIRE-PROTOCOL.md's "## Workflow Names" table but appear as exported
 * functions, not `define*` calls, so the AST walker doesn't pick them up. These
 * names are stable per the doc's §Stability Guarantee. Sourced from `docs/WIRE-PROTOCOL.md`.
 */
const WORKFLOW_NAMES = new Set([
  'claudeSessionWorkflow',
  'claudeSchedulerWorkflow',
  'claudeMaestroWorkflow',
  'claudeGlobalMaestroWorkflow',
]);

/**
 * Type-reference field names (e.g. `task`, `criteria`, `failurePolicy`) appear
 * in the doc's `## Type Reference` tables. These are struct fields, not wire
 * names. The parser's identifier-shape regex picks them up; we filter them out
 * here. Keep this list narrow — if a real wire name happens to share a field
 * identifier, rename one.
 */
const TYPE_REFERENCE_FIELDS = new Set([
  // ScheduleEntry selected fields
  'type', 'cronExpression', 'timezone',
  // QualityGate selected fields
  'task', 'criteria', 'createdBy', 'createdAt', 'status',
  // WorktreeEntry
  'player', 'path', 'branch', 'gitRoot',
  // StageEntry
  'name', 'players', 'failurePolicy', 'completedAt',
  // RecruitOutboxEntry
  'allowedTools',
  // MaestroPlayerInfo
  'playerId', 'ensemble', 'part', 'hostname', 'workDir', 'gitBranch',
  'isConductor', 'agentType', 'playerType',
  // EnsembleChatMessage
  'id', 'from', 'to', 'text', 'timestamp', 'role',
  // EnsembleChatQuery
  'offset', 'limit',
  // EnsembleChatResult
  'messages', 'total', 'hasMore', 'hasConductor',
  // MaestroRelayMessage
  'direction',
  // MaestroEvent
  'oldValue', 'newValue',
  // MaestroPendingCommand
  'source', 'replyTo', 'error',
]);

describe('wire-protocol drift detector (§17.9)', function () {
  // At runtime this test file is compiled to `dist-test/test/wire-protocol.test.js`.
  // `__dirname` is `<repo>/dist-test/test`, so `../..` reaches the repo root where
  // the TypeScript sources + design docs live. Source-scan is intentional — see
  // file docstring + design §17.9 for the dist-scan rationale.
  const repoRoot = path.resolve(__dirname, '..', '..');
  const signalsFiles = [
    path.join(repoRoot, 'src', 'workflows', 'signals.ts'),
    path.join(repoRoot, 'src', 'workflows', 'maestro-signals.ts'),
    path.join(repoRoot, 'src', 'workflows', 'scheduler-signals.ts'),
  ];
  const docsFile = path.join(repoRoot, 'docs', 'WIRE-PROTOCOL.md');

  let sourceNames: WireName[];
  let docsNames: Set<string>;

  before(function () {
    // Sanity: target files exist where expected.
    for (const f of signalsFiles) {
      if (!fs.existsSync(f)) {
        throw new Error(`Expected signals file not found: ${f}`);
      }
    }
    if (!fs.existsSync(docsFile)) {
      throw new Error(`WIRE-PROTOCOL.md not found: ${docsFile}`);
    }

    sourceNames = signalsFiles.flatMap(extractNamesFromSource);
    docsNames = extractNamesFromDocs(docsFile);
  });

  it('AST walker finds a plausible number of wire-protocol handlers', function () {
    // Sanity check — if ts-morph traversal is completely broken we get 0 hits.
    // Pre-commit sanity: `grep -E "defineSignal|defineQuery|defineUpdate" src/workflows/*.ts | wc -l`
    // (per architect-2). As of PR-G there are ~60+ handler declarations across
    // the three signals files.
    expect(sourceNames.length).to.be.gte(20,
      `AST walker found only ${sourceNames.length} handlers; expected >= 20. ` +
      `Verify ts-morph parsing of signals.ts + maestro-signals.ts + scheduler-signals.ts.`);
  });

  it('every handler declared in source is documented in WIRE-PROTOCOL.md', function () {
    const undocumented = sourceNames.filter((w) => !docsNames.has(w.name));

    if (undocumented.length > 0) {
      const bulleted = undocumented
        .map((w) => `  - [${w.kind}] ${w.name} (declared in src/workflows/${w.source})`)
        .join('\n');
      throw new Error(
        `\n${undocumented.length} handler(s) declared in code but missing from docs/WIRE-PROTOCOL.md:\n${bulleted}\n\n` +
        `Document them (additive changes require commit tag 'wire-protocol:additive'; ` +
        `renames/removals require 'wire-protocol:breaking' per design §17.9).`,
      );
    }
  });

  it('every name documented in WIRE-PROTOCOL.md exists in source (minus known non-wire entries)', function () {
    const sourceNameSet = new Set(sourceNames.map((w) => w.name));
    const stale: string[] = [];

    for (const docName of docsNames) {
      if (sourceNameSet.has(docName)) continue;
      if (SEARCH_ATTRIBUTE_NAMES.has(docName)) continue;
      if (TYPE_REFERENCE_FIELDS.has(docName)) continue;
      if (WORKFLOW_NAMES.has(docName)) continue;
      stale.push(docName);
    }

    if (stale.length > 0) {
      throw new Error(
        `\n${stale.length} name(s) documented in docs/WIRE-PROTOCOL.md but not declared in source:\n` +
        stale.map((n) => `  - ${n}`).join('\n') +
        `\n\nEither the name was renamed/removed (update the docs, tag 'wire-protocol:breaking') ` +
        `or it belongs in the SEARCH_ATTRIBUTE_NAMES / TYPE_REFERENCE_FIELDS / WORKFLOW_NAMES allowlists ` +
        `in test/wire-protocol.test.ts.`,
      );
    }
  });

  it('no duplicate handler names across signal / query / update kinds', function () {
    // Enforces that names are globally unique — a name must identify exactly one
    // kind of handler. Caught early prevents confusing `handle.signal('x')` vs
    // `handle.query('x')` bugs when a name overlaps kinds.
    const byName = new Map<string, WireName[]>();
    for (const w of sourceNames) {
      const list = byName.get(w.name) ?? [];
      list.push(w);
      byName.set(w.name, list);
    }
    const collisions = [...byName.entries()].filter(([, list]) => list.length > 1);
    if (collisions.length > 0) {
      const bulleted = collisions
        .map(([name, list]) =>
          `  - "${name}": ${list.map((w) => `${w.kind} in ${w.source}`).join(' + ')}`,
        )
        .join('\n');
      throw new Error(`\nWire-protocol name collisions across kinds:\n${bulleted}`);
    }
  });
});
