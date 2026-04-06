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
  TextInput: any;
  Spinner: any;
}

let cached: InkExports | null = null;

/**
 * Dynamically import ink.
 * Cached after first call.
 */
export async function loadInk(): Promise<InkExports> {
  if (cached) return cached;

  // Use indirect import() to prevent TypeScript from converting it to require()
  // when compiling to CommonJS. ink 4+ is ESM-only and needs a real import().
  const dynamicImport = new Function('specifier', 'return import(specifier)');
  const [ink, inkTextInput, inkSpinner] = await Promise.all([
    dynamicImport('ink'),
    dynamicImport('ink-text-input'),
    dynamicImport('ink-spinner'),
  ]);

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
    TextInput: inkTextInput.default || inkTextInput.TextInput,
    Spinner: inkSpinner.default || inkSpinner.Spinner,
  };

  return cached;
}
