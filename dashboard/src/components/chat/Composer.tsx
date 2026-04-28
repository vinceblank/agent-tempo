/**
 * Composer — chat input primitive for the Maestro chat surface.
 *
 * **PR-A2 of #389**: presentational primitive only. PR-C2 wires it into
 * the live `Workspace` (replacing the legacy `MessageInput`). Until then
 * this component owns no mutation state — callers pass `onSubmit` and
 * decide what to do with the trimmed message.
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
  },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const isControlled = value !== undefined;
  const [internal, setInternal] = useState(defaultValue ?? '');
  const current = isControlled ? value : internal;

  /** Auto-size the textarea up to the CSS `max-height: 200px` cap. */
  const autoSize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

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
  };

  const handleKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key !== 'Enter') return;
    const modifier = IS_MAC ? ev.metaKey : ev.ctrlKey;
    if (!modifier) return;
    ev.preventDefault();
    submit();
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

  return (
    <div className="composer" data-testid={testIdPrefix}>
      <div className="composer-frame">
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
              onClick={onMention}
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
              onClick={onSlash}
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
