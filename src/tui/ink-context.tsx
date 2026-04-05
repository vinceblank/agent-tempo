/**
 * React context for Ink components.
 *
 * Since ink is ESM-only and our project is CJS, ink components are
 * dynamically loaded at startup and provided via context. Components
 * use the useInk() hook to access Box, Text, etc.
 */
import React, { createContext, useContext } from 'react';
import type { InkExports } from './ink-loader';

const InkContext = createContext<InkExports | null>(null);

export function InkProvider({ ink, children }: { ink: InkExports; children: React.ReactNode }) {
  return React.createElement(InkContext.Provider, { value: ink }, children);
}

/**
 * Access dynamically-loaded Ink components.
 * Must be called inside an InkProvider.
 */
export function useInk(): InkExports {
  const ctx = useContext(InkContext);
  if (!ctx) throw new Error('useInk() must be used inside InkProvider');
  return ctx;
}
