/**
 * RecruitWizard — step-by-step wizard for spawning a new player session.
 * Each completed step commits to <Static>; current step renders in live area.
 * Escape cancels and returns to main view.
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
    // Agent selection step: arrow keys to toggle
    if (state.step === 'agent') {
      if (key.leftArrow || key.rightArrow) {
        setAgentIndex(i => i === 0 ? 1 : 0);
      }
      if (key.return) {
        onAnswer({ agent: agents[agentIndex] });
        setInputValue('');
      }
    }
    // Confirm step
    if (state.step === 'confirm') {
      if (key.return) {
        onConfirm();
      }
    }
    // Done step
    if (state.step === 'done') {
      if (key.return) {
        onDone();
      }
    }
  }, [state.step, agentIndex, onAnswer, onCancel, onConfirm, onDone]));

  // Text input submit for text steps
  const handleTextSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    switch (state.step) {
      case 'name':
        if (!trimmed) return; // Required
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

  // ── Completed steps summary ──
  const completedSteps: React.ReactNode[] = [];
  const steps: RecruitStep[] = ['name', 'agent', 'type', 'workDir', 'message', 'host'];
  for (const s of steps) {
    if (s === state.step) break;
    const value = getAnswerDisplay(s, state.answers);
    completedSteps.push(
      React.createElement(Box, { key: s, paddingX: 1 },
        React.createElement(Text, { color: THEME.success }, '\u2714 '),
        React.createElement(Text, { color: THEME.dim }, `${STEP_LABELS[s]}: `),
        React.createElement(Text, { color: THEME.text }, value),
      ),
    );
  }

  // ── Current step ──
  let currentStepElement: React.ReactNode;

  if (state.step === 'agent') {
    // Agent selection with radio buttons
    const options = agents.map((a, i) => {
      const selected = i === agentIndex;
      const icon = selected ? '\u25CF' : '\u25CB'; // ● or ○
      return React.createElement(Text, {
        key: a,
        color: selected ? THEME.accent : THEME.dim,
        bold: selected,
      }, `  ${icon} ${a}  `);
    });

    currentStepElement = React.createElement(Box, { flexDirection: 'column', paddingX: 1 },
      React.createElement(Box, null,
        React.createElement(Text, { color: THEME.accent }, '? '),
        React.createElement(Text, { bold: true, color: THEME.text }, `${STEP_LABELS.agent}:`),
      ),
      React.createElement(Box, { marginLeft: 2 }, ...options),
      React.createElement(Text, { color: THEME.dim, dimColor: true }, '  \u2190\u2192 to select, Enter to confirm'),
    );
  } else if (state.step === 'confirm') {
    // Confirmation summary
    const a = state.answers;
    currentStepElement = React.createElement(Box, { flexDirection: 'column', paddingX: 1, marginTop: 1 },
      React.createElement(Text, { bold: true, color: THEME.accent }, '  Recruit Summary:'),
      React.createElement(Text, { color: THEME.text }, `    Name:      ${a.name}`),
      React.createElement(Text, { color: THEME.text }, `    Agent:     ${a.agent}`),
      React.createElement(Text, { color: THEME.text }, `    Type:      ${a.playerType || '(default)'}`),
      React.createElement(Text, { color: THEME.text }, `    Directory: ${a.workDir}`),
      React.createElement(Text, { color: THEME.text }, `    Message:   ${a.initialMessage || '(none)'}`),
      React.createElement(Text, { color: THEME.text }, `    Host:      ${a.host}`),
      React.createElement(Box, { marginTop: 1 },
        React.createElement(Text, { color: THEME.dim }, '  Press Enter to recruit, Esc to cancel'),
      ),
    );
  } else if (state.step === 'done') {
    if (state.error) {
      currentStepElement = React.createElement(Box, { flexDirection: 'column', paddingX: 1, marginTop: 1 },
        React.createElement(Text, { color: THEME.error, bold: true }, `  \u2717 Recruit failed: ${state.error}`),
        React.createElement(Text, { color: THEME.dim }, '  Press Enter to return'),
      );
    } else {
      currentStepElement = React.createElement(Box, { flexDirection: 'column', paddingX: 1, marginTop: 1 },
        React.createElement(Text, { color: THEME.success }, `  \u2714 Workflow created`),
        React.createElement(Text, { color: THEME.success }, `  \u2714 Initial message queued`),
        React.createElement(Text, { color: THEME.success }, `  \u2714 Process spawned`),
        React.createElement(Box, { marginTop: 1 },
          React.createElement(Text, { color: THEME.dim }, '  Press Enter to return'),
        ),
      );
    }
  } else if (state.submitting) {
    currentStepElement = React.createElement(Box, { paddingX: 1 },
      React.createElement(Text, { color: THEME.warning }, `  Recruiting ${state.answers.name}...`),
    );
  } else {
    // Text input step
    const defaultHint = getDefaultHint(state.step, state.answers);
    currentStepElement = React.createElement(Box, { flexDirection: 'column', paddingX: 1 },
      React.createElement(Box, null,
        React.createElement(Text, { color: THEME.accent }, '? '),
        React.createElement(Text, { bold: true, color: THEME.text }, `${STEP_LABELS[state.step]}:`),
        defaultHint
          ? React.createElement(Text, { color: THEME.dim }, ` (${defaultHint})`)
          : null,
      ),
      React.createElement(Box, { marginLeft: 2 },
        React.createElement(Text, { color: THEME.accent }, '> '),
        React.createElement(TextInput, {
          value: inputValue,
          onChange: setInputValue,
          onSubmit: handleTextSubmit,
        }),
      ),
    );
  }

  return React.createElement(Box, { flexDirection: 'column' },
    // Header
    React.createElement(Box, { paddingX: 1, marginBottom: 1 },
      React.createElement(Text, { bold: true, color: THEME.accent }, 'Recruit New Player'),
      React.createElement(Text, { color: THEME.dim }, '  (Esc to cancel)'),
    ),
    // Completed steps
    ...completedSteps,
    // Current step
    currentStepElement,
  );
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
