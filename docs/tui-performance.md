# TUI Performance (Ink/React)

> Hard-won lessons from debugging input lag in the TUI (#58). Apply these whenever touching
> `src/tui/`. The root cause in every case was Ink's rendering model — understanding it prevents
> reintroducing the same problems.

## Rendering model

**Fullscreen bypass is permanent**: When `lastOutputHeight >= stdout.rows`, Ink permanently
switches to `clearTerminal + full-rewrite` on every frame — this never resets. Every
component/phase must render within `height: termRows - 1` to stay in the fast `throttledLog`
path (in-place line updates). Once you trigger the full-rewrite path, every keystroke redraws
the entire screen.

**Animation timers poison rendering**: `setInterval`-based animations (spinners, metronomes)
trigger re-renders every 80–150ms. Each re-render runs the full Yoga layout + output pipeline
for all nodes. Never use animation timers in components that coexist with input areas — rapid
re-renders cause input lag.

## Yoga layout

**Yoga node count: keep under ~20**: Every `<Box>` creates a Yoga layout node; every keystroke
recalculates all of them. 100+ nodes = laggy input. Prefer nested `<Text>` over `<Box><Text>` —
nested Text creates `ink-virtual-text` with zero Yoga nodes. Pre-format content as strings with
`\n` and render as a single `<Text>`.

**Cap live message counts**: ChatView and similar message lists must limit visible messages
(~20). Rendering hundreds of messages in the live Yoga tree creates 1000+ React elements that
slow reconciliation and output generation. Show a "↑ N earlier messages" indicator when
truncated. Future: adopt Ink's `<Static>` pattern (render-once, exit Yoga tree) like Claude Code
does for scroll history.

## React state

**Uncontrolled input pattern**: Input components must not dispatch to parent state on every
keystroke. Use local `useState` + `useImperativeHandle` ref for parent communication. Guard all
callbacks (e.g. `onPaletteToggle`) to only fire when values actually change — otherwise you get
silent parent re-renders on every keypress.

**Reducer state identity matters**: `return { ...state, field: sameValue }` creates a new object
reference and triggers a re-render even when nothing changed. Always check before spreading:
`if (!state.paletteVisible && state.paletteIndex === 0) return state;`

**Stale refs between renders**: When using the ref pattern for stable `useInput` callbacks,
values read from `ref.current` are only updated on React render. For values that change between
renders (e.g. input value), update `ref.current.value` synchronously inside the setter — not
just on render. Otherwise rapid keystrokes (e.g. holding backspace) read stale values and drop
inputs.

## Debugging

**Debugging approach**: When diagnosing Ink lag, create minimal test apps (`.mjs`) adding one
factor at a time (fullscreen, Temporal, InkProvider, real components) to isolate the cause. If
the minimal app is fast but the real app is slow, the component tree is the culprit — not the
infrastructure.

## Terminal size

The TUI requires a minimum terminal size of **80×24**. If the terminal is smaller at launch, the
process exits with code 1 with an explanatory message. A soft in-app warning appears at 60×15
during resize.

## Related

- [tui.md](tui.md) — TUI feature reference
- `src/tui/` — source code
