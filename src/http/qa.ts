/**
 * Daemon Q&A routes (#700 P2) — the planner→player ask/answer surface.
 *
 *   POST /v1/ensembles/:e/ask    { target, question, questionId }  → 202
 *   GET  /v1/ensembles/:e/answer/:questionId                        → 200 { answer }
 *
 * The command-center planner has no Temporal inbox, so it asks a player a
 * CORRELATED question (caller-supplied `questionId`): the daemon cues the
 * target with a `[Q <questionId>]` marker + a "respond via `respond`"
 * instruction, registers the ask with the {@link AggregateRunner} (which polls
 * `getAnswer` and emits the `answer` SSE event on resolve), and returns
 * immediately. The planner reads the answer back via the GET route (or is woken
 * by the `answer` event). See §4 / §7B of the command-center design.
 *
 * Auth (gated by the caller in server.ts): `ask` is a write (Tier 2);
 * `answer` is a read (Tier 1 / loopback).
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { TempoClient } from '../client/interface';
import type { AggregateRunner } from './aggregate';
import { errorResponse, jsonResponse } from './responses';
import {
  readJsonBody,
  BODY_TOO_LARGE,
  BODY_INVALID_JSON,
  WRITE_BODY_MAX,
  stringField,
} from './body';
import {
  MESSAGE_MAX,
  QUESTION_ID_MAX,
  QUESTION_ID_REGEX,
  validateEnsembleName,
  validatePlayerName,
} from '../utils/validation';

/** A `questionId` is non-empty, ≤ cap, and URL/path-safe (rides a cue marker + a GET segment). */
export function isValidQuestionId(q: string | undefined): q is string {
  return typeof q === 'string' && q.length > 0 && q.length <= QUESTION_ID_MAX && QUESTION_ID_REGEX.test(q);
}

/** Build the cue body delivered to the target — the `[Q id]` marker + respond instruction. */
export function buildAskCue(questionId: string, question: string): string {
  return (
    `[Q ${questionId}] ${question}\n\n` +
    '(Answer with the `respond` tool: ' +
    `respond({ questionId: "${questionId}", text: "<your answer>" }). ` +
    "A plain reply won't reach the asker — it's the inbox-less command-center planner.)"
  );
}

/** POST /v1/ensembles/:e/ask — cue the target with a correlated question + track the ask. */
export async function handleAsk(
  req: IncomingMessage,
  res: ServerResponse,
  client: TempoClient,
  // Nullable: a daemon without an aggregate (PR-1/tests) still cues + 202s; the
  // answer is then read-only via the GET route (no SSE wake without the tracker).
  runner: AggregateRunner | null,
  ensemble: string,
): Promise<void> {
  if (validateEnsembleName(ensemble) !== null) {
    return errorResponse(res, 400, { error: 'invalid-ensemble-name', ensemble });
  }
  const body = await readJsonBody(req);
  if (body === BODY_TOO_LARGE) return errorResponse(res, 413, { error: 'body-too-large', limit: WRITE_BODY_MAX });
  if (body === BODY_INVALID_JSON) return errorResponse(res, 400, { error: 'invalid-json' });

  const target = stringField(body, 'target');
  const question = stringField(body, 'question');
  const questionId = stringField(body, 'questionId');
  if (!target) return errorResponse(res, 400, { error: 'missing-field', field: 'target' });
  if (!question) return errorResponse(res, 400, { error: 'missing-field', field: 'question' });
  if (!questionId) return errorResponse(res, 400, { error: 'missing-field', field: 'questionId' });
  if (validatePlayerName(target) !== null) {
    return errorResponse(res, 400, { error: 'invalid-player-name', field: 'target' });
  }
  if (!isValidQuestionId(questionId)) {
    return errorResponse(res, 400, { error: 'invalid-question-id', field: 'questionId' });
  }
  if (question.length > MESSAGE_MAX) {
    return errorResponse(res, 413, { error: 'question-too-long', limit: MESSAGE_MAX });
  }

  try {
    // Cue the target through the maestro outbox (operator-sourced, like the
    // dashboard `/cue` route) so the chat row is attributed to the operator.
    await client.ensureMaestroSession(ensemble);
    await client.sendAsMaestro(ensemble, target, buildAskCue(questionId, question));
    runner?.trackAsk(ensemble, questionId);
    jsonResponse(res, 202, { ok: true, ensemble, target, questionId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no session found|no maestro|workflow not found/i.test(message)) {
      return errorResponse(res, 404, { error: 'session-not-found', ensemble, detail: message });
    }
    return errorResponse(res, 500, { error: 'ask-failed', ensemble, detail: message });
  }
}

/** GET /v1/ensembles/:e/answer/:questionId — proxy the maestro Q&A mailbox read. */
export async function handleAnswer(
  res: ServerResponse,
  client: TempoClient,
  ensemble: string,
  questionId: string,
): Promise<void> {
  if (validateEnsembleName(ensemble) !== null) {
    return errorResponse(res, 400, { error: 'invalid-ensemble-name', ensemble });
  }
  if (!isValidQuestionId(questionId)) {
    return errorResponse(res, 400, { error: 'invalid-question-id', questionId });
  }
  // `getAnswer` tolerates hub-not-running / not-answered-yet → null; it doesn't
  // throw for those, so a thrown error here is a genuine failure.
  try {
    const answer = await client.getAnswer(ensemble, questionId);
    jsonResponse(res, 200, { ok: true, ensemble, questionId, answered: answer !== null, answer });
  } catch (err) {
    return errorResponse(res, 500, {
      error: 'answer-failed', ensemble, questionId,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
