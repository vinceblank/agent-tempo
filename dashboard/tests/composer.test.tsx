/**
 * Composer primitive — covers controlled/uncontrolled value handling,
 * the `@` / `/` glyph buttons (Slack-style, kept literal per chat2
 * iteration), and the `Cmd+Enter` / `Ctrl+Enter` submit shortcut.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Composer } from '../src/components/chat/Composer';

describe('Composer primitive', () => {
  it('renders the framed input + Slack-style @ / glyph buttons + Send', () => {
    render(<Composer placeholder="Message @conductor" />);
    expect(screen.getByTestId('composer')).toBeInTheDocument();
    expect(screen.getByTestId('composer-input')).toHaveAttribute(
      'placeholder',
      'Message @conductor',
    );
    expect(screen.getByTestId('composer-mention').textContent).toBe('@');
    expect(screen.getByTestId('composer-slash').textContent).toBe('/');
    expect(screen.getByTestId('composer-send')).toBeInTheDocument();
  });

  it('disables Send while the input is empty (uncontrolled)', () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const send = screen.getByTestId('composer-send');
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with the trimmed message when Send is clicked', () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '  hello world  ' } });
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(onSubmit).toHaveBeenCalledWith('hello world');
  });

  it('resets the textarea after an uncontrolled submit', () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'ping' } });
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(input.value).toBe('');
  });

  it('honors controlled mode (does not mutate state internally)', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    render(<Composer value="from-prop" onChange={onChange} onSubmit={onSubmit} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    expect(input.value).toBe('from-prop');
    fireEvent.change(input, { target: { value: 'next' } });
    expect(onChange).toHaveBeenCalledWith('next');
    // Caller didn't update `value`, so the textarea still reflects the prop.
    expect(input.value).toBe('from-prop');
  });

  it('forwards @ / / glyph-button clicks to onMention / onSlash', () => {
    const onMention = vi.fn();
    const onSlash = vi.fn();
    render(<Composer onMention={onMention} onSlash={onSlash} />);
    fireEvent.click(screen.getByTestId('composer-mention'));
    fireEvent.click(screen.getByTestId('composer-slash'));
    expect(onMention).toHaveBeenCalledOnce();
    expect(onSlash).toHaveBeenCalledOnce();
  });

  it('Ctrl/Cmd+Enter submits; plain Enter does not', () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'shortcut' } });

    // Plain Enter: no submit (allows newline insertion in the textarea).
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();

    // Modifier+Enter submits regardless of OS — the component checks
    // `metaKey` on Mac and `ctrlKey` elsewhere; we fire both so the
    // test passes on either branch.
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, metaKey: true });
    expect(onSubmit).toHaveBeenCalledWith('shortcut');
  });

  it('renders the keyboard hint adjacent to Send', () => {
    render(<Composer />);
    const composer = screen.getByTestId('composer');
    const hint = composer.querySelector('.composer-hint');
    expect(hint).toBeTruthy();
    // Hint text is OS-conditional (`⌘↩` on Mac, `Ctrl ↩` elsewhere).
    expect(hint?.textContent ?? '').toMatch(/↩/);
  });

  it('disables every interactive element when `disabled` is true', () => {
    render(<Composer disabled />);
    expect(screen.getByTestId('composer-input')).toBeDisabled();
    expect(screen.getByTestId('composer-mention')).toBeDisabled();
    expect(screen.getByTestId('composer-slash')).toBeDisabled();
    expect(screen.getByTestId('composer-send')).toBeDisabled();
  });
});
