/**
 * SettingsSheet — verifies prefs persistence + logEvent telemetry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsSheet } from '../src/components/SettingsSheet';
import { __resetPrefsForTests } from '../src/store/prefs';

beforeEach(() => __resetPrefsForTests());
afterEach(() => {
  __resetPrefsForTests();
  vi.restoreAllMocks();
});

describe('SettingsSheet', () => {
  it('renders the three setting controls with stable testids', () => {
    render(<SettingsSheet />);
    expect(screen.getByTestId('settings-sheet')).toBeInTheDocument();
    expect(screen.getByTestId('settings-theme-select')).toBeInTheDocument();
    expect(screen.getByTestId('settings-density-range')).toBeInTheDocument();
    expect(screen.getByTestId('settings-accent-select')).toBeInTheDocument();
  });

  it('flips the theme via the select and emits a prefs-theme-set log', () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    render(<SettingsSheet />);
    fireEvent.change(screen.getByTestId('settings-theme-select'), {
      target: { value: 'light' },
    });
    expect(document.documentElement.dataset.theme).toBe('light');
    const lines = consoleInfo.mock.calls.flat().map(String);
    expect(lines.some((l) => l.includes('prefs-theme-set') && l.includes('"light"'))).toBe(true);
  });

  it('updates the density via the slider', () => {
    render(<SettingsSheet />);
    const range = screen.getByTestId('settings-density-range') as HTMLInputElement;
    fireEvent.change(range, { target: { value: '8' } });
    expect(document.documentElement.dataset.density).toBe('8');
  });

  it('updates the accent via the select', () => {
    render(<SettingsSheet />);
    fireEvent.change(screen.getByTestId('settings-accent-select'), {
      target: { value: 'sage' },
    });
    expect(document.documentElement.dataset.accent).toBe('sage');
  });
});
