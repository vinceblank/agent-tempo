/**
 * ResponsivePanel — verifies the variant flips between `dialog` and
 * `sheet` based on `matchMedia('(min-width: 768px)')`.
 *
 * jsdom doesn't include CSS media queries by default, so the tests
 * stub `window.matchMedia` to drive both branches deterministically.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResponsivePanel } from '../src/components/ResponsivePanel';

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })),
  );
}

beforeEach(() => {
  // `window.matchMedia` is read inside the hook; stub on `window`
  // explicitly so subsequent reads see the stub.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ResponsivePanel', () => {
  it('renders nothing when open=false', () => {
    stubMatchMedia(true);
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: window.matchMedia,
    });
    const { container } = render(
      <ResponsivePanel open={false} onClose={() => {}} testId="x">
        body
      </ResponsivePanel>,
    );
    expect(container.querySelector('[data-testid="x"]')).toBeNull();
  });

  it('renders the dialog variant on desktop (>= 768px matches)', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        media: '(min-width: 768px)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      })),
    });
    render(
      <ResponsivePanel open={true} onClose={() => {}} testId="panel">
        body
      </ResponsivePanel>,
    );
    expect(screen.getByTestId('panel')).toHaveAttribute('data-variant', 'dialog');
  });

  it('renders the sheet variant on mobile (< 768px does not match)', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        media: '(min-width: 768px)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      })),
    });
    render(
      <ResponsivePanel open={true} onClose={() => {}} testId="panel">
        body
      </ResponsivePanel>,
    );
    expect(screen.getByTestId('panel')).toHaveAttribute('data-variant', 'sheet');
  });

  it('clicking the backdrop calls onClose', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        media: '(min-width: 768px)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      })),
    });
    const onClose = vi.fn();
    render(
      <ResponsivePanel open={true} onClose={onClose} testId="panel">
        body
      </ResponsivePanel>,
    );
    fireEvent.click(screen.getByTestId('panel-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape key calls onClose', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        media: '(min-width: 768px)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      })),
    });
    const onClose = vi.fn();
    render(
      <ResponsivePanel open={true} onClose={onClose} testId="panel">
        body
      </ResponsivePanel>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
