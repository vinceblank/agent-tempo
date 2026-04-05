/**
 * Dynamic loader for ink — bridges CJS to ESM.
 *
 * Ink 4 is ESM-only. Our project is CJS. This module dynamically imports ink
 * at runtime via import(), which handles ESM from CJS contexts.
 *
 * React 18 is CJS and works with normal require().
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface InkExports {
  render: any;
  Text: any;
  Box: any;
  Newline: any;
  useInput: any;
  useApp: any;
  useStdout: any;
  Static: any;
  Spacer: any;
}

let cached: InkExports | null = null;

/**
 * Dynamically import ink.
 * Cached after first call.
 */
export async function loadInk(): Promise<InkExports> {
  if (cached) return cached;

  // @ts-expect-error — ink is ESM-only, dynamic import resolves at runtime
  const ink = await import('ink');

  cached = {
    render: ink.render,
    Text: ink.Text,
    Box: ink.Box,
    Newline: ink.Newline,
    useInput: ink.useInput,
    useApp: ink.useApp,
    useStdout: ink.useStdout,
    Static: ink.Static,
    Spacer: ink.Spacer,
  };

  return cached;
}
