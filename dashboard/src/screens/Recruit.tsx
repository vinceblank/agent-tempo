/**
 * Recruit screen — Screen E of the dashboard design (PR-6 of #340).
 *
 * Three-step wizard:
 *   1. **Identity** — player name, optional `part` (one-line role
 *      description shown by `ensemble`).
 *   2. **Spawn config** — agent type (claude / copilot), working dir,
 *      optional initial message.
 *   3. **Review** — summary card + DISABLED submit. Real submit lands
 *      in PR-7 alongside the rest of the safe-write flows.
 *
 * Validation is plain TypeScript (not zod / react-hook-form) — PR-6
 * scope discipline. The submit is disabled regardless of validation,
 * but inline field errors guide the user towards a valid form so PR-7's
 * submit can plug in mechanically.
 *
 * Testability:
 *   - `data-testid="screen-recruit"` on the root
 *   - `data-testid="recruit-wizard-step-${1|2|3}"` per step container
 *   - `data-testid="recruit-input-${field}"` per input
 *   - `data-testid="recruit-back"` / `recruit-next` / `recruit-submit`
 *   - `data-testid="recruit-summary-${field}"` on each review row
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FormField } from '../components/FormField';
import { useRecruitMutation } from '../lib/mutations';
import { logEvent } from '../lib/log';

type AgentType = 'claude' | 'copilot';
const AGENT_TYPES: AgentType[] = ['claude', 'copilot'];

interface FormState {
  name: string;
  part: string;
  agent: AgentType;
  workDir: string;
  initialMessage: string;
}

const INITIAL_FORM: FormState = {
  name: '',
  part: '',
  agent: 'claude',
  workDir: '',
  initialMessage: '',
};

const STEPS = [1, 2, 3] as const;
type StepIndex = (typeof STEPS)[number];

const STEP_LABELS: Record<StepIndex, string> = {
  1: 'Identity',
  2: 'Spawn config',
  3: 'Review',
};

export function Recruit() {
  useEffect(() => { logEvent('screen.opened', { screen: 'recruit' }); }, []);
  const [searchParams] = useSearchParams();
  const ensemble = searchParams.get('ensemble') ?? '';
  const [step, setStep] = useState<StepIndex>(1);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const errors = validate(form);
  const stepErrors = errorsForStep(step, errors);
  const stepValid = stepErrors.length === 0;
  const recruit = useRecruitMutation(ensemble);

  // No `?ensemble=…` — render an empty-state pointing back to Overview.
  // Recruit needs an ensemble to target; without one we'd be cueing a
  // mutation against the empty string. The user typically reaches this
  // screen from a Workspace "Recruit" button (PR-7b adds that link).
  if (!ensemble) {
    return (
      <section
        data-testid="screen-recruit"
        data-state="missing-ensemble"
        style={containerStyle}
      >
        <h1 style={{ margin: 0, fontFamily: 'var(--ff-display)', fontSize: 22, fontWeight: 400 }}>
          Recruit
        </h1>
        <p
          data-testid="recruit-missing-ensemble"
          role="alert"
          className="dim"
          style={{ marginBottom: 0 }}
        >
          Pick an ensemble first. Append <code>?ensemble=&lt;name&gt;</code> to the URL,
          or click "Recruit" from a Workspace.
        </p>
      </section>
    );
  }

  const update = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const goNext = () => {
    if (!stepValid || step === 3) return;
    const next = (step + 1) as StepIndex;
    setStep(next);
    logEvent('recruit-wizard.advance', { from: step, to: next });
  };

  const goBack = () => {
    if (step === 1) return;
    const prev = (step - 1) as StepIndex;
    setStep(prev);
  };

  return (
    <section
      data-testid="screen-recruit"
      style={containerStyle}
    >
      <header>
        <h1 style={{ margin: 0, fontFamily: 'var(--ff-display)', fontSize: 22, fontWeight: 400 }}>
          Recruit
        </h1>
        <p className="dim" style={{ marginTop: 4, fontSize: 13 }}>
          Step {step} of 3 — {STEP_LABELS[step]}. Submit enables in PR-7.
        </p>
      </header>

      <ol
        data-testid="recruit-progress"
        aria-label="Recruit wizard progress"
        style={progressStyle}
      >
        {STEPS.map((s) => (
          <li
            key={s}
            data-testid={`recruit-progress-step-${s}`}
            data-active={s === step}
            style={{
              ...progressItemStyle,
              fontWeight: s === step ? 500 : 400,
              color: s === step ? 'var(--text)' : 'var(--dim)',
            }}
          >
            {s}. {STEP_LABELS[s]}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <fieldset data-testid="recruit-wizard-step-1" style={fieldsetStyle}>
          <FormField
            id="recruit-name" label="Player name"
            testId="recruit-input-name"
            value={form.name} onChange={(v) => update('name', v)}
            placeholder="tempo-soloist-1"
            error={errors.name}
          />
          <FormField
            id="recruit-part" label="Part (optional)"
            testId="recruit-input-part"
            value={form.part} onChange={(v) => update('part', v)}
            placeholder="Implementing the schedules screen"
            error={errors.part}
          />
        </fieldset>
      )}

      {step === 2 && (
        <fieldset data-testid="recruit-wizard-step-2" style={fieldsetStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label htmlFor="recruit-agent" style={labelStyle}>Agent type</label>
            <select
              id="recruit-agent"
              data-testid="recruit-input-agent"
              value={form.agent}
              onChange={(e) => update('agent', e.target.value as AgentType)}
              style={inputStyle}
            >
              {AGENT_TYPES.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <FormField
            id="recruit-workdir" label="Working directory"
            testId="recruit-input-workdir"
            value={form.workDir} onChange={(v) => update('workDir', v)}
            placeholder="/repo/path"
            error={errors.workDir}
          />
          <FormField
            id="recruit-message" label="Initial message (optional)"
            testId="recruit-input-message"
            value={form.initialMessage} onChange={(v) => update('initialMessage', v)}
            placeholder="Read CLAUDE.md and report status."
            multiline
          />
        </fieldset>
      )}

      {step === 3 && (
        <fieldset data-testid="recruit-wizard-step-3" style={fieldsetStyle}>
          <SummaryRow testId="recruit-summary-name" label="Name" value={form.name || '—'} />
          <SummaryRow testId="recruit-summary-part" label="Part" value={form.part || '—'} />
          <SummaryRow testId="recruit-summary-agent" label="Agent" value={form.agent} />
          <SummaryRow testId="recruit-summary-workdir" label="Working dir" value={form.workDir || '—'} />
          <SummaryRow
            testId="recruit-summary-message"
            label="Initial message"
            value={form.initialMessage || '—'}
          />
        </fieldset>
      )}

      <footer style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <button
          type="button"
          data-testid="recruit-back"
          onClick={goBack}
          disabled={step === 1}
          aria-disabled={step === 1}
          style={{ ...buttonStyle, opacity: step === 1 ? 0.5 : 1 }}
        >
          ← Back
        </button>
        {step < 3 ? (
          <button
            type="button"
            data-testid="recruit-next"
            onClick={goNext}
            disabled={!stepValid}
            aria-disabled={!stepValid}
            style={{ ...buttonStyle, opacity: stepValid ? 1 : 0.5 }}
          >
            Next →
          </button>
        ) : (
          <button
            type="button"
            data-testid="recruit-submit"
            disabled={recruit.isPending || errors.name !== null || errors.workDir !== null}
            aria-disabled={recruit.isPending || errors.name !== null || errors.workDir !== null}
            onClick={() => {
              recruit.mutate(
                {
                  name: form.name,
                  workDir: form.workDir,
                  agent: form.agent,
                  ...(form.initialMessage ? { initialMessage: form.initialMessage } : {}),
                },
                {
                  onSuccess: () => {
                    setForm(INITIAL_FORM);
                    setStep(1);
                  },
                },
              );
            }}
            style={{
              ...buttonStyle,
              background: 'var(--accent)',
              color: 'var(--accent-ink)',
              opacity: recruit.isPending ? 0.6 : 1,
            }}
          >
            {recruit.isPending ? 'Recruiting…' : 'Recruit player'}
          </button>
        )}
      </footer>
    </section>
  );
}

interface FieldErrors {
  name: string | null;
  part: string | null;
  workDir: string | null;
}

function validate(form: FormState): FieldErrors {
  return {
    name: validatePlayerName(form.name),
    part: form.part.length > 200 ? 'Too long (≤200 chars)' : null,
    workDir: form.workDir.length === 0 ? 'Required' : null,
  };
}

function errorsForStep(step: StepIndex, errors: FieldErrors): string[] {
  if (step === 1) return [errors.name, errors.part].filter(isNonNull);
  if (step === 2) return [errors.workDir].filter(isNonNull);
  return [];
}

function isNonNull(v: string | null): v is string {
  return v !== null;
}

function validatePlayerName(name: string): string | null {
  if (name.length === 0) return 'Required';
  if (name.length > 64) return 'Too long (≤64 chars)';
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return 'Letters, digits, underscores, dashes only';
  return null;
}

function SummaryRow({ testId, label, value }: { testId: string; label: string; value: string }) {
  return (
    <div data-testid={testId} style={{ display: 'flex', gap: 12, fontSize: 13 }}>
      <span className="dim" style={{ minWidth: 120 }}>{label}</span>
      <span style={{ fontFamily: 'var(--ff-mono)', flex: 1, wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
  padding: 'var(--density-pad)',
  background: 'var(--bg-1)',
  border: '1px solid var(--rule)',
  borderRadius: 8,
  maxWidth: 540,
};
const progressStyle: React.CSSProperties = {
  display: 'flex', gap: 20, listStyle: 'none', padding: 0, margin: 0,
  fontFamily: 'var(--ff-mono)', fontSize: 12,
};
const progressItemStyle: React.CSSProperties = {
  textTransform: 'uppercase', letterSpacing: '0.05em',
};
const fieldsetStyle: React.CSSProperties = {
  border: 'none', padding: 0, margin: 0,
  display: 'flex', flexDirection: 'column', gap: 12,
};
const labelStyle: React.CSSProperties = { fontFamily: 'var(--ff-display)', fontSize: 14 };
const inputStyle: React.CSSProperties = {
  background: 'var(--bg-2)', color: 'var(--text)',
  border: '1px solid var(--rule)', borderRadius: 6,
  padding: '8px 10px', fontFamily: 'var(--ff-mono)', fontSize: 14,
};
const buttonStyle: React.CSSProperties = {
  background: 'var(--bg-2)', border: '1px solid var(--rule)', borderRadius: 6,
  padding: '6px 14px', fontFamily: 'var(--ff-display)', fontSize: 14,
  color: 'var(--text)', cursor: 'pointer',
};
