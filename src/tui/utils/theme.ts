/**
 * TUI color theme constants.
 * Used by all TUI components for consistent styling.
 * Respects NO_COLOR (https://no-color.org/) — all colors become undefined.
 */

const COLORS = {
  bg: '#0A0E12',
  bgTitle: '#141820',
  border: '#2A3140',
  muted: '#3D4555',
  dim: '#6B7280',
  text: '#FAF3EE',
  textMuted: '#9CA3AF',
  accent: '#E07A5F', // terracotta
  success: '#81C784',
  warning: '#F2CC8F',
  error: '#EF5350',
  inputBg: '#1A1F28',
};

const MONO: Record<string, undefined> = Object.fromEntries(
  Object.keys(COLORS).map(k => [k, undefined])
) as any;

export const THEME: typeof COLORS = process.env.NO_COLOR ? MONO as any : COLORS;
