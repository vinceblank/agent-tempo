/**
 * `respond` — answer a correlated question from the command-center planner
 * (#700 P2). The planner (an interactive Pi session) has no Temporal inbox, so
 * it routes questions through maestro keyed by a `questionId` and reads the
 * answer back. When a player receives a cue tagged `[Q <questionId>]`, it
 * replies with this tool; the answer is parked on the ensemble's maestro state
 * (the Q&A mailbox) for the planner to redeem.
 *
 * Like `coat_check_*`, this writes DIRECTLY to the maestro handle
 * (`executeUpdate`) — a shared-store write, NOT a peer-workflow signal — so the
 * outbox invariant is untouched. Audit identity (`from`) is set from
 * `getPlayerId()`; there is no spoofable `from` arg on the schema.
 */
import { z } from 'zod';
import { Client } from '@temporalio/client';
import { Config, maestroWorkflowId } from '../config';
import { maestroPostAnswerUpdate } from '../workflows/maestro-signals';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { MESSAGE_MAX, QUESTION_ID_MAX, QUESTION_ID_REGEX } from '../utils/validation';

export function buildRespondTool(
  client: Client,
  config: Config,
  getPlayerId: () => string,
): TempoToolDescriptor {
  return {
    name: 'respond',
    description: `Answer a correlated question from the command-center planner (#700). When you receive a cue tagged \`[Q <questionId>]\`, reply with this tool: pass that \`questionId\` and your answer \`text\`. The answer is parked on the ensemble's maestro for the planner to read back — the planner has no inbox of its own, so a plain \`cue\` reply won't reach it. (For normal player-to-player messages use \`cue\`; \`respond\` is specifically for answering a tagged \`[Q …]\` question.)`,
    params: {
      questionId: z.string().min(1).max(QUESTION_ID_MAX).regex(QUESTION_ID_REGEX).describe(
        'The correlation id from the `[Q <questionId>]` tag on the question cue. Copy it exactly.',
      ),
      text: z.string().min(1).max(MESSAGE_MAX).describe('Your answer to the question.'),
    },
    handler: async (args) => {
      const { questionId, text } = args as { questionId: string; text: string };
      const from = getPlayerId();
      try {
        const handle = client.workflow.getHandle(maestroWorkflowId(config.ensemble));
        await handle.executeUpdate(maestroPostAnswerUpdate, {
          args: [{ questionId, from, text }],
        });
        return ok(`Answer recorded for question ${questionId}.`);
      } catch (err) {
        return fail(`Failed to record answer: ${formatError(err)}`);
      }
    },
  };
}
