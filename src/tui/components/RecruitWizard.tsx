/**
 * RecruitWizard — step-by-step wizard for spawning a new player session.
 *
 * Minimal-Box pattern: single <Text> root for all static content (0 Yoga nodes),
 * with ONE <Box> wrapper for Ink's TextInput when a text-input step is active.
 */
import React, { useState, useCallback } from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';
import type { RecruitState, RecruitAnswers, RecruitStep } from '../store';

export interface RecruitWizardProps {
  state: RecruitState;
  onAnswer: (answer: Partial<RecruitAnswers>) => void;
  onBack: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onDone: () => void;
}

/** Step labels for display. */
const STEP_LABELS: Record<RecruitStep, string> = {
  name: 'Player name',
  agent: 'Agent',
  type: 'Player type',
  workDir: 'Working directory',
  message: 'Initial message (optional)',
  host: 'Host',
  confirm: 'Confirm',
  done: 'Done',
};

const TEXT_INPUT_STEPS = new Set<RecruitStep>(['name', 'type', 'workDir', 'message', 'host']);

export function RecruitWizard({ state, onAnswer, onBack, onConfirm, onCancel, onDone }: RecruitWizardProps) {
  const { Box, Text, TextInput, useInput } = useInk();
  const [inputValue, setInputValue] = useState('');
  const [agentIndex, setAgentIndex] = useState(state.answers.agent === 'copilot' ? 1 : 0);

  const agents: Array<'claude' | 'copilot'> = ['claude', 'copilot'];

  // Global keybindings for wizard
  useInput(useCallback((input: string, key: any) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.backspace && state.step !== 'name' && state.step !== 'done' && !inputValue) {
      onBack();
      return;
    }
    if (state.step === 'agent') {
      if (key.leftArrow || key.rightArrow) {
        setAgentIndex(i => i === 0 ? 1 : 0);
      }
      if (key.return) {
        onAnswer({ agent: agents[agentIndex] });
        setInputValue('');
      }
    }
    if (state.step === 'confirm') {
      if (key.return) onConfirm();
    }
    if (state.step === 'done') {
      if (key.return) onDone();
    }
  }, [state.step, agentIndex, inputValue, onAnswer, onBack, onCancel, onConfirm, onDone]));

  // Text input submit for text steps
  const handleTextSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    switch (state.step) {
      case 'name':
        if (!trimmed) return;
        onAnswer({ name: trimmed });
        break;
      case 'type':
        onAnswer({ playerType: trimmed });
        break;
      case 'workDir':
        onAnswer({ workDir: trimmed || state.answers.workDir });
        break;
      case 'message':
        onAnswer({ initialMessage: trimmed });
        break;
      case 'host':
        onAnswer({ host: trimmed || 'localhost' });
        break;
    }
    setInputValue('');
  }, [state.step, state.answers.workDir, onAnswer]);

  // ── Build all content as nested Text children ──
  const children: React.ReactNode[] = [];

  // Header
  children.push(
    React.createElement(React.Fragment, { key: 'hdr' },
      React.createElement(Text, { bold: true, color: THEME.accent }, ' Recruit New Player'),
      React.createElement(Text, { color: THEME.dim }, '  (Esc to cancel, Backspace to go back)'),
    ),
  );

  // Completed steps
  const steps: RecruitStep[] = ['name', 'agent', 'type', 'workDir', 'message', 'host'];
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

  // Current step content
  if (state.step === 'agent') {
    children.push('\n\n');
    children.push(
      React.createElement(React.Fragment, { key: 'agent-q' },
        React.createElement(Text, { color: THEME.accent }, ' ? '),
        React.createElement(Text, { bold: true, color: THEME.text }, `${STEP_LABELS.agent}:`),
      ),
    );
    children.push('\n');
    for (let i = 0; i < agents.length; i++) {
      const selected = i === agentIndex;
      const icon = selected ? '\u25CF' : '\u25CB';
      children.push(
        React.createElement(Text, { key: `ag-${agents[i]}`, color: selected ? THEME.accent : THEME.dim, bold: selected },
          `    ${icon} ${agents[i]}  `,
        ),
      );
    }
    children.push('\n');
    children.push(React.createElement(Text, { key: 'ag-hint', color: THEME.dim }, '   \u2190\u2192 to select, Enter to confirm'));
  } else if (state.step === 'confirm') {
    const a = state.answers;
    children.push('\n\n');
    children.push(React.createElement(Text, { key: 'sum-h', bold: true, color: THEME.accent }, '   Recruit Summary:'));
    children.push('\n');
    children.push(React.createElement(Text, { key: 'sum-n', color: THEME.text }, `     Name:      ${a.name}`));
    children.push('\n');
    children.push(React.createElement(Text, { key: 'sum-a', color: THEME.text }, `     Agent:     ${a.agent}`));
    children.push('\n');
    children.push(React.createElement(Text, { key: 'sum-t', color: THEME.text }, `     Type:      ${a.playerType || '(default)'}`));
    children.push('\n');
    children.push(React.createElement(Text, { key: 'sum-d', color: THEME.text }, `     Directory: ${a.workDir}`));
    children.push('\n');
    children.push(React.createElement(Text, { key: 'sum-m', color: THEME.text }, `     Message:   ${a.initialMessage || '(none)'}`));
    children.push('\n');
    children.push(React.createElement(Text, { key: 'sum-h2', color: THEME.text }, `     Host:      ${a.host}`));
    children.push('\n\n');
    children.push(React.createElement(Text, { key: 'sum-hint', color: THEME.dim }, '   Press Enter to recruit, Esc to cancel'));
  } else if (state.step === 'done') {
    children.push('\n\n');
    if (state.error) {
      children.push(React.createElement(Text, { key: 'err', color: THEME.error, bold: true }, `   \u2717 Recruit failed: ${state.error}`));
      children.push('\n');
      children.push(React.createElement(Text, { key: 'err-h', color: THEME.dim }, '   Press Enter to return'));
    } else {
      children.push(React.createElement(Text, { key: 'ok1', color: THEME.success }, '   \u2714 Workflow created'));
      children.push('\n');
      children.push(React.createElement(Text, { key: 'ok2', color: THEME.success }, '   \u2714 Initial message queued'));
      children.push('\n');
      children.push(React.createElement(Text, { key: 'ok3', color: THEME.success }, '   \u2714 Process spawned'));
      children.push('\n\n');
      children.push(React.createElement(Text, { key: 'ok-h', color: THEME.dim }, '   Press Enter to return'));
    }
  } else if (state.submitting) {
    children.push('\n\n');
    children.push(React.createElement(Text, { key: 'sub', color: THEME.warning }, `   Recruiting ${state.answers.name}...`));
  } else if (TEXT_INPUT_STEPS.has(state.step)) {
    // Text input step — prompt line as Text, input in minimal Box
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
    // TextInput needs a Box — this is the only Box in the component
    // It renders AFTER the Text block below
  }

  // For text-input steps: render Text block + Box(TextInput) in a Fragment
  // For all other steps: single Text element (0 Yoga Box nodes)
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

function getAnswerDisplay(step: RecruitStep, answers: RecruitAnswers): string {
  switch (step) {
    case 'name': return answers.name;
    case 'agent': return answers.agent;
    case 'type': return answers.playerType || '(default)';
    case 'workDir': return answers.workDir;
    case 'message': return answers.initialMessage || '(none)';
    case 'host': return answers.host;
    default: return '';
  }
}

function getDefaultHint(step: RecruitStep, answers: RecruitAnswers): string | null {
  switch (step) {
    case 'workDir': return answers.workDir;
    case 'host': return 'localhost';
    case 'message': return 'press Enter to skip';
    case 'type': return 'press Enter for default';
    default: return null;
  }
}
