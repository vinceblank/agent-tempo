/**
 * Execution-contract regression for renderToPi (src/pi/render-tools.ts).
 *
 * Pi invokes a registered tool's `execute` POSITIONALLY:
 *   execute(toolCallId, params, signal?, onUpdate?, ctx?)
 * (installed Pi 0.78 `core/extensions/types.d.ts:354` + the wrapper at
 * `core/tools/tool-definition-wrapper.js:10,31`). The VALIDATED params object is
 * the SECOND positional. The v1.4.0 bug read the FIRST positional, handing the
 * descriptor handler the `toolCallId` STRING instead of the params object →
 * validation failure / garbage for every native agent-tempo tool a Pi model
 * invokes (report/cue/recall/ensemble/save_state/…).
 *
 * The type gate CANNOT catch this (a 1-arg fn is assignable to the N-arg slot,
 * which is exactly what masked the bug), so this runtime-call test is the guard.
 * It also corroborates that our registration path uses Pi's positional convention.
 *
 * Pure: no Pi runtime — drives renderToPi against a fake ExtensionAPI + a
 * recording descriptor handler.
 */
import { expect } from 'chai';
import { z } from 'zod';
import { renderToPi } from '../src/pi/render-tools';
import type { TempoToolDescriptor } from '../src/tools/descriptor';
import type { ExtensionAPI, PiToolDefinition } from '../src/pi/pi-types';

describe('renderToPi — execute arg-order contract (v1.4.1 regression)', () => {
  it('passes the 2nd positional (params), NOT the toolCallId, to the descriptor handler', async () => {
    let received: unknown = Symbol('unset');
    const descriptor: TempoToolDescriptor = {
      name: 'demo',
      description: 'demo tool',
      params: { real: z.string() },
      handler: async (args) => {
        received = args;
        return { text: 'ok' };
      },
    };

    const registered: PiToolDefinition[] = [];
    const fakePi: ExtensionAPI = {
      on: () => {},
      registerTool: (def) => {
        registered.push(def);
      },
    };

    renderToPi(fakePi, [descriptor]);
    expect(registered, 'one tool registered').to.have.length(1);

    // Pi invokes execute POSITIONALLY: (toolCallId, params, signal, onUpdate, ctx).
    const result = await registered[0].execute('tc-1', { real: 'params' }, undefined, undefined, undefined);

    // The handler must receive the PARAMS object — never the toolCallId string.
    expect(received).to.deep.equal({ real: 'params' });
    expect(received, 'must not be the toolCallId').to.not.equal('tc-1');
    // And the neutral handler result maps onto Pi's { output } shape.
    expect(result).to.deep.equal({ output: 'ok' });
  });

  it('maps an isError handler result onto Pi { output, isError }', async () => {
    const descriptor: TempoToolDescriptor = {
      name: 'demo',
      description: 'demo tool',
      params: { real: z.string() },
      handler: async () => ({ text: 'boom', isError: true }),
    };
    const registered: PiToolDefinition[] = [];
    const fakePi: ExtensionAPI = { on: () => {}, registerTool: (def) => { registered.push(def); } };

    renderToPi(fakePi, [descriptor]);
    const result = await registered[0].execute('tc-2', { real: 'x' }, undefined, undefined, undefined);
    expect(result).to.deep.equal({ output: 'boom', isError: true });
  });
});
