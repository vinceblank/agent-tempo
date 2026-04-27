/**
 * Create Ensemble screen — Screen D of the dashboard design (PR-6 of #340).
 *
 * **PR-6 status**: form skeleton with submit DISABLED. Real submit
 * lands in PR-7 alongside the rest of the safe-write flows. The design
 * tokens, layout, and field validation patterns are exercised here so
 * PR-7's plumbing is mechanical.
 */
import { useEffect, useState } from 'react';
import { DisabledWithTooltip } from '../components/DisabledWithTooltip';
import { FormField } from '../components/FormField';
import { logEvent } from '../lib/log';

export function CreateEnsemble() {
  useEffect(() => { logEvent('screen.opened', { screen: 'create-ensemble' }); }, []);
  const [name, setName] = useState('');
  const [workDir, setWorkDir] = useState('');
  const nameError = validateEnsembleName(name);

  return (
    <section
      data-testid="screen-create-ensemble"
      style={containerStyle}
    >
      <header>
        <h1 style={{ margin: 0, fontFamily: 'var(--ff-display)', fontSize: 22, fontWeight: 400 }}>
          Create Ensemble
        </h1>
        <p className="dim" style={{ marginTop: 4, fontSize: 13 }}>
          Spawn a new conductor terminal for a fresh ensemble. Submit
          enables in PR-7 once the dashboard wires its safe-write paths.
        </p>
      </header>

      <FormField
        id="create-ensemble-name"
        label="Ensemble name"
        testId="create-ensemble-input-name"
        value={name}
        onChange={setName}
        placeholder="my-feature"
        error={name.length > 0 ? nameError : null}
      />
      <FormField
        id="create-ensemble-workdir"
        label="Working directory"
        testId="create-ensemble-input-workdir"
        value={workDir}
        onChange={setWorkDir}
        placeholder="/repo/path"
      />

      <DisabledWithTooltip
        testId="create-ensemble-submit"
        action="create-ensemble"
        reason="Submit available in PR-7 of #340 once safe-write wiring lands"
      >
        Create ensemble
      </DisabledWithTooltip>
    </section>
  );
}

/**
 * Mirrors the daemon's `validateEnsembleName` rules
 * (`src/utils/validation.ts` — `ENSEMBLE_NAME_REGEX`). Duplicated here
 * because the daemon's regex constant lives outside the dashboard's
 * `claude-tempo/*` type-only import surface; PR-7+ may extract a
 * shared `claude-tempo/validation` entry once the daemon splits its
 * Temporal-bound vs pure surfaces.
 */
function validateEnsembleName(name: string): string | null {
  if (name.length === 0) return 'Required';
  if (name.length > 64) return 'Too long (≤64 chars)';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return 'Lowercase letters, digits, and dashes only; cannot start with a dash';
  }
  return null;
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  padding: 'var(--density-pad)',
  background: 'var(--bg-1)',
  border: '1px solid var(--rule)',
  borderRadius: 8,
  maxWidth: 480,
};
