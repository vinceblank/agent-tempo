/**
 * Footer — keybinding hint bar.
 * Renders a row of key-label pairs separated by spaces.
 */
import React from 'react';
import { useInk } from '../ink-context';

export interface FooterProps {
  hints: Array<{ key: string; label: string }>;
}

export function Footer({ hints }: FooterProps) {
  const { Box, Text } = useInk();

  return React.createElement(Box, { paddingX: 1, marginTop: 1 },
    ...hints.map((hint, i) =>
      React.createElement(Box, { key: hint.key, marginRight: 2 },
        React.createElement(Text, { bold: true, color: 'yellow' }, hint.key),
        React.createElement(Text, { dimColor: true }, ` ${hint.label}`),
        // No trailing separator after last hint
      ),
    ),
  );
}
