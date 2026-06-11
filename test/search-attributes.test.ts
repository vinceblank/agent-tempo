/**
 * Unit tests for `src/utils/search-attributes.ts`.
 *
 * Covers the primitive string/bool readers and the typed wrappers for the
 * three agent-tempo custom attributes. Pure logic — no Temporal SDK, no
 * TestWorkflowEnvironment. Runs in milliseconds.
 */
import { expect } from 'chai';
import {
  getSearchAttrString,
  getSearchAttrBool,
  getAttachmentPhase,
  getEnsembleName,
  getIsConductor,
  getMemoString,
  getMemoBool,
  getWorkflowMetaString,
  getWorkflowMetaBool,
  getPlayerType,
  getPart,
  type SearchAttributeCarrier,
  type WorkflowMetaCarrier,
} from '../src/utils/search-attributes';

/** Build a carrier with a single named attribute. */
function carrier(
  name: string,
  value: unknown[] | undefined,
): SearchAttributeCarrier {
  return { searchAttributes: { [name]: value } };
}

describe('getSearchAttrString', function () {
  it('returns first element when attribute is a non-empty string array', function () {
    expect(getSearchAttrString(carrier('Foo', ['hello']), 'Foo')).to.equal('hello');
  });

  it('returns first element even when array has multiple values', function () {
    expect(getSearchAttrString(carrier('Foo', ['a', 'b', 'c']), 'Foo')).to.equal('a');
  });

  it('returns undefined when the carrier has no searchAttributes', function () {
    expect(getSearchAttrString({}, 'Foo')).to.be.undefined;
  });

  it('returns undefined when the named attribute is absent', function () {
    expect(getSearchAttrString(carrier('Other', ['x']), 'Foo')).to.be.undefined;
  });

  it('returns undefined when the attribute is explicitly undefined', function () {
    expect(getSearchAttrString(carrier('Foo', undefined), 'Foo')).to.be.undefined;
  });

  it('returns undefined when the attribute is an empty array', function () {
    expect(getSearchAttrString(carrier('Foo', []), 'Foo')).to.be.undefined;
  });

  it('coerces non-string first elements via String(v) (legacy behaviour)', function () {
    // Matches the pre-extraction inline pattern `String(vals[0])`.
    expect(getSearchAttrString(carrier('Foo', [42]), 'Foo')).to.equal('42');
    expect(getSearchAttrString(carrier('Foo', [true]), 'Foo')).to.equal('true');
  });
});

describe('getSearchAttrBool', function () {
  it('returns true for native boolean true', function () {
    expect(getSearchAttrBool(carrier('Flag', [true]), 'Flag')).to.equal(true);
  });

  it('returns false for native boolean false', function () {
    expect(getSearchAttrBool(carrier('Flag', [false]), 'Flag')).to.equal(false);
  });

  it('tolerates string "true" (SDK shape tolerance)', function () {
    expect(getSearchAttrBool(carrier('Flag', ['true']), 'Flag')).to.equal(true);
  });

  it('tolerates string "false"', function () {
    expect(getSearchAttrBool(carrier('Flag', ['false']), 'Flag')).to.equal(false);
  });

  it('returns undefined for other string values (not truthy/falsy coerced)', function () {
    expect(getSearchAttrBool(carrier('Flag', ['yes']), 'Flag')).to.be.undefined;
    expect(getSearchAttrBool(carrier('Flag', ['1']), 'Flag')).to.be.undefined;
  });

  it('returns undefined for non-boolean, non-string values', function () {
    expect(getSearchAttrBool(carrier('Flag', [1]), 'Flag')).to.be.undefined;
    expect(getSearchAttrBool(carrier('Flag', [null]), 'Flag')).to.be.undefined;
  });

  it('returns undefined when attribute is missing', function () {
    expect(getSearchAttrBool({}, 'Flag')).to.be.undefined;
    expect(getSearchAttrBool(carrier('Flag', []), 'Flag')).to.be.undefined;
  });
});

describe('getAttachmentPhase', function () {
  it('reads canonical AttachmentPhase values from AgentTempoAttachmentState', function () {
    for (const phase of [
      'booting', 'attached', 'processing', 'awaiting', 'draining', 'detached', 'gone',
    ]) {
      expect(getAttachmentPhase(carrier('AgentTempoAttachmentState', [phase]))).to.equal(phase);
    }
  });

  it('returns undefined when the attribute is absent', function () {
    expect(getAttachmentPhase({})).to.be.undefined;
    expect(getAttachmentPhase(carrier('AgentTempoAttachmentState', []))).to.be.undefined;
  });

  it('ignores other search attributes', function () {
    expect(getAttachmentPhase(carrier('AgentTempoEnsemble', ['e1']))).to.be.undefined;
  });
});

describe('getEnsembleName', function () {
  it('reads a string value from AgentTempoEnsemble', function () {
    expect(getEnsembleName(carrier('AgentTempoEnsemble', ['tempo-impl']))).to.equal('tempo-impl');
  });

  it('returns undefined when the attribute is missing', function () {
    expect(getEnsembleName({})).to.be.undefined;
    expect(getEnsembleName(carrier('AgentTempoEnsemble', undefined))).to.be.undefined;
  });

  it('ignores other search attributes', function () {
    expect(getEnsembleName(carrier('AgentTempoAttachmentState', ['attached']))).to.be.undefined;
  });
});

describe('getIsConductor', function () {
  it('returns true for native true from AgentTempoIsConductor', function () {
    expect(getIsConductor(carrier('AgentTempoIsConductor', [true]))).to.equal(true);
  });

  it('returns false for native false', function () {
    expect(getIsConductor(carrier('AgentTempoIsConductor', [false]))).to.equal(false);
  });

  it('returns undefined when absent (caller falls back to workflow-id convention)', function () {
    expect(getIsConductor({})).to.be.undefined;
    expect(getIsConductor(carrier('AgentTempoIsConductor', []))).to.be.undefined;
  });

  it('tolerates string "true" / "false" shapes', function () {
    expect(getIsConductor(carrier('AgentTempoIsConductor', ['true']))).to.equal(true);
    expect(getIsConductor(carrier('AgentTempoIsConductor', ['false']))).to.equal(false);
  });
});

// ── T0.5 (#747) — memo readers + dual-read (memo preferred, SA fallback) ──

describe('getMemoString / getMemoBool', function () {
  it('reads typed memo values', function () {
    const wf: WorkflowMetaCarrier = {
      memo: { S: 'val', B: true, N: 42 },
    };
    expect(getMemoString(wf, 'S')).to.equal('val');
    expect(getMemoBool(wf, 'B')).to.equal(true);
  });

  it('returns undefined for absent memo, absent key, or wrong type', function () {
    expect(getMemoString({}, 'S')).to.be.undefined;
    expect(getMemoString({ memo: {} }, 'S')).to.be.undefined;
    expect(getMemoString({ memo: { S: 42 } }, 'S')).to.be.undefined;
    expect(getMemoBool({ memo: { B: 'true' } }, 'B')).to.be.undefined;
  });
});

describe('dual-read (memo preferred, SA fallback)', function () {
  it('prefers the memo value when both are present', function () {
    const wf: WorkflowMetaCarrier = {
      memo: { AgentTempoPlayerType: 'from-memo' },
      searchAttributes: { AgentTempoPlayerType: ['from-sa'] },
    };
    expect(getWorkflowMetaString(wf, 'AgentTempoPlayerType')).to.equal('from-memo');
    expect(getPlayerType(wf)).to.equal('from-memo');
  });

  it('falls back to the legacy SA for pre-v1.8 runs (no memo)', function () {
    const wf: WorkflowMetaCarrier = {
      searchAttributes: { AgentTempoPlayerType: ['tempo-soloist'] },
    };
    expect(getPlayerType(wf)).to.equal('tempo-soloist');
  });

  it('boolean dual-read: memo false is NOT clobbered by SA true', function () {
    // `false` is a legitimate memo value — the `??` chain must not skip it.
    const wf: WorkflowMetaCarrier = {
      memo: { AgentTempoIsConductor: false },
      searchAttributes: { AgentTempoIsConductor: [true] },
    };
    expect(getWorkflowMetaBool(wf, 'AgentTempoIsConductor')).to.equal(false);
    expect(getIsConductor(wf)).to.equal(false);
  });

  it('getIsConductor falls back to the legacy SA', function () {
    expect(getIsConductor({ searchAttributes: { AgentTempoIsConductor: [true] } }))
      .to.equal(true);
  });

  it('returns undefined when both carriers are empty', function () {
    expect(getPlayerType({})).to.be.undefined;
    expect(getIsConductor({})).to.be.undefined;
  });
});

describe('getPart (memo-only — part was never an SA)', function () {
  it('reads AgentTempoPart from the memo', function () {
    expect(getPart({ memo: { AgentTempoPart: 'fixing things' } })).to.equal('fixing things');
  });

  it('has NO SA fallback — pre-v1.8 runs return undefined (caller uses the getPart query)', function () {
    expect(getPart({ searchAttributes: { AgentTempoPart: ['sa-shaped'] } })).to.be.undefined;
    expect(getPart({})).to.be.undefined;
  });
});

describe('multi-attribute carriers', function () {
  // Exercises the real-world shape: WorkflowExecutionInfo with several
  // attributes set simultaneously. Each typed wrapper must pull its own
  // attribute cleanly and ignore the others.
  it('each typed wrapper reads its own attribute independently', function () {
    const wf: SearchAttributeCarrier = {
      searchAttributes: {
        AgentTempoEnsemble: ['tempo-impl'],
        AgentTempoIsConductor: [true],
        AgentTempoAttachmentState: ['attached'],
        UnrelatedAttr: ['noise'],
      },
    };
    expect(getEnsembleName(wf)).to.equal('tempo-impl');
    expect(getIsConductor(wf)).to.equal(true);
    expect(getAttachmentPhase(wf)).to.equal('attached');
  });
});
