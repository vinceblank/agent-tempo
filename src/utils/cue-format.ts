/**
 * Cue-delivery formatting helpers (#53).
 *
 * A planner question is delivered to a player as a normal cue whose BODY already
 * carries a `[Q <questionId>]` correlation marker (built by
 * `src/http/qa.ts` `buildAskCue`). Each adapter then ALSO wraps every incoming
 * cue in its own "from" envelope (Pi `[cue from <from>] …`, claude-api /
 * claude-code-headless `[from <from>]: …`, copilot `[Message from <from>]: …`).
 * For a question that produces a DOUBLED prefix the player sees as e.g.
 * `[cue from maestro] [Q abc123] <question>`.
 *
 * {@link consolidateQuestionCue} collapses that into a SINGLE header for question
 * cues ONLY — normal cues keep their existing per-adapter envelope (the caller
 * falls back to it when this returns `null`). Pure + dependency-light so it
 * unit-tests without any adapter / Pi SDK.
 */
import { QUESTION_ID_REGEX } from './validation';

/**
 * Leading `[Q <id>] ` correlation marker that `qa.ts` `buildAskCue` prepends.
 * Group 1 = the questionId (validated against {@link QUESTION_ID_REGEX});
 * group 2 = the remaining body (the question + the `respond` instruction).
 */
const QUESTION_CUE_MARKER = /^\[Q ([^\]\s]+)\] ([\s\S]*)$/;

/**
 * #53 — if `text` is a planner-question cue (starts with the `[Q <id>]` marker),
 * return the CONSOLIDATED single-header delivery form; otherwise return `null`
 * (the caller then uses its normal per-adapter cue envelope, unchanged).
 *
 * Consolidated form — one header line, then the body below:
 *
 *   [Q <id> · from <asker>]
 *   <question>
 *
 *   (Answer with the `respond` tool: …)
 *
 * The questionId is kept in the header for at-a-glance respond-correlation (it
 * also remains in the `respond({ questionId: … })` instruction in the body, so
 * correlation is never lost). `from` is the cue's sender (the operator/planner
 * attribution — `maestro` for planner asks via `sendAsMaestro`); a missing/empty
 * `from` falls back to `planner`.
 *
 * NOTE (#53): the exact header punctuation + the `from` label are pending a
 * product confirm (vinceblank) — they live ONLY in the return expression below,
 * so finalizing is a one-line change.
 */
export function consolidateQuestionCue(from: string | undefined, text: string): string | null {
  const m = QUESTION_CUE_MARKER.exec(text);
  if (!m) return null;
  const id = m[1];
  const body = m[2];
  if (!QUESTION_ID_REGEX.test(id)) return null; // a normal cue that merely starts with "[Q …]" — leave it
  const asker = from && from.length > 0 ? from : 'planner';
  return `[Q ${id} · from ${asker}]\n${body}`;
}
