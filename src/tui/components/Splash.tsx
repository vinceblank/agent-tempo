/**
 * Splash screen with logo and metronome animation.
 * Shown during startup while connecting to Temporal/Maestro.
 */
import React, { useState, useEffect } from 'react';
import { useInk } from '../ink-context';
import { metronomeFrames, supportsUnicode } from '../utils/platform';

export interface SplashProps {
  status: string;
  ensemble: string;
}

export function Splash({ status, ensemble }: SplashProps) {
  const { Box, Text } = useInk();
  const [frame, setFrame] = useState(0);
  const frames = metronomeFrames();
  const unicode = supportsUnicode();

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % frames.length);
    }, 250);
    return () => clearInterval(timer);
  }, [frames.length]);

  const logo = unicode ? '\u266A claude-tempo' : '# claude-tempo';

  return React.createElement(Box, {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
    React.createElement(Text, { bold: true, color: 'cyan' }, logo),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { color: 'yellow' }, frames[frame]),
    ),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { dimColor: true }, status),
    ),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { dimColor: true }, `ensemble: ${ensemble}`),
    ),
  );
}
