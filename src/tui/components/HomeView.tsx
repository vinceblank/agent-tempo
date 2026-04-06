/**
 * HomeView — ensemble list with arrow-key navigation.
 * Shows all discovered ensembles and lets the user select one.
 */
import React, { useCallback } from 'react';
import { useInk } from '../ink-context';
import { supportsUnicode, statusIcons, titleArt, titleArtFits, getTerminalSize } from '../utils/platform';
import { Footer } from './Footer';
import type { EnsembleSummary } from '../core-api';

export interface HomeViewProps {
  ensembles: EnsembleSummary[];
  selectedIndex: number;
  onSelect: (ensemble: string) => void;
  onQuit: () => void;
  onNavigate: (direction: 'up' | 'down') => void;
}

const VERSION = require('../../../package.json').version as string;

export function HomeView({ ensembles, selectedIndex, onSelect, onQuit, onNavigate }: HomeViewProps) {
  const { Box, Text, useInput } = useInk();
  const icons = statusIcons();
  const unicode = supportsUnicode();

  useInput(useCallback((input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean }) => {
    if (input === 'q') {
      onQuit();
    } else if (key.upArrow || input === 'k') {
      onNavigate('up');
    } else if (key.downArrow || input === 'j') {
      onNavigate('down');
    } else if (key.return && ensembles.length > 0) {
      onSelect(ensembles[selectedIndex].name);
    }
  }, [onQuit, onNavigate, onSelect, ensembles, selectedIndex]));

  const title = unicode ? '\u266A claude-tempo' : '# claude-tempo';
  const { columns } = getTerminalSize();
  const showArt = titleArtFits(columns);
  const artLines = showArt ? titleArt(unicode) : [];

  /** Render the header — block-letter title if it fits, plain text fallback. */
  function renderHeader() {
    if (showArt) {
      return React.createElement(Box, { flexDirection: 'column', alignItems: 'center', marginBottom: 1 },
        ...artLines.map((line, i) =>
          React.createElement(Text, { key: `art-${i}`, bold: true, color: 'cyan' }, line),
        ),
        React.createElement(Text, { dimColor: true }, `v${VERSION}`),
      );
    }
    return React.createElement(Box, { paddingX: 1, marginBottom: 1 },
      React.createElement(Text, { bold: true, color: 'cyan' }, title),
      React.createElement(Text, { dimColor: true }, `  v${VERSION}`),
    );
  }

  // ── Empty state ──
  if (ensembles.length === 0) {
    return React.createElement(Box, { flexDirection: 'column', height: '100%' },
      // Header
      renderHeader(),
      // Empty message
      React.createElement(Box, { flexGrow: 1, flexDirection: 'column', alignItems: 'center', justifyContent: 'center' },
        React.createElement(Text, { dimColor: true }, 'No ensembles running.'),
        React.createElement(Box, { marginTop: 1 },
          React.createElement(Text, { color: 'yellow' }, 'Start one with: '),
          React.createElement(Text, { bold: true }, 'claude-tempo up <name>'),
        ),
      ),
      // Footer
      React.createElement(Footer, { hints: [{ key: 'q', label: 'Quit' }] }),
    );
  }

  // ── Ensemble list ──
  return React.createElement(Box, { flexDirection: 'column', height: '100%' },
    // Header
    renderHeader(),
    // List
    React.createElement(Box, { flexDirection: 'column', flexGrow: 1, paddingX: 1 },
      ...ensembles.map((ens, i) => {
        const isSelected = i === selectedIndex;
        const cursor = isSelected ? '>' : ' ';
        const conductorBadge = ens.hasConductor
          ? React.createElement(Text, { color: 'green' }, ` ${icons.active}`)
          : React.createElement(Text, { dimColor: true }, ` ${icons.stale}`);

        return React.createElement(Box, { key: ens.name },
          React.createElement(Text, { color: isSelected ? 'cyan' : undefined, bold: isSelected },
            `${cursor} ${ens.name}`,
          ),
          React.createElement(Text, { dimColor: true },
            ` (${ens.playerCount} player${ens.playerCount !== 1 ? 's' : ''})`,
          ),
          conductorBadge,
        );
      }),
    ),
    // Footer
    React.createElement(Footer, {
      hints: [
        { key: '\u2191\u2193', label: 'Navigate' },
        { key: 'Enter', label: 'Select' },
        { key: 'q', label: 'Quit' },
      ],
    }),
  );
}
