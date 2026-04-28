/**
 * Create Ensemble wizard — PR-E of #389. 3-step modal:
 *
 *   1. **Lineup** — name + starting-lineup picker (incl. blank ensemble row)
 *   2. **Customize** — default host + start mode (chipset) + conductor
 *      instructions textarea
 *   3. **Review** — KV summary + submit
 *
 * Source: `screens.jsx:CreateEnsemble` (lines 261-326) + audit doc § PR-E.
 *
 * Wire-pending: the daemon doesn't yet expose POST `/v1/ensembles`. The
 * mutation hook (`useEnsembleCreateMutation`) handles the 404 path with
 * a wire-gap-aware toast, so users see a useful message rather than a
 * generic failure. Lineup catalog is a hardcoded fallback
 * (`lib/static-catalog.ts`) until `/v1/lineups` ships.
 *
 * Triggered from:
 *   - Overview "+ New ensemble" action (PR-B `navigate('/create-ensemble')`)
 *   - Sidebar "+ New ensemble…" link (PR-A1 `<Link to="/create-ensemble">`)
 *
 * Renders inside a `ModalShell`; closing the modal navigates back to `/`.
 *
 * Validation rule (`validateName`) mirrors the daemon's
 * `ENSEMBLE_NAME_REGEX` from `src/utils/validation.ts` — kept duplicated
 * because the regex constant lives outside the dashboard's
 * type-only `claude-tempo/*` import surface. A future shared validation
 * module can absorb both copies.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Btn } from '../components/Btn';
import { ModalShell } from '../components/wizard/ModalShell';
import { Dialog } from '../components/wizard/Dialog';
import { PickerList, type PickerOption } from '../components/wizard/PickerList';
import { Chipset } from '../components/wizard/Chipset';
import { Field } from '../components/wizard/Field';
import { SummaryRow } from '../components/wizard/SummaryRow';
import { useEnsembleCreateMutation } from '../lib/mutations';
import { useHosts } from '../lib/queries';
import { logEvent } from '../lib/log';
import {
  BLANK_LINEUP_SENTINEL,
  SHIPPED_LINEUPS,
  type Lineup,
} from '../lib/static-catalog';

type Step = 1 | 2 | 3;
type StartMode = 'hold' | 'release-immediately';

interface FormState {
  name: string;
  lineup: string;
  host: string;
  startMode: StartMode;
  conductorInstructions: string;
}

const STEP_LABELS: Record<Step, string> = {
  1: 'lineup',
  2: 'customize',
  3: 'review',
};

const START_MODE_OPTIONS = [
  { value: 'hold' as const, label: 'hold' },
  { value: 'release-immediately' as const, label: 'release immediately' },
];

const ENSEMBLE_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;
const ENSEMBLE_NAME_MAX = 64;

export function CreateEnsemble() {
  useEffect(() => {
    logEvent('screen.opened', { screen: 'create-ensemble' });
  }, []);
  const navigate = useNavigate();
  const hostsQuery = useHosts();
  const create = useEnsembleCreateMutation();

  const [step, setStep] = useState<Step>(1);
  const [form, setForm] = useState<FormState>(() => ({
    name: '',
    lineup: SHIPPED_LINEUPS[0]?.name ?? BLANK_LINEUP_SENTINEL,
    host: '',
    startMode: 'hold',
    conductorInstructions: '',
  }));

  // First reported host wins — overridden if the user picks a different
  // one. Effect runs after the hosts query resolves.
  useEffect(() => {
    if (!form.host && hostsQuery.data && hostsQuery.data.length > 0) {
      setForm((prev) => ({ ...prev, host: hostsQuery.data![0].hostname }));
    }
  }, [form.host, hostsQuery.data]);

  const nameError = validateName(form.name);
  const step1Valid = nameError === null && form.lineup.length > 0;
  // step 2 is always valid — host has a default; instructions are optional.

  const close = () => navigate('/');

  const goNext = () => {
    if (step === 3) return;
    if (step === 1 && !step1Valid) return;
    const next = (step + 1) as Step;
    setStep(next);
    logEvent('create-ensemble-wizard.advance', { from: step, to: next });
  };

  const goBack = () => {
    if (step === 1) return;
    setStep((step - 1) as Step);
  };

  const onSubmit = () => {
    if (!step1Valid) return;
    const lineupArg = form.lineup === BLANK_LINEUP_SENTINEL ? undefined : form.lineup;
    create.mutate(
      {
        name: form.name,
        ...(lineupArg ? { lineup: lineupArg } : {}),
        ...(form.host ? { host: form.host } : {}),
        startMode: form.startMode,
        ...(form.conductorInstructions
          ? { conductorInstructions: form.conductorInstructions }
          : {}),
      },
      { onSuccess: () => navigate('/') },
    );
  };

  // SHIPPED_LINEUPS is module-constant + the blank sentinel row never
  // changes — useMemo with `[]` deps avoids rebuilding 6 PickerOption
  // JSX nodes per render.
  const lineupOptions = useMemo<PickerOption[]>(
    () => [
      ...SHIPPED_LINEUPS.map(lineupToOption),
      {
        value: BLANK_LINEUP_SENTINEL,
        name: 'Blank ensemble (recruit manually)',
        desc: 'Start with no players — use Recruit later from the Workspace.',
      },
    ],
    [],
  );

  return (
    <ModalShell
      label="modal · create ensemble · esc to close"
      onClose={close}
      testId="create-ensemble-modal"
    >
      <Dialog
        testId="screen-create-ensemble"
        title="Create ensemble"
        step={step}
        totalSteps={3}
        stepLabel={STEP_LABELS[step]}
        footer={
          <>
            <span className="hint">3 steps: lineup → customize → review</span>
            <div className="row" style={{ display: 'flex', gap: 8 }}>
              <Btn
                variant="ghost"
                size="md"
                data-testid="create-ensemble-cancel"
                onClick={close}
              >
                Cancel
              </Btn>
              {step > 1 && (
                <Btn
                  variant="ghost"
                  size="md"
                  data-testid="create-ensemble-back"
                  onClick={goBack}
                >
                  Back
                </Btn>
              )}
              {step < 3 ? (
                <Btn
                  variant="primary"
                  size="md"
                  data-testid="create-ensemble-next"
                  onClick={goNext}
                  disabled={step === 1 && !step1Valid}
                  aria-disabled={step === 1 && !step1Valid}
                >
                  Next: {STEP_LABELS[(step + 1) as Step]}
                </Btn>
              ) : (
                <Btn
                  variant="primary"
                  size="md"
                  data-testid="create-ensemble-submit"
                  onClick={onSubmit}
                  disabled={create.isPending || !step1Valid}
                  aria-disabled={create.isPending || !step1Valid}
                >
                  {create.isPending ? 'Creating…' : 'Create ensemble'}
                </Btn>
              )}
            </div>
          </>
        }
      >
        {step === 1 && (
          <>
            <Field
              id="create-ensemble-input-name"
              label="Name"
              error={form.name.length > 0 ? nameError : null}
            >
              <input
                id="create-ensemble-input-name"
                data-testid="create-ensemble-input-name"
                className="input"
                placeholder="my-feature"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              />
            </Field>
            <Field id="create-ensemble-lineup" label="Starting lineup">
              <PickerList
                testId="create-ensemble-lineup"
                options={lineupOptions}
                value={form.lineup}
                onChange={(v) => setForm((p) => ({ ...p, lineup: v }))}
                style={{ maxHeight: 220, overflow: 'auto' }}
              />
            </Field>
          </>
        )}

        {step === 2 && (
          <>
            <div className="field-grid-2">
              <Field id="create-ensemble-host" label="Default host">
                <select
                  id="create-ensemble-host"
                  data-testid="create-ensemble-input-host"
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
              <Field id="create-ensemble-start-mode" label="Start mode">
                <Chipset
                  testId="create-ensemble-start-mode"
                  options={START_MODE_OPTIONS}
                  value={form.startMode}
                  onChange={(v) => setForm((p) => ({ ...p, startMode: v }))}
                />
              </Field>
            </div>
            <Field
              id="create-ensemble-input-instructions"
              label="Conductor instructions"
              hint="optional override"
            >
              <textarea
                id="create-ensemble-input-instructions"
                data-testid="create-ensemble-input-instructions"
                className="textarea"
                rows={3}
                placeholder="Coordinate the rebuild. Gate phases; don't advance until the current phase is complete."
                value={form.conductorInstructions}
                onChange={(e) =>
                  setForm((p) => ({ ...p, conductorInstructions: e.target.value }))
                }
              />
            </Field>
          </>
        )}

        {step === 3 && (
          <div data-testid="create-ensemble-review">
            <SummaryRow testId="create-ensemble-summary-name" label="Name" value={form.name} />
            <SummaryRow
              testId="create-ensemble-summary-lineup"
              label="Lineup"
              value={form.lineup === BLANK_LINEUP_SENTINEL ? 'blank ensemble' : form.lineup}
            />
            <SummaryRow
              testId="create-ensemble-summary-host"
              label="Default host"
              value={form.host || '—'}
            />
            <SummaryRow
              testId="create-ensemble-summary-start-mode"
              label="Start mode"
              value={form.startMode === 'hold' ? 'hold' : 'release immediately'}
            />
            <SummaryRow
              testId="create-ensemble-summary-instructions"
              label="Instructions"
              value={form.conductorInstructions || '—'}
            />
          </div>
        )}
      </Dialog>
    </ModalShell>
  );
}

function lineupToOption(l: Lineup): PickerOption {
  return {
    value: l.name,
    name: (
      <>
        {l.name}{' '}
        <span className="mono dim" style={{ fontWeight: 400, fontSize: 11 }}>
          · {l.players} players
        </span>
      </>
    ),
    desc: l.summary,
    right: (
      <span className="mono dim" style={{ fontSize: 10 }}>
        SHIPPED
      </span>
    ),
  };
}

function validateName(name: string): string | null {
  if (name.length === 0) return 'Required';
  if (name.length > ENSEMBLE_NAME_MAX) return `Too long (≤${ENSEMBLE_NAME_MAX} chars)`;
  if (!ENSEMBLE_NAME_REGEX.test(name)) {
    return 'Lowercase letters, digits, and dashes only; cannot start with a dash';
  }
  return null;
}

