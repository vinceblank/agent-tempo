/**
 * Unit tests for `src/utils/search-attributes.ts`.
 *
 * Covers the primitive string/bool readers and the typed wrappers for the
 * three claude-tempo custom attributes. Pure logic — no Temporal SDK, no
 * TestWorkflowEnvironment. Runs in milliseconds.
 */
import { expect } from 'chai';
import {
  getSearchAttrString,
  getSearchAttrBool,
  getAttachmentPhase,
  getEnsembleName,
  getIsConductor,
  type SearchAttributeCarrier,
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
  it('reads canonical AttachmentPhase values from ClaudeTempoAttachmentState', function () {
    for (const phase of [
      'booting', 'attached', 'processing', 'awaiting', 'draining', 'detached', 'gone',
    ]) {
      expect(getAttachmentPhase(carrier('ClaudeTempoAttachmentState', [phase]))).to.equal(phase);
    }
  });

  it('returns undefined when the attribute is absent', function () {
    expect(getAttachmentPhase({})).to.be.undefined;
    expect(getAttachmentPhase(carrier('ClaudeTempoAttachmentState', []))).to.be.undefined;
  });

  it('ignores other search attributes', function () {
    expect(getAttachmentPhase(carrier('ClaudeTempoEnsemble', ['e1']))).to.be.undefined;
  });
});

describe('getEnsembleName', function () {
  it('reads a string value from ClaudeTempoEnsemble', function () {
    expect(getEnsembleName(carrier('ClaudeTempoEnsemble', ['tempo-impl']))).to.equal('tempo-impl');
  });

  it('returns undefined when the attribute is missing', function () {
    expect(getEnsembleName({})).to.be.undefined;
    expect(getEnsembleName(carrier('ClaudeTempoEnsemble', undefined))).to.be.undefined;
  });

  it('ignores other search attributes', function () {
    expect(getEnsembleName(carrier('ClaudeTempoAttachmentState', ['attached']))).to.be.undefined;
  });
});

describe('getIsConductor', function () {
  it('returns true for native true from ClaudeTempoIsConductor', function () {
    expect(getIsConductor(carrier('ClaudeTempoIsConductor', [true]))).to.equal(true);
  });

  it('returns false for native false', function () {
    expect(getIsConductor(carrier('ClaudeTempoIsConductor', [false]))).to.equal(false);
  });

  it('returns undefined when absent (caller falls back to workflow-id convention)', function () {
    expect(getIsConductor({})).to.be.undefined;
    expect(getIsConductor(carrier('ClaudeTempoIsConductor', []))).to.be.undefined;
  });

  it('tolerates string "true" / "false" shapes', function () {
    expect(getIsConductor(carrier('ClaudeTempoIsConductor', ['true']))).to.equal(true);
    expect(getIsConductor(carrier('ClaudeTempoIsConductor', ['false']))).to.equal(false);
  });
});

describe('multi-attribute carriers', function () {
  // Exercises the real-world shape: WorkflowExecutionInfo with several
  // attributes set simultaneously. Each typed wrapper must pull its own
  // attribute cleanly and ignore the others.
  it('each typed wrapper reads its own attribute independently', function () {
    const wf: SearchAttributeCarrier = {
      searchAttributes: {
        ClaudeTempoEnsemble: ['tempo-impl'],
        ClaudeTempoIsConductor: [true],
        ClaudeTempoAttachmentState: ['attached'],
        UnrelatedAttr: ['noise'],
      },
    };
    expect(getEnsembleName(wf)).to.equal('tempo-impl');
    expect(getIsConductor(wf)).to.equal(true);
    expect(getAttachmentPhase(wf)).to.equal('attached');
  });
});
