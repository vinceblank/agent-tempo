/**
 * CreateEnsembleWizard — step-by-step flow for creating a new ensemble.
 *
 * Steps: name → workDir → lineup (optional) → confirm
 *
 * Minimal-Box pattern: single <Text> root for static content,
 * one <Box> for Ink's TextInput on text-input steps.
 */
import React, { useState, useCallback, useMemo } from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';
import type { CreateEnsembleState, CreateEnsembleAnswers, CreateEnsembleStep } from '../store';
import { listAllLineups } from '../../ensemble/saver';

export interface CreateEnsembleWizardProps {
  state: CreateEnsembleState;
  onAnswer: (answer: Partial<CreateEnsembleAnswers>) => void;
  onBack: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onDone: () => void;
}

const STEP_LABELS: Record<CreateEnsembleStep, string> = {
  name: 'Ensemble name',
  workDir: 'Working directory',
  lineup: 'Lineup (optional)',
  confirm: 'Confirm',
  done: 'Done',
};

const TEXT_INPUT_STEPS = new Set<CreateEnsembleStep>(['name', 'workDir']);

export function CreateEnsembleWizard({ state, onAnswer, onBack, onConfirm, onCancel, onDone }: CreateEnsembleWizardProps) {
  const { Box, Text, TextInput, useInput } = useInk();
  const [inputValue, setInputValue] = useState('');
  const [lineupIdx, setLineupIdx] = useState(0);
  const [lineupCustom, setLineupCustom] = useState(false);

  // Build lineup options: (none) + saved/shipped + custom path
  const lineupOptions = useMemo(() => {
    const options: Array<{ label: string; value: string; source?: string }> = [
      { label: '(none) \u2014 start with no lineup', value: '' },
    ];
    try {
      for (const l of listAllLineups()) {
        options.push({ label: `${l.name} (${l.source})`, value: l.name, source: l.source });
      }
    } catch { /* ignore */ }
    options.push({ label: '[custom path...]', value: '__custom__' });
    return options;
  }, []);

  useInput(useCallback((_input: string, key: any) => {
    if (key.escape) { onCancel(); return; }
    if (key.backspace && state.step !== 'name' && state.step !== 'done' && !inputValue) {
      if (state.step === 'lineup' && lineupCustom) {
        setLineupCustom(false);
        return;
      }
      onBack();
      return;
    }
    if (state.step === 'confirm' && key.return) onConfirm();
    if (state.step === 'done' && key.return) onDone();
    // Lineup list navigation
    if (state.step === 'lineup' && !lineupCustom) {
      if (key.upArrow) { setLineupIdx(i => (i - 1 + lineupOptions.length) % lineupOptions.length); return; }
      if (key.downArrow) { setLineupIdx(i => (i + 1) % lineupOptions.length); return; }
      if (key.return) {
        const selected = lineupOptions[lineupIdx];
        if (selected.value === '__custom__') {
          setLineupCustom(true);
        } else {
          onAnswer({ lineup: selected.value });
        }
        return;
      }
    }
  }, [state.step, inputValue, lineupCustom, lineupIdx, lineupOptions, onBack, onCancel, onConfirm, onDone, onAnswer]));

  const handleTextSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    switch (state.step) {
      case 'name':
        if (!trimmed) return;
        onAnswer({ name: trimmed });
        break;
      case 'workDir':
        onAnswer({ workDir: trimmed || state.answers.workDir });
        break;
      case 'lineup':
        // Custom path mode
        onAnswer({ lineup: trimmed });
        setLineupCustom(false);
        break;
    }
    setInputValue('');
  }, [state.step, state.answers.workDir, onAnswer]);

  const children: React.ReactNode[] = [];

  // Header
  children.push(
    React.createElement(React.Fragment, { key: 'hdr' },
      React.createElement(Text, { bold: true, color: THEME.accent }, ' Create New Ensemble'),
      React.createElement(Text, { color: THEME.dim }, '  (Esc to cancel, Backspace to go back)'),
    ),
  );

  // Completed steps
  const steps: CreateEnsembleStep[] = ['name', 'workDir', 'lineup'];
  for (const s of steps) {
    if (s === state.step) break;
    const value = getAnswerDisplay(s, state.answers);
    children.push('\n');
    children.push(
      React.createElement(React.Fragment, { key: `done-${s}` },
        React.createElement(Text, { color: THEME.success }, ' \u2714 '),
        React.createElement(Text, { color: THEME.dim }, `${STEP_LABELS[s]}: `),
        React.createElement(Text, { color: THEME.text }, value),
      ),
    );
  }

  // Current step
  if (state.step === 'confirm') {
    const a = state.answers;
    children.push('\n\n');
    children.push(React.createElement(Text, { key: 'sum-h', bold: true, color: THEME.accent }, '   Create Ensemble:'));
    children.push('\n');
    children.push(React.createElement(Text, { key: 'sum-n', color: THEME.text }, `     Name:      ${a.name}`));
    children.push('\n');
    children.push(React.createElement(Text, { key: 'sum-d', color: THEME.text }, `     Directory: ${a.workDir}`));
    children.push('\n');
    children.push(React.createElement(Text, { key: 'sum-l', color: THEME.text }, `     Lineup:    ${a.lineup || '(none — bare ensemble)'}`));
    children.push('\n\n');
    children.push(React.createElement(Text, { key: 'sum-hint', color: THEME.dim }, '   Press Enter to create, Esc to cancel'));
  } else if (state.step === 'done') {
    children.push('\n\n');
    if (state.error) {
      children.push(React.createElement(Text, { key: 'err', color: THEME.error, bold: true }, `   \u2717 Failed: ${state.error}`));
      children.push('\n');
      children.push(React.createElement(Text, { key: 'err-h', color: THEME.dim }, '   Press Enter to return'));
    }
  } else if (state.submitting) {
    children.push('\n\n');
    children.push(React.createElement(Text, { key: 'sub', color: THEME.warning }, `   \u2026 Creating ensemble "${state.answers.name}"...`));
  } else if (state.step === 'lineup') {
    children.push('\n\n');
    children.push(
      React.createElement(React.Fragment, { key: 'inp-q' },
        React.createElement(Text, { color: THEME.accent }, ' ? '),
        React.createElement(Text, { bold: true, color: THEME.text }, 'Select a lineup:'),
      ),
    );
    if (!lineupCustom) {
      for (let i = 0; i < lineupOptions.length; i++) {
        const opt = lineupOptions[i];
        const selected = i === lineupIdx;
        children.push('\n');
        children.push(React.createElement(Text, { key: `lo-${i}`, color: selected ? THEME.text : THEME.dim, bold: selected },
          `   ${selected ? '\u276F' : ' '} ${opt.label}`));
      }
    }
  } else if (TEXT_INPUT_STEPS.has(state.step)) {
    const defaultHint = getDefaultHint(state.step, state.answers);
    children.push('\n\n');
    children.push(
      React.createElement(React.Fragment, { key: 'inp-q' },
        React.createElement(Text, { color: THEME.accent }, ' ? '),
        React.createElement(Text, { bold: true, color: THEME.text }, `${STEP_LABELS[state.step]}:`),
        defaultHint
          ? React.createElement(Text, { color: THEME.dim }, ` (${defaultHint})`)
          : null,
      ),
    );
  }

  // Lineup custom path mode: show text input
  if (state.step === 'lineup' && lineupCustom && !state.submitting) {
    return React.createElement(React.Fragment, null,
      React.createElement(Text, null, ...children),
      React.createElement(Box, { marginLeft: 3 },
        React.createElement(Text, { color: THEME.accent }, '> '),
        React.createElement(TextInput, {
          value: inputValue,
          onChange: setInputValue,
          onSubmit: handleTextSubmit,
        }),
      ),
    );
  }

  // Text input steps: Text + Box(TextInput)
  if (TEXT_INPUT_STEPS.has(state.step) && !state.submitting) {
    return React.createElement(React.Fragment, null,
      React.createElement(Text, null, ...children),
      React.createElement(Box, { marginLeft: 3 },
        React.createElement(Text, { color: THEME.accent }, '> '),
        React.createElement(TextInput, {
          value: inputValue,
          onChange: setInputValue,
          onSubmit: handleTextSubmit,
        }),
      ),
    );
  }

  return React.createElement(Text, null, ...children);
}

function getAnswerDisplay(step: CreateEnsembleStep, answers: CreateEnsembleAnswers): string {
  switch (step) {
    case 'name': return answers.name;
    case 'workDir': return answers.workDir;
    case 'lineup': return answers.lineup || '(none)';
    default: return '';
  }
}

function getDefaultHint(step: CreateEnsembleStep, answers: CreateEnsembleAnswers): string | null {
  switch (step) {
    case 'workDir': return answers.workDir;
    case 'lineup': return 'press Enter to skip';
    default: return null;
  }
}
