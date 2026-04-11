/**
 * ScheduleWizard — step-by-step wizard for creating a scheduled message.
 * Steps: target → message → schedule type → timing → timezone (cron only) → confirm.
 * Escape cancels. Backspace on empty input goes back a step.
 *
 * Minimal-Box pattern: single <Text> root for all static content (0 Yoga nodes).
 * Uses manual key handling — no TextInput component, so zero Box elements needed.
 */
import React, { useState, useCallback } from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';
import type { ScheduleWizardState, ScheduleAnswers, ScheduleStep, ScheduleType } from '../store';

export interface ScheduleWizardProps {
  state: ScheduleWizardState;
  onAnswer: (answer: Partial<ScheduleAnswers>) => void;
  onBack: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onDone: () => void;
}

const STEP_LABELS: Record<ScheduleStep, string> = {
  target: 'Target player',
  message: 'Message to deliver',
  schedType: 'Schedule type',
  timing: 'Timing',
  timezone: 'Timezone (for cron)',
  confirm: 'Confirm',
  done: 'Done',
};

const SCHED_TYPE_OPTIONS: Array<{ value: ScheduleType; label: string; hint: string }> = [
  { value: 'delay', label: 'One-shot delay', hint: 'e.g., 5m, 1h, 30s' },
  { value: 'at', label: 'Fixed time', hint: 'e.g., 2026-04-07T09:00:00' },
  { value: 'every', label: 'Recurring interval', hint: 'e.g., 30m, 1h, 6h' },
  { value: 'cron', label: 'Cron expression', hint: 'e.g., 0 9 * * * (daily 9am)' },
];

const TIMING_HINTS: Record<ScheduleType, string> = {
  delay: 'Enter delay duration (e.g., 5m, 1h, 30s):',
  at: 'Enter ISO datetime (e.g., 2026-04-07T09:00:00):',
  every: 'Enter interval (e.g., 30m, 1h, 6h):',
  cron: 'Enter cron expression (e.g., 0 9 * * *):',
};

export function ScheduleWizard({ state, onAnswer, onBack, onConfirm, onCancel, onDone }: ScheduleWizardProps) {
  const { Text, useInput } = useInk();
  const [inputValue, setInputValue] = useState('');
  const [showRequired, setShowRequired] = useState(false);
  const [typeIndex, setTypeIndex] = useState(
    SCHED_TYPE_OPTIONS.findIndex(o => o.value === state.answers.schedType),
  );

  useInput(useCallback((input: string, key: any) => {
    if (key.escape) {
      onCancel();
      return;
    }

    // Done step
    if (state.step === 'done') {
      if (key.return) onDone();
      return;
    }

    // Backspace on empty input → go back
    if ((key.backspace || key.delete) && state.step !== 'target' && !inputValue) {
      onBack();
      return;
    }

    // Schedule type selection step
    if (state.step === 'schedType') {
      if (key.upArrow) {
        setTypeIndex(i => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setTypeIndex(i => Math.min(SCHED_TYPE_OPTIONS.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const selected = SCHED_TYPE_OPTIONS[typeIndex];
        const name = `${state.answers.target}-${selected.value}-${Date.now().toString(36)}`;
        onAnswer({ schedType: selected.value, name });
        setInputValue('');
        return;
      }
      return;
    }

    // Confirm step
    if (state.step === 'confirm') {
      if (key.return) {
        onConfirm();
      }
      return;
    }

    // Empty enter — show validation hint
    if (key.return && !inputValue.trim() && ['target', 'message', 'timing', 'timezone'].includes(state.step)) {
      setShowRequired(true);
      return;
    }

    // Text input steps
    if (key.return && inputValue.trim()) {
      const val = inputValue.trim();
      switch (state.step) {
        case 'target':
          onAnswer({ target: val });
          break;
        case 'message':
          onAnswer({ message: val });
          break;
        case 'timing':
          onAnswer({ timing: val });
          break;
        case 'timezone':
          onAnswer({ timezone: val });
          break;
      }
      setInputValue('');
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      if (inputValue.length > 0) setInputValue(v => v.slice(0, -1));
      return;
    }

    // Regular character
    if (input && !key.ctrl && !key.meta && !key.tab) {
      setInputValue(v => v + input);
      if (showRequired) setShowRequired(false);
    }
  }, [state.step, inputValue, typeIndex, onAnswer, onBack, onConfirm, onCancel, onDone, state.answers.target]));

  // ── Progress indicator ──
  const steps: ScheduleStep[] = ['target', 'message', 'schedType', 'timing', 'confirm'];
  const currentStepIdx = steps.indexOf(state.step === 'timezone' ? 'timing' : state.step === 'done' ? 'confirm' : state.step);
  const progressDots = steps.map((_, i) =>
    i <= currentStepIdx ? '\u25CF' : '\u25CB',
  ).join(' ');

  // ── Build content ──

  const children: React.ReactNode[] = [];

  // Header
  children.push(React.createElement(React.Fragment, { key: 'hdr' },
    React.createElement(Text, { bold: true, color: THEME.accent }, '  Create Schedule'),
    React.createElement(Text, { color: THEME.dim }, `  ${progressDots}`),
  ));

  // Completed answers as breadcrumbs
  const completedSteps: Array<[string, string]> = [];
  if (state.answers.target && state.step !== 'target') {
    completedSteps.push(['Target', state.answers.target]);
  }
  if (state.answers.message && state.step !== 'message' && state.step !== 'target') {
    const msg = state.answers.message.length > 40 ? state.answers.message.slice(0, 37) + '...' : state.answers.message;
    completedSteps.push(['Message', msg]);
  }
  if (state.answers.schedType && ['timing', 'timezone', 'confirm', 'done'].includes(state.step)) {
    completedSteps.push(['Type', state.answers.schedType]);
  }
  if (state.answers.timing && ['timezone', 'confirm', 'done'].includes(state.step)) {
    completedSteps.push(['Timing', state.answers.timing]);
  }

  for (const [label, value] of completedSteps) {
    children.push('\n');
    children.push(React.createElement(Text, { key: `bc-${label}`, color: THEME.dim }, `  \u2713 ${label}: ${value}`));
  }

  // Current step content
  if (state.step === 'schedType') {
    children.push('\n\n');
    children.push(React.createElement(Text, { key: 'prompt', color: THEME.text }, `  ${STEP_LABELS[state.step]}:`));
    for (let i = 0; i < SCHED_TYPE_OPTIONS.length; i++) {
      const opt = SCHED_TYPE_OPTIONS[i];
      const selected = i === typeIndex;
      children.push('\n');
      children.push(React.createElement(Text, {
        key: `opt-${i}`,
        color: selected ? THEME.accent : THEME.textMuted,
        bold: selected,
      }, `  ${selected ? '\u25B6' : ' '} ${opt.label}  ${selected ? `(${opt.hint})` : ''}`));
    }
    children.push('\n\n');
    children.push(React.createElement(Text, { key: 'nav', color: THEME.dim }, '  \u2191\u2193 select, Enter to confirm'));

  } else if (state.step === 'confirm') {
    // Summary with text-based border
    const boxWidth = 50;
    const hLine = '\u2500'.repeat(boxWidth);
    children.push('\n\n');
    children.push(React.createElement(Text, { key: 'bt', color: THEME.dim }, `  \u250C${hLine}\u2510`));
    children.push('\n');
    children.push(React.createElement(Text, { key: 'bh', bold: true, color: THEME.text }, '  \u2502 Schedule Summary'));
    children.push(React.createElement(Text, { key: 'bh2', color: THEME.dim }, ' '.repeat(boxWidth - 17) + '\u2502'));

    const summaryLines = [
      `Name: ${state.answers.name}`,
      `Target: ${state.answers.target}`,
      `Message: ${state.answers.message}`,
      `Type: ${state.answers.schedType}`,
      `Timing: ${state.answers.timing}`,
    ];
    if (state.answers.timezone) {
      summaryLines.push(`Timezone: ${state.answers.timezone}`);
    }
    for (let i = 0; i < summaryLines.length; i++) {
      const line = summaryLines[i];
      const pad = ' '.repeat(Math.max(0, boxWidth - line.length - 2));
      children.push('\n');
      children.push(React.createElement(Text, { key: `sl-${i}`, color: THEME.textMuted }, `  \u2502 ${line}`));
      children.push(React.createElement(Text, { key: `sp-${i}`, color: THEME.dim }, `${pad}\u2502`));
    }
    children.push('\n');
    children.push(React.createElement(Text, { key: 'bb', color: THEME.dim }, `  \u2514${hLine}\u2518`));
    children.push('\n\n');
    children.push(React.createElement(Text, { key: 'confirm-hint', color: THEME.dim }, '  Enter to create, Esc to cancel, Backspace to go back'));

    if (state.submitting) {
      children.push('\n');
      children.push(React.createElement(Text, { key: 'submitting', color: THEME.warning }, '  Creating schedule...'));
    }

  } else if (state.step === 'done') {
    children.push('\n');
    if (state.error) {
      children.push(React.createElement(Text, { key: 'err', color: THEME.error }, `\n  \u2717 ${state.error}`));
      children.push('\n');
      children.push(React.createElement(Text, { key: 'err-hint', color: THEME.dim }, '  Press Enter to dismiss.'));
    } else {
      children.push(React.createElement(Text, { key: 'ok', color: THEME.success }, `\n  \u2713 Schedule "${state.answers.name}" created!`));
      children.push('\n');
      children.push(React.createElement(Text, { key: 'ok-hint', color: THEME.dim }, '  Press Enter to return.'));
    }

  } else {
    // Text input steps
    const hint = state.step === 'timing' ? TIMING_HINTS[state.answers.schedType] : `${STEP_LABELS[state.step]}:`;
    children.push('\n\n');
    children.push(React.createElement(Text, { key: 'prompt', color: THEME.text }, `  ${hint}`));
    children.push('\n');
    children.push(React.createElement(React.Fragment, { key: 'input' },
      React.createElement(Text, { color: THEME.accent }, '  > '),
      React.createElement(Text, { color: THEME.text }, inputValue),
      React.createElement(Text, { color: THEME.accent }, '\u2588'),
      showRequired ? React.createElement(Text, { color: 'red' }, '  (required)') : null,
    ));
    if (state.step !== 'target') {
      children.push('\n');
      children.push(React.createElement(Text, { key: 'back-hint', color: THEME.dim }, '  Backspace on empty to go back, Esc to cancel'));
    }
  }

  return React.createElement(Text, null, ...children);
}
