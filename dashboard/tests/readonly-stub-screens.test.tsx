/**
 * Smoke tests for the placeholder screens (Loadouts, PlayerTypes,
 * CreateEnsemble) — verifies the testid + endpoint-missing copy land
 * cleanly. Real screens replace these once the daemon endpoints + safe
 * writes ship.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Loadouts } from '../src/screens/Loadouts';
import { PlayerTypes } from '../src/screens/PlayerTypes';
import { CreateEnsemble } from '../src/screens/CreateEnsemble';

describe('Loadouts screen', () => {
  it('renders the endpoint-missing placeholder with a stable testid', () => {
    render(<Loadouts />);
    expect(screen.getByTestId('screen-loadouts')).toBeInTheDocument();
    expect(screen.getByTestId('loadouts-endpoint-missing')).toBeInTheDocument();
  });
});

describe('PlayerTypes screen', () => {
  it('renders the endpoint-missing placeholder with a stable testid', () => {
    render(<PlayerTypes />);
    expect(screen.getByTestId('screen-player-types')).toBeInTheDocument();
    expect(screen.getByTestId('player-types-endpoint-missing')).toBeInTheDocument();
  });
});

describe('CreateEnsemble screen', () => {
  it('renders the form skeleton with a disabled submit', () => {
    render(<CreateEnsemble />);
    expect(screen.getByTestId('screen-create-ensemble')).toBeInTheDocument();
    expect(screen.getByTestId('create-ensemble-input-name')).toBeInTheDocument();
    expect(screen.getByTestId('create-ensemble-input-workdir')).toBeInTheDocument();
    const submit = screen.getByTestId('create-ensemble-submit');
    expect(submit).toHaveAttribute('aria-disabled', 'true');
    expect(submit.getAttribute('title')).toMatch(/PR-7/);
  });
});
