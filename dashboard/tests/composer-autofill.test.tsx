/**
 * Composer autofill — popup render, filter, keyboard navigation, mouse
 * pick (#471/#472).
 *
 * Pinned behaviours:
 *   - `/` opens the slash-command popup with all commands listed.
 *   - `/h` filters down to the matching command (`help`).
 *   - `@` opens the player popup with all players listed.
 *   - `↓` / `↑` move the highlight; `Tab` accepts; `Esc` closes.
 *   - Click on a row replaces the input with the selection.
 *   - When neither `commands` nor `players` is passed, no popup ever
 *     renders (opt-in regression check — keeps every existing call site
 *     unchanged).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Composer } from '../src/components/chat/Composer';
import { DASHBOARD_COMMANDS } from '../src/lib/dashboard-commands';

const PLAYERS = ['tempo-conductor', 'tempo-eng', 'tempo-qa', 'alice'];

describe('Composer autofill — slash mode (#472)', () => {
  it('renders the popup when the user types "/"', () => {
    render(<Composer commands={DASHBOARD_COMMANDS} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/' } });
    const popup = screen.getByTestId('composer-autofill');
    expect(popup).toBeInTheDocument();
    expect(popup).toHaveAttribute('role', 'listbox');
    // Empty partial → all commands listed.
    for (const cmd of DASHBOARD_COMMANDS) {
      expect(screen.getByTestId(`composer-autofill-item-${cmd.name}`)).toBeInTheDocument();
    }
  });

  it('filters commands as the user types more characters', () => {
    render(<Composer commands={DASHBOARD_COMMANDS} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/h' } });
    expect(screen.getByTestId('composer-autofill-item-help')).toBeInTheDocument();
    // `clear` no longer matches.
    expect(screen.queryByTestId('composer-autofill-item-clear')).toBeNull();
  });

  it('Tab accepts the highlighted command and updates the input', () => {
    render(<Composer commands={DASHBOARD_COMMANDS} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/h' } });
    fireEvent.keyDown(input, { key: 'Tab' });
    // The accepted value is `<replacePrefix><name> ` per the hook contract.
    expect(input.value).toBe('/help ');
    // Popup hides after acceptance because the value `/help ` no longer
    // classifies as command mode (trailing space → no longer
    // command-without-space).
    expect(screen.queryByTestId('composer-autofill')).toBeNull();
  });

  it('Escape closes the popup until the value changes again', () => {
    render(<Composer commands={DASHBOARD_COMMANDS} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/' } });
    expect(screen.getByTestId('composer-autofill')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('composer-autofill')).toBeNull();
    // Typing more characters re-opens it (forced-closed flag clears on
    // value change).
    fireEvent.change(input, { target: { value: '/c' } });
    expect(screen.getByTestId('composer-autofill')).toBeInTheDocument();
  });

  it('arrow keys move the highlight and Tab accepts the new selection', () => {
    render(<Composer commands={DASHBOARD_COMMANDS} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/' } });
    // Initially the first command (help) is highlighted.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Tab' });
    // After ArrowDown once + Tab → second command in the registry.
    expect(input.value).toBe(`/${DASHBOARD_COMMANDS[1].name} `);
  });

  it('clicking a row inserts that row regardless of keyboard highlight', () => {
    render(<Composer commands={DASHBOARD_COMMANDS} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/' } });
    // Click the `clear` item directly (bypasses the keyboard selectedIndex).
    fireEvent.mouseDown(screen.getByTestId('composer-autofill-item-clear'));
    expect(input.value).toBe('/clear ');
  });
});

describe('Composer autofill — player mode (#471)', () => {
  it('renders the popup when the user types "@"', () => {
    render(<Composer players={PLAYERS} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@' } });
    const popup = screen.getByTestId('composer-autofill');
    expect(popup).toBeInTheDocument();
    expect(popup).toHaveAttribute('aria-label', 'Player suggestions');
    for (const p of PLAYERS) {
      expect(screen.getByTestId(`composer-autofill-item-${p}`)).toBeInTheDocument();
    }
  });

  it('filters via prefix + segment match (matches TUI semantics)', () => {
    render(<Composer players={PLAYERS} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@te' } });
    // `te` matches `tempo-conductor`, `tempo-eng`, `tempo-qa` (prefix).
    expect(screen.getByTestId('composer-autofill-item-tempo-conductor')).toBeInTheDocument();
    expect(screen.getByTestId('composer-autofill-item-tempo-eng')).toBeInTheDocument();
    expect(screen.getByTestId('composer-autofill-item-tempo-qa')).toBeInTheDocument();
    expect(screen.queryByTestId('composer-autofill-item-alice')).toBeNull();
  });

  it('Tab accepts the highlighted player', () => {
    render(<Composer players={PLAYERS} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@al' } });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.value).toBe('@alice ');
  });

  it('Cmd/Ctrl+Enter still submits even when popup is open', () => {
    const onSubmit = vi.fn();
    render(<Composer players={PLAYERS} onSubmit={onSubmit} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@al' } });
    expect(screen.getByTestId('composer-autofill')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, metaKey: true });
    expect(onSubmit).toHaveBeenCalledWith('@al');
  });
});

describe('Composer autofill — opt-in regression (#471/#472)', () => {
  it('renders no popup when neither commands nor players are passed', () => {
    render(<Composer />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/' } });
    expect(screen.queryByTestId('composer-autofill')).toBeNull();
    fireEvent.change(input, { target: { value: '@anyone' } });
    expect(screen.queryByTestId('composer-autofill')).toBeNull();
  });

  it('does not break the existing onMention / onSlash glyph contract', () => {
    const onMention = vi.fn();
    const onSlash = vi.fn();
    render(<Composer commands={DASHBOARD_COMMANDS} players={PLAYERS} onMention={onMention} onSlash={onSlash} />);
    fireEvent.click(screen.getByTestId('composer-mention'));
    fireEvent.click(screen.getByTestId('composer-slash'));
    expect(onMention).toHaveBeenCalledOnce();
    expect(onSlash).toHaveBeenCalledOnce();
  });

  it('glyph-button click also seeds the input when autofill is enabled and input is empty', () => {
    // UX nicety — with autofill on, clicking the @ button should open
    // the popup (by setting the value to `@`). When the input already
    // has text the click is a no-op on the value (still fires onMention).
    const { rerender } = render(<Composer players={PLAYERS} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.click(screen.getByTestId('composer-mention'));
    expect(input.value).toBe('@');

    // With existing text, glyph click does NOT clobber the input.
    rerender(<Composer players={PLAYERS} value="hello" onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('composer-mention'));
    // Controlled `value` wins — the seed-on-click guard checks `current === ''`.
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('hello');
  });
});
