/**
 * Per-action runtime field guard for the canonical multi-action tools (#793).
 *
 * The tool-family merge (#793) collapses each family into one canonical tool
 * with a flat `{ action, ...per-action optional fields }` param shape. Because
 * the union makes every per-action field optional at the zod boundary (we do
 * NOT use `z.discriminatedUnion` — see docs/design/793-tool-family-merge-brief.md
 * §2), cross-field "this action requires that field" rules are enforced at
 * RUNTIME inside the handler, before dispatch.
 *
 * {@link firstMissing} returns the first required field that is absent so the
 * handler can return a friendly, actionable `fail(...)` message naming the
 * exact tool, action, and field — instead of a cryptic downstream error.
 */

/**
 * Return the first field name in `fields` whose value in `args` is "missing"
 * (`undefined`, `null`, or an empty string), or `null` when all are present.
 *
 * Empty-string counts as missing so a canonical handler rejects e.g.
 * `coat_check{action:'get', ticket:''}` with the same friendly error a wholly
 * omitted ticket would produce.
 */
export function firstMissing(
  args: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    const v = args[field];
    if (v === undefined || v === null || v === '') return field;
  }
  return null;
}
