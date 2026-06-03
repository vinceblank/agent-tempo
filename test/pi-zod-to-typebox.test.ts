/**
 * Unit tests for the narrow zod → TypeBox converter (src/pi/zod-to-typebox.ts).
 *
 * Proven here WITHOUT Temporal or Pi installed (pure module, typebox is a real
 * dependency):
 *   1. Each supported zod feature round-trips to the right JSON-Schema shape.
 *   2. `.optional()` drops the field from `required` and nothing else does —
 *      this is the contract the Track-A parity test (S5b) deep-compares.
 *   3. The two real non-flat tool cases (evaluate-gate's array-of-object,
 *      restart's primitive union) convert faithfully — the parity test only
 *      checks required-NAMES, so their FIDELITY rests on these tests.
 *   4. Unsupported zod constructs THROW (D1 fail-loud), naming the field.
 *
 * A TypeBox `Type.*` value is a plain JSON-Schema object at runtime, so we
 * assert directly against `{ type, required, properties, … }`.
 */
import { expect } from 'chai';
import { z } from 'zod';
import {
  zodShapeToTypeBox,
  UnsupportedZodFeatureError,
} from '../src/pi/zod-to-typebox';

/** JSON-Schema view of a TypeBox node (its runtime shape). */
type JsonSchema = {
  type?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  const?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
};

const asJson = (schema: unknown): JsonSchema => schema as JsonSchema;
const field = (shape: z.ZodRawShape, key: string): JsonSchema =>
  asJson(zodShapeToTypeBox(shape)).properties![key];

describe('zod→TypeBox — string', () => {
  it('maps a bare string to { type: "string" }', () => {
    expect(field({ s: z.string() }, 's')).to.deep.equal({ type: 'string' });
  });

  it('maps .min/.max to minLength/maxLength (NOT minimum/maximum)', () => {
    expect(field({ s: z.string().min(1).max(64) }, 's')).to.include({
      type: 'string',
      minLength: 1,
      maxLength: 64,
    });
  });

  it('maps .regex(re) to { pattern: re.source } (not dropped)', () => {
    const out = field({ s: z.string().regex(/^[a-z][a-z0-9-]*$/) }, 's');
    expect(out.type).to.equal('string');
    expect(out.pattern).to.equal('^[a-z][a-z0-9-]*$');
  });

  it('carries .describe() onto { description }', () => {
    expect(field({ s: z.string().describe('a label') }, 's').description).to.equal('a label');
  });
});

describe('zod→TypeBox — number', () => {
  it('maps a bare number to { type: "number" }', () => {
    expect(field({ n: z.number() }, 'n')).to.deep.equal({ type: 'number' });
  });

  it('maps .int() to { type: "integer" }', () => {
    expect(field({ n: z.number().int() }, 'n').type).to.equal('integer');
  });

  it('maps .min/.max to minimum/maximum (NOT minLength/maxLength)', () => {
    expect(field({ n: z.number().int().min(0).max(50) }, 'n')).to.include({
      type: 'integer',
      minimum: 0,
      maximum: 50,
    });
  });
});

describe('zod→TypeBox — boolean', () => {
  it('maps to { type: "boolean" }', () => {
    expect(field({ b: z.boolean() }, 'b')).to.deep.equal({ type: 'boolean' });
  });
});

describe('zod→TypeBox — enum', () => {
  it('maps z.enum([...]) to an anyOf of string consts', () => {
    const out = field({ e: z.enum(['result', 'blocker', 'question']) }, 'e');
    expect(out.anyOf).to.be.an('array').with.length(3);
    expect(out.anyOf!.map((m) => m.const)).to.deep.equal(['result', 'blocker', 'question']);
    out.anyOf!.forEach((m) => expect(m.type).to.equal('string'));
  });

  it('keeps the enum description on the union node', () => {
    const out = field({ e: z.enum(['a', 'b']).describe('mode') }, 'e');
    expect(out.description).to.equal('mode');
  });
});

describe('zod→TypeBox — array', () => {
  it('maps z.array(z.string()) to { type: "array", items }', () => {
    const out = field({ a: z.array(z.string()) }, 'a');
    expect(out.type).to.equal('array');
    expect(out.items).to.deep.equal({ type: 'string' });
  });

  it('maps array .min/.max to minItems/maxItems', () => {
    const out = field({ a: z.array(z.string()).min(1).max(3) }, 'a');
    expect(out.minItems).to.equal(1);
    expect(out.maxItems).to.equal(3);
  });
});

describe('zod→TypeBox — required vs optional (the parity contract)', () => {
  it('includes non-optional fields in required and excludes optional ones', () => {
    const obj = asJson(
      zodShapeToTypeBox({
        keep: z.string(),
        drop: z.string().optional(),
        alsoKeep: z.number(),
        alsoDrop: z.boolean().optional(),
      }),
    );
    expect(obj.type).to.equal('object');
    // Order-independent set comparison of required names.
    expect([...obj.required!].sort()).to.deep.equal(['alsoKeep', 'keep']);
  });

  it('preserves description on an optional field', () => {
    const out = field({ s: z.string().max(10).optional().describe('opt label') }, 's');
    expect(out.description).to.equal('opt label');
    expect(out.maxLength).to.equal(10);
  });

  it('an empty shape produces an object with no required array members', () => {
    const obj = asJson(zodShapeToTypeBox({}));
    expect(obj.type).to.equal('object');
    expect(obj.required ?? []).to.deep.equal([]);
  });
});

describe('zod→TypeBox — REAL case 1: evaluate-gate array-of-nested-object', () => {
  // Mirrors src/tools/evaluate-gate.ts:18-22 exactly.
  const shape: z.ZodRawShape = {
    task: z.string().max(200).describe('The task name of the gate to evaluate'),
    evaluations: z
      .array(
        z.object({
          index: z.number().int().min(0).describe('Zero-based index of the criterion'),
          status: z.enum(['passed', 'failed']).describe('Whether this criterion passed or failed'),
          notes: z.string().max(2000).optional().describe('Optional notes explaining the evaluation'),
        }),
      )
      .min(1)
      .describe('List of criterion evaluations'),
  };

  it('top-level required = [task, evaluations]', () => {
    const obj = asJson(zodShapeToTypeBox(shape, 'evaluate_gate'));
    expect([...obj.required!].sort()).to.deep.equal(['evaluations', 'task']);
  });

  it('evaluations is an array with minItems:1 and a nested object item', () => {
    const evals = asJson(zodShapeToTypeBox(shape)).properties!.evaluations;
    expect(evals.type).to.equal('array');
    expect(evals.minItems).to.equal(1);
    expect(evals.items!.type).to.equal('object');
  });

  it('nested object required = [index, status]; notes is optional', () => {
    const item = asJson(zodShapeToTypeBox(shape)).properties!.evaluations.items!;
    expect([...item.required!].sort()).to.deep.equal(['index', 'status']);
    expect(item.properties).to.have.keys(['index', 'status', 'notes']);
  });

  it('nested field types convert: index→integer(min 0), status→enum, notes→string(maxLength)', () => {
    const item = asJson(zodShapeToTypeBox(shape)).properties!.evaluations.items!;
    expect(item.properties!.index).to.include({ type: 'integer', minimum: 0 });
    expect(item.properties!.status.anyOf!.map((m) => m.const)).to.deep.equal(['passed', 'failed']);
    expect(item.properties!.notes).to.include({ type: 'string', maxLength: 2000 });
  });
});

describe('zod→TypeBox — REAL case 2: restart primitive union', () => {
  // Mirrors src/tools/restart.ts:140-145 (loadFromState).
  const shape: z.ZodRawShape = {
    loadFromState: z
      .union([z.boolean(), z.string().regex(/^[a-z0-9_-]+$/).max(64)])
      .optional()
      .describe('Seed the restarted session with a saved-state slot.'),
  };

  it('loadFromState is optional (not in required)', () => {
    const obj = asJson(zodShapeToTypeBox(shape, 'restart'));
    expect(obj.required ?? []).to.not.include('loadFromState');
  });

  it('converts to an anyOf of [boolean, constrained string], preserving pattern + maxLength', () => {
    const out = asJson(zodShapeToTypeBox(shape)).properties!.loadFromState;
    expect(out.anyOf).to.be.an('array').with.length(2);
    const [boolMember, strMember] = out.anyOf!;
    expect(boolMember).to.deep.equal({ type: 'boolean' });
    expect(strMember).to.include({ type: 'string', maxLength: 64 });
    expect(strMember.pattern).to.equal('^[a-z0-9_-]+$');
  });

  it('carries the union description', () => {
    const out = asJson(zodShapeToTypeBox(shape)).properties!.loadFromState;
    expect(out.description).to.equal('Seed the restarted session with a saved-state slot.');
  });
});

describe('zod→TypeBox — fail-loud on unsupported constructs (D1)', () => {
  const expectThrows = (shape: z.ZodRawShape, tool?: string) =>
    expect(() => zodShapeToTypeBox(shape, tool)).to.throw(UnsupportedZodFeatureError);

  it('throws on .default()', () => {
    expectThrows({ s: z.string().default('x') });
  });

  it('throws on .nullable()', () => {
    expectThrows({ s: z.string().nullable() });
  });

  it('throws on .transform()/.refine() (ZodEffects)', () => {
    expectThrows({ s: z.string().transform((v) => v.trim()) });
    expectThrows({ s: z.string().refine((v) => v.length > 0) });
  });

  it('throws on an unsupported string check (.email)', () => {
    expectThrows({ s: z.string().email() });
  });

  it('throws on an unsupported base type (z.record / z.any / z.date)', () => {
    expectThrows({ r: z.record(z.string()) });
    expectThrows({ a: z.any() });
    expectThrows({ d: z.date() });
  });

  it('throws on union-of-OBJECTS (distinct from the supported primitive union)', () => {
    expectThrows({
      u: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
    });
  });

  it('throws on a union with an array member (non-scalar)', () => {
    expectThrows({ u: z.union([z.string(), z.array(z.string())]) });
  });

  it('error message names the offending tool + field path', () => {
    try {
      zodShapeToTypeBox({ s: z.string().nullable() }, 'my_tool');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UnsupportedZodFeatureError);
      expect((err as Error).message).to.contain('my_tool.s');
    }
  });

  it('names a nested field path on a deep unsupported feature', () => {
    try {
      zodShapeToTypeBox(
        { outer: z.array(z.object({ bad: z.string().default('x') })) },
        'deep_tool',
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).to.contain('deep_tool.outer[].bad');
    }
  });
});
