/**
 * Dialog — wizard frame primitive. PR-E of #389.
 *
 * Caller composes body + footer; Dialog owns the head/body/foot chrome
 * + max-width override (720, vs the `.dialog` default 580 in
 * components.css) + the design's heavier shadow ring.
 *
 * Step counter format `STEP {step} / {total} · {label}` mirrors the
 * design's "STEP 1 / 3 · lineup". Omit `step`/`totalSteps` to hide it.
 */
import type { ReactNode } from 'react';

interface DialogProps {
  /** Display-serif title (e.g. "Recruit a player"). */
  title: string;
  /** 1-indexed current step. Omit to hide the step counter. */
  step?: number;
  /** Total steps. Required when `step` is supplied. */
  totalSteps?: number;
  /** Label for the current step (e.g. "lineup", "review"). */
  stepLabel?: string;
  /** Body content — typically `.field` / `.field-grid-2` / `.picker-list` blocks. */
  children: ReactNode;
  /** Footer content — render `.hint` + Back/Next buttons. */
  footer: ReactNode;
  /** Test surface — forwarded to the dialog root. */
  testId: string;
}

export function Dialog({
  title,
  step,
  totalSteps,
  stepLabel,
  children,
  footer,
  testId,
}: DialogProps) {
  const stepText =
    step !== undefined && totalSteps !== undefined
      ? `STEP ${step} / ${totalSteps}${stepLabel ? ` · ${stepLabel}` : ''}`
      : null;
  return (
    <div
      data-testid={testId}
      className="dialog"
      style={{
        // Design overrides max-width to 720 + adds a heavier shadow + a
        // brighter outline ring on the recruit/create dialogs (per
        // screens.jsx inline style). Override here so callers don't
        // repeat it; `.dialog` defaults to 580 in components.css.
        maxWidth: 720,
        boxShadow:
          '0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px var(--rule-strong)',
      }}
      // Stop scrim's click-outside handler from firing when the user
      // clicks inside the dialog itself.
      onClick={(e) => e.stopPropagation()}
    >
      <div className="dialog-head">
        <div className="dialog-title">{title}</div>
        {stepText && <div className="steps">{stepText}</div>}
      </div>
      <div className="dialog-body">{children}</div>
      <div className="dialog-foot">{footer}</div>
    </div>
  );
}
