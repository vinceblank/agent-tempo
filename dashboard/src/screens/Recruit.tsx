/**
 * Recruit wizard — PR-E of #389. 4-step modal:
 *
 *   1. **Identity** — player name + part (one-line role)
 *   2. **Type** — PLAYER-TYPE picker-list (8 hardcoded shipped types)
 *      + AGENT field (claude/copilot, defaults to claude)
 *   3. **Spawn** — work dir + host (select from `useHosts`) + opening task
 *      (textarea) + options chipset
 *   4. **Review** — summary + submit
 *
 * Source: `screens.jsx:RecruitWizard` (lines 193-258) + audit doc § PR-E.
 *
 * Q3 lock-in: PLAYER-TYPE (which ensemble role — tempo-soloist, etc.) is
 * a SEPARATE concept from AGENT (which adapter — claude / copilot).
 * Earlier PR conflated them. The picker-list selects type; the agent
 * field picks the execution adapter.
 *
 * Wire-gaps:
 *   - `/v1/agent-types` doesn't exist on the daemon yet → player-types
 *     are hardcoded fallbacks from `lib/static-catalog.ts` (the 8 types
 *     shipped under `examples/agents/`).
 *
 * Entry: `/recruit?ensemble=<name>` — preserves the existing query-param
 * contract used by Workspace's "+ Recruit" links (page-actions toolbar
 * + roster panel). Closing the modal navigates back via history; if
 * there's no history (deep-link entry), falls back to the ensemble
 * workspace.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { AgentTypeRow } from '../lib/client';
import { Btn } from '../components/Btn';
import { ModalShell } from '../components/wizard/ModalShell';
import { Dialog } from '../components/wizard/Dialog';
import { PickerList, type PickerOption } from '../components/wizard/PickerList';
import { Chipset } from '../components/wizard/Chipset';
import { Field } from '../components/wizard/Field';
import { SummaryRow } from '../components/wizard/SummaryRow';
import { useAgentTypes, useHosts } from '../lib/queries';
import { useRecruitMutation } from '../lib/mutations';
import { logEvent } from '../lib/log';
import { SHIPPED_PLAYER_TYPES } from '../lib/static-catalog';

type Step = 1 | 2 | 3 | 4;
type AgentType = 'claude' | 'copilot';

interface FormState {
  name: string;
  part: string;
  playerType: string;
  agent: AgentType;
  workDir: string;
  host: string;
  initialMessage: string;
  worktree: boolean;
  hold: boolean;
}

const STEP_LABELS: Record<Step, string> = {
  1: 'identity',
  2: 'type',
  3: 'spawn',
  4: 'review',
};

const PLAYER_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
const PLAYER_NAME_MAX = 64;

const AGENT_OPTIONS: AgentType[] = ['claude', 'copilot'];

/** Replaces the design's `<fieldset>` step grouping — pure layout
 * stack, no semantic value (no legend, no native fieldset behaviour). */
const STEP_CONTAINER_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

export function Recruit() {
  useEffect(() => {
    logEvent('screen.opened', { screen: 'recruit' });
  }, []);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const ensemble = searchParams.get('ensemble') ?? '';
  const hostsQuery = useHosts();
  const agentTypesQuery = useAgentTypes();
  const recruit = useRecruitMutation(ensemble);

  // Live wire from `/v1/agent-types` (#400). Eagerly falls back to the
  // bundled SHIPPED_PLAYER_TYPES while the query loads (and on error)
  // so the picker is always populated — no skeleton state, no
  // empty-default-then-flash. The wire data swaps in once it resolves
  // and the user sees any project/user types they have on disk.
  const playerTypes: ReadonlyArray<AgentTypeRow> = agentTypesQuery.data
    ?? SHIPPED_PLAYER_TYPES;

  const [step, setStep] = useState<Step>(1);
  const [form, setForm] = useState<FormState>(() => ({
    name: '',
    part: '',
    // Default to the first shipped player-type — eager fallback means
    // the picker is always valid on initial render. The wire-loaded
    // catalog (which may include project/user types) swaps in via the
    // `playerTypes` derivation; the form value stays sticky once the
    // user has interacted.
    playerType: SHIPPED_PLAYER_TYPES[0]?.name ?? '',
    agent: 'claude',
    workDir: '',
    host: '',
    initialMessage: '',
    worktree: false,
    hold: false,
  }));

  // Default-fill the host once the query resolves; user-picked values stick.
  useEffect(() => {
    if (!form.host && hostsQuery.data && hostsQuery.data.length > 0) {
      setForm((prev) => ({ ...prev, host: hostsQuery.data![0].hostname }));
    }
  }, [form.host, hostsQuery.data]);

  // Modal close — back if we have history, else fallback to the workspace.
  const close = () => {
    if (window.history.length > 1) navigate(-1);
    else if (ensemble) navigate(`/ensemble/${encodeURIComponent(ensemble)}`);
    else navigate('/');
  };

  const nameError = validatePlayerName(form.name);
  const partError = form.part.length > 200 ? 'Too long (≤200 chars)' : null;
  const workDirError = form.workDir.length === 0 ? 'Required' : null;

  const stepValid =
    (step === 1 && nameError === null && partError === null) ||
    (step === 2 && form.playerType.length > 0) ||
    (step === 3 && workDirError === null) ||
    step === 4;

  const submitDisabled =
    recruit.isPending ||
    nameError !== null ||
    workDirError !== null ||
    form.playerType.length === 0;

  const goNext = () => {
    if (step === 4 || !stepValid) return;
    const next = (step + 1) as Step;
    setStep(next);
    logEvent('recruit-wizard.advance', { from: step, to: next });
  };

  const goBack = () => {
    if (step === 1) return;
    setStep((step - 1) as Step);
  };

  const onSubmit = () => {
    if (submitDisabled) return;
    recruit.mutate(
      {
        name: form.name,
        workDir: form.workDir,
        agent: form.agent,
        playerType: form.playerType,
        ...(form.host ? { host: form.host } : {}),
        ...(form.initialMessage ? { initialMessage: form.initialMessage } : {}),
        ...(form.hold ? { held: true } : {}),
      },
      { onSuccess: () => close() },
    );
  };

  // Picker rows derived from the live wire `useAgentTypes()` data (or
  // its SHIPPED_PLAYER_TYPES fallback). Memoised on the array identity
  // so the picker doesn't churn on TanStack refetches. Lifted above
  // the missing-ensemble early-return to keep hook order stable.
  const playerTypeOptions = useMemo<PickerOption[]>(
    () =>
      playerTypes.map((t) => ({
        value: t.name,
        name: t.name,
        ...(t.description !== undefined && { desc: t.description }),
        right: (
          <span className="mono dim" style={{ fontSize: 10 }}>
            {t.source.toUpperCase()}
          </span>
        ),
      })),
    [playerTypes],
  );

  // Without an ensemble we can't recruit — render an inline alert
  // pointing the user back to the Workspace, where the "+ Recruit"
  // links pre-fill `?ensemble=…`.
  if (!ensemble) {
    return (
      <ModalShell
        label="modal · recruit · esc to close"
        onClose={close}
        testId="recruit-modal-empty"
      >
        <Dialog
          testId="screen-recruit"
          title="Recruit a player"
          footer={
            <>
              <span className="hint">Pick an ensemble from the sidebar to start.</span>
              <Btn variant="primary" size="md" data-testid="recruit-empty-back" onClick={close}>
                Back
              </Btn>
            </>
          }
        >
          <p data-testid="recruit-missing-ensemble" role="alert" className="dim">
            Pick an ensemble first. Open one from the sidebar and click{' '}
            <span className="mono">+ Recruit</span> in the Workspace toolbar.
          </p>
        </Dialog>
      </ModalShell>
    );
  }

  return (
    <ModalShell
      label="modal · recruit a player · esc to close"
      onClose={close}
      testId="recruit-modal"
    >
      <Dialog
        testId="screen-recruit"
        title={`Recruit into @${ensemble}`}
        step={step}
        totalSteps={4}
        stepLabel={STEP_LABELS[step]}
        footer={
          <>
            <span className="hint">↑↓ to select · Enter to confirm · Esc to cancel</span>
            <div className="row" style={{ display: 'flex', gap: 8 }}>
              <Btn variant="ghost" size="md" data-testid="recruit-cancel" onClick={close}>
                Cancel
              </Btn>
              {step > 1 && (
                <Btn variant="ghost" size="md" data-testid="recruit-back" onClick={goBack}>
                  Back
                </Btn>
              )}
              {step < 4 ? (
                <Btn
                  variant="primary"
                  size="md"
                  data-testid="recruit-next"
                  onClick={goNext}
                  disabled={!stepValid}
                  aria-disabled={!stepValid}
                >
                  Next: {STEP_LABELS[(step + 1) as Step]}
                </Btn>
              ) : (
                <Btn
                  variant="primary"
                  size="md"
                  data-testid="recruit-submit"
                  onClick={onSubmit}
                  disabled={submitDisabled}
                  aria-disabled={submitDisabled}
                >
                  {recruit.isPending ? 'Recruiting…' : 'Recruit player'}
                </Btn>
              )}
            </div>
          </>
        }
      >
        {step === 1 && (
          <div data-testid="recruit-wizard-step-1" style={STEP_CONTAINER_STYLE}>
            <Field
              id="recruit-input-name"
              label="Name"
              error={form.name.length > 0 ? nameError : null}
            >
              <input
                id="recruit-input-name"
                data-testid="recruit-input-name"
                className="input"
                placeholder="frontend-eng"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              />
            </Field>
            <Field
              id="recruit-input-part"
              label="Part"
              hint="optional"
              error={partError}
            >
              <input
                id="recruit-input-part"
                data-testid="recruit-input-part"
                className="input"
                placeholder="Implementing the schedules screen"
                value={form.part}
                onChange={(e) => setForm((p) => ({ ...p, part: e.target.value }))}
              />
            </Field>
          </div>
        )}

        {step === 2 && (
          <div data-testid="recruit-wizard-step-2" style={STEP_CONTAINER_STYLE}>
            <Field
              id="recruit-input-player-type"
              label="Player type"
              hint={
                agentTypesQuery.isError
                  ? 'showing local catalog (daemon unreachable)'
                  : `${playerTypes.length} available`
              }
            >
              <PickerList
                testId="recruit-input-player-type"
                options={playerTypeOptions}
                value={form.playerType}
                onChange={(v) => setForm((p) => ({ ...p, playerType: v }))}
                style={{ maxHeight: 240, overflow: 'auto' }}
              />
            </Field>
            <Field id="recruit-input-agent" label="Agent">
              <select
                id="recruit-input-agent"
                data-testid="recruit-input-agent"
                className="select"
                value={form.agent}
                onChange={(e) => setForm((p) => ({ ...p, agent: e.target.value as AgentType }))}
              >
                {AGENT_OPTIONS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}

        {step === 3 && (
          <div data-testid="recruit-wizard-step-3" style={STEP_CONTAINER_STYLE}>
            <div className="field-grid-2">
              <Field
                id="recruit-input-workdir"
                label="Work dir"
                error={form.workDir.length > 0 ? null : workDirError}
              >
                <input
                  id="recruit-input-workdir"
                  data-testid="recruit-input-workdir"
                  className="input"
                  placeholder="/repos/my-app"
                  value={form.workDir}
                  onChange={(e) => setForm((p) => ({ ...p, workDir: e.target.value }))}
                />
              </Field>
              <Field id="recruit-input-host" label="Host">
                <select
                  id="recruit-input-host"
                  data-testid="recruit-input-host"
                  className="select"
                  value={form.host}
                  onChange={(e) => setForm((p) => ({ ...p, host: e.target.value }))}
                  disabled={hostsQuery.isLoading}
                >
                  {hostsQuery.data && hostsQuery.data.length > 0 ? (
                    hostsQuery.data.map((h) => (
                      <option key={h.hostname} value={h.hostname}>
                        {h.hostname}
                      </option>
                    ))
                  ) : (
                    <option value="">{hostsQuery.isLoading ? 'Loading…' : 'No hosts'}</option>
                  )}
                </select>
              </Field>
            </div>
            <Field
              id="recruit-input-message"
              label="Opening task"
              hint="optional"
            >
              <textarea
                id="recruit-input-message"
                data-testid="recruit-input-message"
                className="textarea"
                rows={3}
                placeholder="Read CLAUDE.md and report status."
                value={form.initialMessage}
                onChange={(e) =>
                  setForm((p) => ({ ...p, initialMessage: e.target.value }))
                }
              />
            </Field>
            <Field id="recruit-input-options" label="Options">
              <Chipset
                testId="recruit-input-worktree"
                options={[
                  { value: 'on', label: 'worktree' },
                  { value: 'off', label: 'no worktree' },
                ]}
                value={form.worktree ? 'on' : 'off'}
                onChange={(v) => setForm((p) => ({ ...p, worktree: v === 'on' }))}
              />
              <Chipset
                testId="recruit-input-hold"
                options={[
                  { value: 'release', label: 'release immediately' },
                  { value: 'hold', label: 'hold' },
                ]}
                value={form.hold ? 'hold' : 'release'}
                onChange={(v) => setForm((p) => ({ ...p, hold: v === 'hold' }))}
              />
            </Field>
          </div>
        )}

        {step === 4 && (
          <div data-testid="recruit-wizard-step-4" style={STEP_CONTAINER_STYLE}>
            <SummaryRow testId="recruit-summary-name" label="Name" value={form.name || '—'} />
            <SummaryRow testId="recruit-summary-part" label="Part" value={form.part || '—'} />
            <SummaryRow
              testId="recruit-summary-player-type"
              label="Player type"
              value={form.playerType}
            />
            <SummaryRow testId="recruit-summary-agent" label="Agent" value={form.agent} />
            <SummaryRow
              testId="recruit-summary-workdir"
              label="Work dir"
              value={form.workDir || '—'}
            />
            <SummaryRow testId="recruit-summary-host" label="Host" value={form.host || '—'} />
            <SummaryRow
              testId="recruit-summary-message"
              label="Opening task"
              value={form.initialMessage || '—'}
            />
            <SummaryRow
              testId="recruit-summary-options"
              label="Options"
              value={[form.worktree ? 'worktree' : null, form.hold ? 'hold' : 'release-immediately']
                .filter(Boolean)
                .join(' · ')}
            />
          </div>
        )}
      </Dialog>
    </ModalShell>
  );
}

function validatePlayerName(name: string): string | null {
  if (name.length === 0) return 'Required';
  if (name.length > PLAYER_NAME_MAX) return `Too long (≤${PLAYER_NAME_MAX} chars)`;
  if (!PLAYER_NAME_REGEX.test(name)) {
    return 'Letters, digits, underscores, dashes only';
  }
  return null;
}

