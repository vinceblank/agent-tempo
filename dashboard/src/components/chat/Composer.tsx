/**
 * Composer — chat input primitive for the Maestro chat surface.
 *
 * **PR-A2 of #389**: presentational primitive only. PR-C2 wires it into
 * the live `Workspace` (replacing the legacy `MessageInput`).
 *
 * **#471/#472**: opt-in autofill — when callers pass `commands` or
 * `players`, the Composer renders an `<AutofillPopup>` above the input
 * and wires keyboard navigation (↑/↓/Tab/Esc) on top of the existing
 * Cmd/Ctrl+Enter submit shortcut. Existing call sites that pass neither
 * prop see zero UI or behaviour change.
 *
 * Layout matches the canonical handoff (`workspace.jsx:347-367`,
 * `web-design-system.html` "Composer" + chat2.md "Slack-style toolbar"
 * iteration):
 *
 *   - `.composer-frame` holds an auto-growing `<textarea>` and a toolbar.
 *   - Toolbar left = `@` / `/` glyph buttons (literal Slack glyphs, not
 *     abstract icons — kept verbatim from chat2 iteration).
 *   - Toolbar right = `⌘↩` / `Ctrl ↩` hint + a primary Send button.
 *   - `Cmd+Enter` (Mac) / `Ctrl+Enter` (other) submits.
 *
 * The textarea auto-grows up to 200px tall (`max-height` is also enforced
 * in CSS so the keyframe never exceeds it). Plain `Enter` inserts a
 * newline; only the modifier-Enter shortcut submits.
 */
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { Btn } from '../Btn';
import { AutofillPopup } from './AutofillPopup';
import { useAutofill } from '../../lib/use-autofill';
import type { DashboardCommandMeta } from '../../lib/dashboard-commands';

/**
 * IS_MAC — global hint for keyboard-shortcut display + handling.
 *
 * Resolved once at module load (the user's OS doesn't change between
 * navigations). Falls back to `false` under SSR / non-browser envs.
 */
export const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test(
    navigator.platform || navigator.userAgent || '',
  );

interface ComposerProps {
  /** Placeholder shown when the textarea is empty. */
  placeholder?: string;
  /** Initial / controlled value. Pass with `onChange` for controlled mode. */
  value?: string;
  /** Default value for uncontrolled mode (ignored when `value` is set). */
  defaultValue?: string;
  /** Fires for every keystroke when the value changes. */
  onChange?: (next: string) => void;
  /** Fires when the user submits via shortcut or the Send button. */
  onSubmit?: (message: string) => void;
  /** Fires when the user clicks the `@` mention glyph button. */
  onMention?: () => void;
  /** Fires when the user clicks the `/` slash-command glyph button. */
  onSlash?: () => void;
  /** Disables the input and Send button. */
  disabled?: boolean;
  /** Optional label override for the Send button. */
  sendLabel?: string;
  /** Custom testid prefix; defaults to `composer`. */
  testIdPrefix?: string;
  /**
   * #471/#472 — opt-in slash-command autofill. When non-empty, typing `/`
   * surfaces a filtered popup of these commands; Tab accepts, Esc closes.
   * Empty / omitted disables `/` autofill.
   */
  commands?: readonly DashboardCommandMeta[];
  /**
   * #471/#472 — opt-in `@` and player-arg autofill. When non-empty, typing
   * `@` (or a player-arg command followed by space) surfaces a filtered
   * popup of player names. Empty / omitted disables player autofill.
   */
  players?: readonly string[];
}

export interface ComposerHandle {
  /** Focus the textarea. */
  focus: () => void;
  /** Clear the textarea and reset its measured height. */
  clear: () => void;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    placeholder = 'Message…',
    value,
    defaultValue,
    onChange,
    onSubmit,
    onMention,
    onSlash,
    disabled = false,
    sendLabel = 'Send',
    testIdPrefix = 'composer',
    commands,
    players,
  },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const isControlled = value !== undefined;
  const [internal, setInternal] = useState(defaultValue ?? '');
  const current = isControlled ? value : internal;
  const autofillEnabled = (commands?.length ?? 0) > 0 || (players?.length ?? 0) > 0;

  /** Auto-size the textarea up to the CSS `max-height: 200px` cap. */
  const autoSize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  /**
   * Programmatic value-set used by the autofill hook (and the glyph
   * buttons when autofill is enabled). Routes through controlled /
   * uncontrolled paths so callers see the change either way.
   */
  const setValue = useCallback(
    (next: string) => {
      if (!isControlled) setInternal(next);
      onChange?.(next);
      // Defer auto-size + cursor placement so React commits the new value
      // first; otherwise the textarea height measurement is one frame stale.
      requestAnimationFrame(() => {
        autoSize();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          const end = next.length;
          el.setSelectionRange(end, end);
        }
      });
    },
    [isControlled, onChange, autoSize],
  );

  const autofill = useAutofill({
    value: current,
    commands,
    players,
    onApply: setValue,
  });

  const handleChange = (ev: ChangeEvent<HTMLTextAreaElement>) => {
    const next = ev.target.value;
    if (!isControlled) setInternal(next);
    onChange?.(next);
    autoSize();
  };

  const trimmed = current.trim();
  const canSubmit = trimmed.length > 0 && !disabled;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit?.(trimmed);
    if (!isControlled) {
      setInternal('');
      // Defer height reset so React commits the empty value first.
      requestAnimationFrame(autoSize);
    }
    autofill.reset();
  };

  const handleKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    // Autofill keyboard handling — runs first, only when popup is open.
    if (autofill.visible) {
      if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        autofill.up();
        return;
      }
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        autofill.down();
        return;
      }
      if (ev.key === 'Tab') {
        ev.preventDefault();
        autofill.accept();
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        autofill.close();
        return;
      }
    }
    // Default Enter behaviour: only modifier+Enter submits; plain Enter
    // inserts a newline (textarea default). Mirrors the TUI's Tab-accept /
    // Enter-submit policy — Enter never accepts an autofill suggestion to
    // keep the dead-key trap (#306) shut.
    if (ev.key !== 'Enter') return;
    const modifier = IS_MAC ? ev.metaKey : ev.ctrlKey;
    if (!modifier) return;
    ev.preventDefault();
    submit();
  };

  /**
   * Glyph-button click — when autofill is enabled, also seed the input
   * with the glyph so the popup opens. The legacy onMention / onSlash
   * callbacks still fire so existing call sites and tests see no change
   * in behaviour.
   */
  const handleMention = () => {
    onMention?.();
    if (autofillEnabled && current === '') setValue('@');
  };
  const handleSlash = () => {
    onSlash?.();
    if (autofillEnabled && current === '') setValue('/');
  };

  useImperativeHandle(
    ref,
    () => ({
      focus: () => textareaRef.current?.focus(),
      clear: () => {
        if (!isControlled) setInternal('');
        const el = textareaRef.current;
        if (el) {
          el.value = '';
          el.style.height = 'auto';
        }
      },
    }),
    [isControlled],
  );

  const hint = IS_MAC ? '⌘↩' : 'Ctrl ↩';
  const hintTitle = IS_MAC ? 'Cmd + Return to send' : 'Ctrl + Enter to send';
  const popupPrefix: '/' | '@' = autofill.mode === 'command' ? '/' : '@';

  return (
    <div className="composer" data-testid={testIdPrefix}>
      {/* `position: relative` anchors the AutofillPopup above the frame.
        * Inline because this is the only consumer of the anchor today —
        * no need to bloat components.css for one rule. */}
      <div className="composer-frame" style={{ position: 'relative' }}>
        <AutofillPopup
          visible={autofill.visible}
          items={autofill.items}
          selectedIndex={autofill.selectedIndex}
          prefix={popupPrefix}
          onSelect={(i) => autofill.acceptAt(i)}
          testId={`${testIdPrefix}-autofill`}
        />
        <textarea
          ref={textareaRef}
          className="composer-input"
          rows={1}
          placeholder={placeholder}
          disabled={disabled}
          // Always pass `value` so internal-state resets (Send / clear)
          // propagate to the DOM. In uncontrolled mode, internal state
          // is seeded from `defaultValue` and the parent never sees
          // the prop again.
          value={current}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          aria-label="Message text"
          aria-autocomplete={autofillEnabled ? 'list' : undefined}
          aria-expanded={autofill.visible || undefined}
          data-testid={`${testIdPrefix}-input`}
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <button
              type="button"
              className="composer-icon"
              title="Mention a player"
              aria-label="Mention a player"
              disabled={disabled}
              onClick={handleMention}
              data-testid={`${testIdPrefix}-mention`}
            >
              @
            </button>
            <button
              type="button"
              className="composer-icon"
              title="Slash command"
              aria-label="Slash command"
              disabled={disabled}
              onClick={handleSlash}
              data-testid={`${testIdPrefix}-slash`}
            >
              /
            </button>
          </div>
          <div className="composer-send">
            <span className="composer-hint mono dim" title={hintTitle}>
              {hint}
            </span>
            <Btn
              variant="primary"
              size="md"
              onClick={submit}
              disabled={!canSubmit}
              aria-disabled={!canSubmit}
              data-testid={`${testIdPrefix}-send`}
            >
              {sendLabel}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
});
