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
 *  - a name is present in both but under the wrong kind (e.g. documented as
 *    "Signal" but declared as `defineQuery` in source)
 *
 * PR-G lands the check itself; #126 tightens the doc parser so it scopes
 * extraction to section headers ("## Session Signals", "## Conductor Queries",
 * etc.) and matches `(kind, name)` pairs rather than a flat name set. This
 * eliminates the TYPE_REFERENCE_FIELDS allowlist, which grew with doc surface
 * and could silently mask a real undocumented wire name that happened to share
 * a field identifier.
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
 * Explicit allowlist mapping WIRE-PROTOCOL.md `## Section Header` → `DefineKind`
 * (or `null` for documentation-only sections that should be skipped by the
 * drift detector). #239 replaced the earlier keyword-matching classifier
 * with this table for three reasons:
 *
 * 1. **Section-rename resilience.** The old `lower.includes('signal')`
 *    matcher would silently return `null` if someone renamed
 *    `## Session Signals` → `## Session Handlers` — drift detection would
 *    quietly stop covering that section, and the guardrail would develop
 *    a hole exactly where it was supposed to protect. With this table,
 *    the rename triggers an immediate "Unknown WIRE-PROTOCOL section"
 *    throw that points directly at the fix.
 *
 * 2. **Typo detection.** The old matcher happily skipped typos like
 *    `## Session Singals`. The allowlist catches them at run time.
 *
 * 3. **Explicit doc ↔ test coupling.** Adding a section to
 *    `docs/WIRE-PROTOCOL.md` now requires an explicit allowlist entry.
 *    That's deliberate — it's the same kind of deliberate coupling as the
 *    wire protocol itself.
 *
 * Trade-off: the table must be updated when a section is legitimately added
 * to `WIRE-PROTOCOL.md`. That's the point.
 */
const SECTION_TO_KIND: Record<string, DefineKind | null> = {
  // Signal sections
  'Session Signals': 'signal',
  'Conductor Signals': 'signal',
  'Scheduler Signals': 'signal',
  'Per-Ensemble Maestro Signal': 'signal',
  'Global Maestro Signals': 'signal', // pluralized in #274 when hostProfile joined maestroNotifyMessage
  // Query sections
  'Session Queries': 'query',
  'Session Outbox Query': 'query',
  'Conductor Query': 'query',
  'Scheduler Queries': 'query',
  'Per-Ensemble Maestro Queries': 'query',
  'Global Maestro Queries': 'query',
  // Update sections
  'Session Updates': 'update',
  'Per-Ensemble Maestro Update': 'update',
  'Global Maestro Updates': 'update',
  // Explicit skips — documentation-only sections whose table entries are
  // not `define*` handler names (workflow function names, Temporal search
  // attribute keys, or payload struct fields).
  'Stability Guarantee': null,
  'Workflow Names': null,
  'Search Attributes': null,
  'Type Reference': null,
};

/**
 * Infer the DefineKind for a WIRE-PROTOCOL.md `## Section Header`.
 *
 * Returns `null` for sections that should be skipped (Workflow Names,
 * Search Attributes, Type Reference, Stability Guarantee). Throws when the
 * section header is absent from `SECTION_TO_KIND` — surfaces rename / typo
 * drift immediately rather than silently dropping coverage (#239).
 */
function kindFromSectionHeader(header: string): DefineKind | null {
  if (!(header in SECTION_TO_KIND)) {
    throw new Error(
      `Unknown WIRE-PROTOCOL section: "${header}". Add it to SECTION_TO_KIND in test/wire-protocol.test.ts.`,
    );
  }
  return SECTION_TO_KIND[header];
}

/**
 * Parse `docs/WIRE-PROTOCOL.md` and extract wire names, scoped by section.
 *
 * Splits the document at every `## Section Header` boundary and only extracts
 * backtick-quoted table-row names from sections whose headers indicate they
 * contain signal / query / update definitions. Sections like "## Workflow Names",
 * "## Search Attributes", and "## Type Reference" are skipped — their table
 * entries are either workflow function names (not `define*` calls), Temporal
 * search attribute keys, or payload struct fields, none of which are wire-
 * protocol handler names.
 *
 * This approach eliminates the TYPE_REFERENCE_FIELDS allowlist from PR-G, which
 * grew with doc surface and could silently mask a real undocumented handler that
 * happened to share a common field identifier (issue #126).
 *
 * Returns a WireName[] with `kind` inferred from the section header, enabling
 * `(kind, name)` pair matching instead of the flat-name-set approach in PR-G.
 */
function extractNamesFromDocs(docPath: string): WireName[] {
  const text = fs.readFileSync(docPath, 'utf-8');
  const results: WireName[] = [];

  // Split into top-level sections. We match `## ` (exactly two hashes + space)
  // to capture section boundaries without also splitting on `### ` sub-headers.
  const sectionRE = /^## (.+)$/gm;
  const sectionMatches = [...text.matchAll(sectionRE)];

  for (let i = 0; i < sectionMatches.length; i++) {
    const header = sectionMatches[i][1]; // e.g. "Session Signals"
    const kind = kindFromSectionHeader(header);
    if (kind === null) continue; // skip Workflow Names, Search Attributes, etc.

    const bodyStart = sectionMatches[i].index! + sectionMatches[i][0].length;
    const bodyEnd = i + 1 < sectionMatches.length
      ? sectionMatches[i + 1].index!
      : text.length;
    const body = text.slice(bodyStart, bodyEnd);

    // Extract backtick-quoted identifiers from table first-column cells.
    // Only accepts identifier-shaped names so we don't pick up prose examples.
    const ROW_RE = /^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|/gm;
    let match: RegExpExecArray | null;
    while ((match = ROW_RE.exec(body)) !== null) {
      results.push({ kind, name: match[1], source: 'docs/WIRE-PROTOCOL.md' });
    }
  }

  return results;
}

/** Stable `(kind, name)` composite key for Map/Set lookups. */
function wireKey(w: { kind: DefineKind; name: string }): string {
  return `${w.kind}:${w.name}`;
}

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
  let docsNames: WireName[];

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

  it('doc parser finds a plausible number of wire-protocol entries', function () {
    // Guards against a section-header regex regression that silently skips all sections.
    expect(docsNames.length).to.be.gte(20,
      `Doc parser found only ${docsNames.length} entries; expected >= 20. ` +
      `Check that extractNamesFromDocs correctly scopes to signal/query/update sections ` +
      `in docs/WIRE-PROTOCOL.md.`);
  });

  it('every handler declared in source is documented in WIRE-PROTOCOL.md (matched by kind + name)', function () {
    const docsKeySet = new Set(docsNames.map(wireKey));
    const undocumented = sourceNames.filter((w) => !docsKeySet.has(wireKey(w)));

    if (undocumented.length > 0) {
      const bulleted = undocumented
        .map((w) => `  - [${w.kind}] ${w.name} (declared in src/workflows/${w.source})`)
        .join('\n');
      throw new Error(
        `\n${undocumented.length} handler(s) declared in code but missing from docs/WIRE-PROTOCOL.md:\n${bulleted}\n\n` +
        `Document them under the correct section (signals / queries / updates). ` +
        `Additive changes require commit tag 'wire-protocol:additive'; ` +
        `renames/removals require 'wire-protocol:breaking' per design §17.9.`,
      );
    }
  });

  it('every (kind, name) pair documented in WIRE-PROTOCOL.md exists in source', function () {
    // The section-scoped doc parser excludes Workflow Names, Search Attributes,
    // and Type Reference — no allowlists needed here (#126).
    const sourceKeySet = new Set(sourceNames.map(wireKey));
    const stale = docsNames.filter((w) => !sourceKeySet.has(wireKey(w)));

    if (stale.length > 0) {
      const bulleted = stale
        .map((w) => `  - [${w.kind}] ${w.name} (documented in docs/WIRE-PROTOCOL.md)`)
        .join('\n');
      throw new Error(
        `\n${stale.length} (kind, name) pair(s) documented in docs/WIRE-PROTOCOL.md but not declared in source:\n${bulleted}\n\n` +
        `Either the handler was renamed/removed (update the docs, tag 'wire-protocol:breaking') ` +
        `or it is documented under the wrong section kind (e.g. listed under "Signals" but ` +
        `declared as defineQuery in code — move it to the correct table).`,
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

describe('kindFromSectionHeader — #239 allowlist', function () {
  // Independent hardcoded expectations per acceptance criterion "test asserting
  // each of the 18 current section names classifies correctly." A bug in
  // SECTION_TO_KIND (e.g. a typo'd key, or a section accidentally mapped to
  // the wrong kind) breaks this matrix. Keep in sync with docs/WIRE-PROTOCOL.md.
  const EXPECTED_CLASSIFICATIONS: ReadonlyArray<readonly [string, DefineKind | null]> = [
    // Signal sections
    ['Session Signals', 'signal'],
    ['Conductor Signals', 'signal'],
    ['Scheduler Signals', 'signal'],
    ['Per-Ensemble Maestro Signal', 'signal'],
    ['Global Maestro Signals', 'signal'], // #274 pluralized; hostProfile + maestroNotifyMessage
    // Query sections
    ['Session Queries', 'query'],
    ['Session Outbox Query', 'query'],
    ['Conductor Query', 'query'],
    ['Scheduler Queries', 'query'],
    ['Per-Ensemble Maestro Queries', 'query'],
    ['Global Maestro Queries', 'query'],
    // Update sections
    ['Session Updates', 'update'],
    ['Per-Ensemble Maestro Update', 'update'],
    ['Global Maestro Updates', 'update'],
    // Explicit skips
    ['Stability Guarantee', null],
    ['Workflow Names', null],
    ['Search Attributes', null],
    ['Type Reference', null],
  ];

  it('classifies each of the 18 current WIRE-PROTOCOL.md sections to the expected kind', function () {
    expect(EXPECTED_CLASSIFICATIONS.length).to.equal(
      18,
      'expected 18 known sections — if adding/removing, update EXPECTED_CLASSIFICATIONS and SECTION_TO_KIND',
    );
    for (const [header, expected] of EXPECTED_CLASSIFICATIONS) {
      expect(kindFromSectionHeader(header)).to.equal(
        expected,
        `section "${header}" misclassified`,
      );
    }
  });

  it('throws on unknown section header (rename/typo safety net)', function () {
    expect(() => kindFromSectionHeader('Session Handlers')).to.throw(
      /Unknown WIRE-PROTOCOL section:/,
    );
    expect(() => kindFromSectionHeader('Session Singals')).to.throw(
      /Unknown WIRE-PROTOCOL section:/,
    );
    // Precise error-message contract — we promise a pointer to the fix.
    expect(() => kindFromSectionHeader('Bogus Section')).to.throw(
      /Add it to SECTION_TO_KIND/,
    );
  });
});
