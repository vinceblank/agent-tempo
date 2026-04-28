# TUI Design System

_Started 2026-04-25 01:48 UTC_

---

## User

GitHub connected

## Assistant

Welcome! I can explore a GitHub repo's structure and pull selected files in to use as reference for design work. Paste a github.com URL (repo, folder, or file) and let me know what you'd like to build.

## User

I want to create a design system for the TUI interface I am building in my claude-tempo repository.

## Assistant

I'll help you create a design system for your claude-tempo TUI. Let me first explore the repository to understand what you're building.

_[tool: github_list_repos]_

_[tool: github_get_tree]_

Let me dig into the TUI-related code and docs to understand what you're building.

_[tool: github_read_file]_

_[tool: github_read_file]_

_[tool: github_get_tree]_

Now let me dig into the TUI itself to see what's actually there today.

_[tool: github_get_tree]_

_[tool: github_read_file]_

Let me read the existing theme file and a couple of representative TUI components to see what visual vocabulary already exists.

_[tool: github_read_file]_

_[tool: github_read_file]_

_[tool: github_read_file]_

_[tool: github_read_file]_

_[tool: github_read_file]_

_[tool: github_read_file]_

I have a solid read of the TUI's visual vocabulary. Let me also check the format utils (phase colors/icons) and two more component files to understand icon & state conventions.

_[tool: github_read_file]_

I have a complete picture now. Let me lock in the design plan and build the design system documentation.

_[tool: snip]_

_[tool: update_todos]_

## Design system plan

I'm going to build a single-page HTML design system reference for the claude-tempo TUI. It will document what already exists in the codebase and formalize it as a system:

**Approach (pulled directly from the repo):**
- **Aesthetic**: dark terminal, warm-neutral palette. Terracotta accent (#E07A5F) paired with cream foreground (#FAF3EE) on near-black (#0A0E12). The metronome/music-notation motif (♩ ★ •) is already the brand vocabulary — I'll lean into it.
- **Type**: monospace only (as the medium demands). I'll use JetBrains Mono for the spec rendering.
- **Sections**: Brand (logo, motif, voice) → Color tokens (full palette w/ hex + role) → Typography (hierarchy + Ink Text props) → Iconography (phase icons, glyphs, Unicode/ASCII fallbacks) → Layout (TUI shell anatomy) → Components (TitleBar, StatusBar, StatusOverlay, CommandPalette, ConversationStream, PromptArea, Splash) → Phase state machine (attachment-phase → label/color/icon table) → Accessibility (NO_COLOR, 80×24 min, Unicode fallback) → Performance rules (single-Text root pattern).
- Each component section shows a rendered mock (terminal frame with the actual characters) + the exact theme tokens it uses.

_[tool: write_file]_

_[tool: snip]_

_[tool: done]_

_[tool: snip]_

_[tool: fork_verifier_agent]_

Built a single-page design system doc at **design-system.html** covering the claude-tempo TUI, sourced directly from `src/tui/utils/theme.ts`, `platform.ts`, and `format.ts`.

**What's in it:**
1. **Brand** — metronome mark, quarter-note ♩ glyph, voice guidelines
2. **Color** — all 12 tokens (bg, bgTitle, border, muted, dim, text, textMuted, accent, success, warning, error, inputBg) with hex + role
3. **Typography** — monospace-only hierarchy via Ink `<Text>` props
4. **Iconography** — full glyph table with Unicode + ASCII fallbacks
5. **Layout** — shell anatomy (TitleBar, Scrollback, ConversationStream, CommandPalette, PromptArea, StatusBar)
6. **Components** — rendered terminal mocks for each component with the exact tokens they consume
7. **Phase state matrix** — the 7→5 attachment-phase mapping as a single source of truth
8. **Accessibility** — NO_COLOR, Unicode fallback, 80×24 minimum, keyboard-only
9. **Performance rules** — single-Text root, frozen lookup maps, uncontrolled inputs
10. **Do / don't** — concise usage rules

Every component example is rendered as a real terminal frame so you can compare against live output. Let me know if you want me to add more components (ErrorView, Picker, PlayerDetailView, ScheduleOverlay), export a tokens file (CSS vars / TS constants), or split it into per-component pages.

## User

Verifier agent check completed

## Assistant

_[tool: snip]_

The design system doc is ready at **design-system.html**. Let me know if you'd like me to extend it with a light theme, a compact/comfortable spacing variant, additional components (ErrorView, Picker, PlayerDetailView, ScheduleOverlay), or export the tokens as a shareable `tokens.ts` / `tokens.css` file.

