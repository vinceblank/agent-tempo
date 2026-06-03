/**
 * Narrow zod → TypeBox converter (D1 / MD-B, Phase 1).
 *
 * agent-tempo tools declare their parameters as a `z.ZodRawShape`
 * (`Record<string, z.ZodTypeAny>`) — the exact object handed to
 * `McpServer.tool(...)` today (see `src/tools/helpers.ts` `defineTool`). The Pi
 * front-end (`pi.registerTool({ parameters })`) wants a TypeBox schema instead.
 * This module derives the TypeBox object schema from the zod shape so **zod
 * stays the single source of truth** and the two surfaces cannot drift.
 *
 * DESIGN: this is deliberately NOT a general-purpose zod→TypeBox shim. It
 * handles ONLY the feature subset the ~30 tools actually use (audited
 * 2026-06-03) and **throws** — naming the field + feature — on anything else.
 * Failing loud is the whole point (D1): a faithless silent conversion would
 * ship a wrong tool schema to the model. The CI parity test (Track A / S5b)
 * asserts the converter raised on nothing across the real tool set, so any new
 * unaudited zod construct trips CI instead of producing a bad schema.
 *
 * Supported subset:
 *   - z.string()  (+ .min/.max → minLength/maxLength, .regex → pattern)
 *   - z.number()  (+ .int() → integer, .min/.max → minimum/maximum [inclusive])
 *   - z.boolean()
 *   - z.enum([...])            → Type.Union of Type.Literal (anyOf of const)
 *   - z.array(inner)           (+ .min/.max → minItems/maxItems)
 *   - z.object({...})          (nested; appears as an array element today)
 *   - z.union([...])           SCALAR members only (string/number/boolean/enum/
 *                              literal) — object/array/nested-union members throw
 *   - .optional()              → Type.Optional (drops the field from `required`)
 *   - .describe(s)             → TypeBox `{ description: s }` (Pi surfaces it)
 *
 * Everything else (.default, .nullable, .refine/.transform, .coerce, .email,
 * .gt/.lt, z.record/any/unknown/null/date/tuple/intersection/nativeEnum, …)
 * raises {@link UnsupportedZodFeatureError}.
 *
 * `.min`/`.max` are CONTEXT-SENSITIVE — the same modifier maps to
 * minLength/maxLength (string), minimum/maximum (number), or minItems/maxItems
 * (array) depending on the base zod type. The mapping is keyed on the base
 * type, never on the modifier alone.
 *
 * TypeBox note (D12, confirmed): a TypeBox `Type.*` value IS a plain JSON-Schema
 * object at runtime (`{ type, required, properties, … }`), so the output drops
 * straight into Pi's `parameters` field with no further transform.
 */
import { z } from 'zod';
import { Type, type TObject, type TSchema } from 'typebox';

/** Where in the schema we are, for actionable error messages. */
interface ConvertContext {
  /** Tool name, when the caller supplies it (richer errors). */
  readonly tool?: string;
  /** Dotted field path within the shape, e.g. `evaluations.status`. */
  readonly path: string;
}

/**
 * Thrown when a tool param schema uses a zod construct outside the audited
 * subset. Carries the field path + offending feature so CI / callers can point
 * at the exact source. A named class lets the parity test assert "raised on
 * nothing" precisely.
 */
export class UnsupportedZodFeatureError extends Error {
  constructor(
    readonly context: ConvertContext,
    readonly feature: string,
  ) {
    const where = `${context.tool ? `${context.tool}.` : ''}${context.path || '<root>'}`;
    super(`zod→TypeBox: unsupported feature "${feature}" at ${where}. ` +
      `Extend src/pi/zod-to-typebox.ts (and a unit test) if this construct is intentional.`);
    this.name = 'UnsupportedZodFeatureError';
  }
}

/**
 * Loose view of zod's internal `_def`. We are deliberately introspecting
 * runtime internals (zod 3.25) — the typed public API does not expose checks,
 * enum values, array length bounds, etc. Confined to this one accessor.
 */
interface ZodDef {
  typeName?: string;
  description?: string;
  innerType?: z.ZodTypeAny;
  values?: readonly string[];
  value?: unknown;
  options?: z.ZodTypeAny[];
  type?: z.ZodTypeAny;
  checks?: Array<Record<string, unknown>>;
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
  exactLength?: { value: number } | null;
  shape?: () => z.ZodRawShape;
}

function defOf(zt: z.ZodTypeAny): ZodDef {
  return (zt as unknown as { _def: ZodDef })._def;
}

/** TypeBox metadata options carried onto every schema node. */
type Meta = Record<string, unknown>;

const SCALAR_TYPE_NAMES = new Set([
  'ZodString',
  'ZodNumber',
  'ZodBoolean',
  'ZodEnum',
  'ZodLiteral',
]);

/**
 * Convert a tool's zod param shape into a TypeBox object schema suitable for
 * `pi.registerTool({ parameters })`. This is the public entry point consumed by
 * the Pi front-end (`src/pi/render-tools.ts`).
 *
 * @param shape    The tool's `z.ZodRawShape` (the `paramsSchema` from `defineTool`).
 * @param toolName Optional tool name, woven into error messages.
 * @throws {UnsupportedZodFeatureError} on any zod construct outside the subset.
 */
export function zodShapeToTypeBox(shape: z.ZodRawShape, toolName?: string): TObject {
  return buildObject(shape, { tool: toolName, path: '' });
}

function buildObject(shape: z.ZodRawShape, ctx: ConvertContext, meta: Meta = {}): TObject {
  const props: Record<string, TSchema> = {};
  for (const [key, zt] of Object.entries(shape)) {
    const fieldCtx: ConvertContext = {
      tool: ctx.tool,
      path: ctx.path ? `${ctx.path}.${key}` : key,
    };
    const { inner, isOptional, outerDescription } = stripOptional(zt);
    const schema = convert(inner, fieldCtx, outerDescription);
    props[key] = isOptional ? Type.Optional(schema) : schema;
  }
  return Type.Object(props, meta);
}

/**
 * Peel a single `.optional()` wrapper. Captures the description authored on the
 * wrapper (e.g. `z.string().optional().describe('…')` puts it on the optional)
 * so it survives onto the inner schema.
 */
function stripOptional(zt: z.ZodTypeAny): {
  inner: z.ZodTypeAny;
  isOptional: boolean;
  outerDescription?: string;
} {
  const def = defOf(zt);
  if (def?.typeName === 'ZodOptional') {
    return { inner: def.innerType as z.ZodTypeAny, isOptional: true, outerDescription: def.description };
  }
  return { inner: zt, isOptional: false };
}

/** Convert a NON-optional zod type. `descOverride` wins over the node's own description. */
function convert(zt: z.ZodTypeAny, ctx: ConvertContext, descOverride?: string): TSchema {
  const def = defOf(zt);
  const typeName: string | undefined = def?.typeName;
  const description = descOverride ?? def?.description;
  const meta: Meta = description !== undefined ? { description } : {};

  switch (typeName) {
    case 'ZodString':
      return Type.String({ ...meta, ...stringConstraints(zt, ctx) });
    case 'ZodNumber': {
      const { isInt, opts } = numberConstraints(zt, ctx);
      const numMeta = { ...meta, ...opts };
      return isInt ? Type.Integer(numMeta) : Type.Number(numMeta);
    }
    case 'ZodBoolean':
      return Type.Boolean(meta);
    case 'ZodEnum': {
      const values = def.values as readonly string[];
      return Type.Union(values.map((v) => Type.Literal(v)), meta);
    }
    case 'ZodLiteral':
      return Type.Literal(def.value as string | number | boolean, meta);
    case 'ZodArray':
      return Type.Array(arrayElement(def.type as z.ZodTypeAny, ctx), {
        ...meta,
        ...arrayConstraints(zt, ctx),
      });
    case 'ZodObject':
      return buildObject(def.shape!(), ctx, meta);
    case 'ZodUnion':
      return convertUnion(zt, ctx, meta);
    default:
      throw new UnsupportedZodFeatureError(ctx, typeName ?? 'unknown (not a zod type)');
  }
}

/** Array elements are converted as non-optional types; an optional element is rejected. */
function arrayElement(el: z.ZodTypeAny, ctx: ConvertContext): TSchema {
  const { inner, isOptional } = stripOptional(el);
  if (isOptional) {
    throw new UnsupportedZodFeatureError(
      { ...ctx, path: `${ctx.path}[]` },
      'optional array element',
    );
  }
  return convert(inner, { ...ctx, path: `${ctx.path}[]` });
}

function stringConstraints(zt: z.ZodTypeAny, ctx: ConvertContext): Meta {
  const out: Meta = {};
  for (const check of (defOf(zt).checks ?? []) as Array<Record<string, unknown>>) {
    switch (check.kind) {
      case 'min':
        out.minLength = check.value;
        break;
      case 'max':
        out.maxLength = check.value;
        break;
      case 'regex':
        out.pattern = (check.regex as RegExp).source;
        break;
      default:
        throw new UnsupportedZodFeatureError(ctx, `z.string().${String(check.kind)}()`);
    }
  }
  return out;
}

function numberConstraints(zt: z.ZodTypeAny, ctx: ConvertContext): { isInt: boolean; opts: Meta } {
  let isInt = false;
  const opts: Meta = {};
  for (const check of (defOf(zt).checks ?? []) as Array<Record<string, unknown>>) {
    switch (check.kind) {
      case 'int':
        isInt = true;
        break;
      case 'min':
        if (check.inclusive === false) {
          throw new UnsupportedZodFeatureError(ctx, 'z.number() exclusive minimum (.gt)');
        }
        opts.minimum = check.value;
        break;
      case 'max':
        if (check.inclusive === false) {
          throw new UnsupportedZodFeatureError(ctx, 'z.number() exclusive maximum (.lt)');
        }
        opts.maximum = check.value;
        break;
      default:
        throw new UnsupportedZodFeatureError(ctx, `z.number().${String(check.kind)}()`);
    }
  }
  return { isInt, opts };
}

function arrayConstraints(zt: z.ZodTypeAny, ctx: ConvertContext): Meta {
  // NOTE: zod stores array length bounds as named `_def` FIELDS
  // (`minLength`/`maxLength`/`exactLength`), NOT as `_def.checks[]` entries like
  // string and number bounds. Don't "unify" this with stringConstraints /
  // numberConstraints — they read a genuinely different zod representation.
  const def = defOf(zt);
  const out: Meta = {};
  if (def.exactLength) {
    throw new UnsupportedZodFeatureError(ctx, 'z.array().length() (exact length)');
  }
  if (def.minLength) out.minItems = def.minLength.value;
  if (def.maxLength) out.maxItems = def.maxLength.value;
  return out;
}

function convertUnion(zt: z.ZodTypeAny, ctx: ConvertContext, meta: Meta): TSchema {
  const options = defOf(zt).options as z.ZodTypeAny[];
  const members = options.map((member, i) => {
    const memberCtx: ConvertContext = { ...ctx, path: `${ctx.path}|${i}` };
    const { inner, isOptional } = stripOptional(member);
    if (isOptional) {
      throw new UnsupportedZodFeatureError(memberCtx, 'optional union member');
    }
    const memberTypeName: string | undefined = defOf(inner)?.typeName;
    if (memberTypeName === undefined || !SCALAR_TYPE_NAMES.has(memberTypeName)) {
      throw new UnsupportedZodFeatureError(
        memberCtx,
        `non-scalar union member (${memberTypeName ?? 'unknown'}); only string/number/boolean/enum/literal members are supported`,
      );
    }
    return convert(inner, memberCtx);
  });
  return Type.Union(members, meta);
}
