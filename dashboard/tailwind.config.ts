import type { Config } from 'tailwindcss';

// Tailwind 4 uses CSS-first `@theme` (see `src/styles/tokens.css`) for color
// and density tokens. This config is intentionally minimal — the V4 plugin
// loaded via `@tailwindcss/vite` does the heavy lifting; we only need the
// content globs and the fontFamily aliases for utility classes.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        serif: ['Fraunces', 'Times New Roman', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
} satisfies Config;
