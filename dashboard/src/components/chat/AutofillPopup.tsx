/**
 * AutofillPopup — chat-input autocomplete dropdown for the dashboard
 * Composer (#471/#472).
 *
 * Pure-presentational. State (visibility, items, selection) lives in
 * `useAutofill`; the popup just renders the items and reports clicks.
 *
 * Visual model mirrors the TUI's CommandPalette overlay
 * (src/tui/components/CommandPalette.tsx):
 *   - For `command` and `player` modes, items render as a list with the
 *     prefix glyph (`/` or `@`) on the left.
 *   - For `command` mode, the description shows next to each name.
 *   - The selected item gets `is-selected` class for keyboard nav
 *     highlight; clicking any item also accepts that item.
 *
 * Position: absolute, anchored to the top of the composer-frame so it
 * floats just above the input. The composer-frame must be
 * `position: relative` for this to anchor — the Composer applies that
 * via inline style alongside the existing class.
 */
import type { AutofillItem } from '../../lib/use-autofill';

const MAX_VISIBLE = 8;

export interface AutofillPopupProps {
  /** Whether the popup renders. */
  visible: boolean;
  /** Items to display. Empty with `visible` true is treated as hidden. */
  items: AutofillItem[];
  /** 0-based index of the highlighted item. */
  selectedIndex: number;
  /** The prefix glyph shown on each row — `/` for commands, `@` for players. */
  prefix: '/' | '@';
  /** Called when the user clicks an item; passes its index. */
  onSelect: (index: number) => void;
  /** Custom testid; defaults to `composer-autofill`. */
  testId?: string;
}

export function AutofillPopup({
  visible,
  items,
  selectedIndex,
  prefix,
  onSelect,
  testId = 'composer-autofill',
}: AutofillPopupProps) {
  if (!visible || items.length === 0) return null;

  // Window the visible items around the selection — same pattern as the
  // TUI's CommandPalette so the highlight never scrolls off-screen on
  // long player rosters.
  let startIdx = 0;
  if (items.length > MAX_VISIBLE) {
    startIdx = Math.max(
      0,
      Math.min(selectedIndex - Math.floor(MAX_VISIBLE / 2), items.length - MAX_VISIBLE),
    );
  }
  const windowed = items.slice(startIdx, startIdx + MAX_VISIBLE);

  return (
    <div
      data-testid={testId}
      role="listbox"
      aria-label={prefix === '/' ? 'Slash command suggestions' : 'Player suggestions'}
      style={{
        position: 'absolute',
        bottom: 'calc(100% + 6px)',
        left: 0,
        right: 0,
        background: 'var(--bg-2)',
        border: '1px solid var(--rule-strong)',
        borderRadius: 8,
        boxShadow: '0 6px 18px rgb(0 0 0 / 0.18)',
        maxHeight: 280,
        overflow: 'auto',
        zIndex: 40,
        padding: 4,
      }}
    >
      {startIdx > 0 && (
        <div
          className="dim"
          style={{ padding: '4px 10px', fontSize: 11, fontFamily: 'var(--ff-mono)' }}
        >
          ↑ {startIdx} more above
        </div>
      )}
      {windowed.map((item, i) => {
        const actualIdx = startIdx + i;
        const isSelected = actualIdx === selectedIndex;
        return (
          <button
            key={`${prefix}${item.name}`}
            type="button"
            role="option"
            aria-selected={isSelected}
            data-testid={`${testId}-item-${item.name}`}
            data-selected={isSelected ? 'true' : undefined}
            onMouseDown={(ev) => {
              // Use mouseDown (not click) so the textarea doesn't lose
              // focus before the handler fires — the parent expects the
              // input to stay focused after a popup pick.
              ev.preventDefault();
              onSelect(actualIdx);
            }}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
              width: '100%',
              padding: '6px 10px',
              borderRadius: 6,
              border: 0,
              background: isSelected
                ? 'color-mix(in oklch, var(--accent), transparent 80%)'
                : 'transparent',
              color: isSelected ? 'var(--text)' : 'var(--text-2)',
              cursor: 'pointer',
              fontFamily: 'var(--ff-ui)',
              fontSize: 13,
              textAlign: 'left',
              transition: 'background 0.08s, color 0.08s',
            }}
          >
            <span
              className="mono"
              style={{
                color: isSelected ? 'var(--accent)' : 'var(--muted)',
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              {prefix}
              {item.name}
            </span>
            {item.description && (
              <span
                className="dim"
                style={{
                  fontSize: 12,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                }}
              >
                {item.description}
              </span>
            )}
          </button>
        );
      })}
      {startIdx + MAX_VISIBLE < items.length && (
        <div
          className="dim"
          style={{ padding: '4px 10px', fontSize: 11, fontFamily: 'var(--ff-mono)' }}
        >
          ↓ {items.length - startIdx - MAX_VISIBLE} more below
        </div>
      )}
    </div>
  );
}
