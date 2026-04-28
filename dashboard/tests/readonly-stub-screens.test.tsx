/**
 * Smoke test for the remaining placeholder screen. Loadouts (PR-F1)
 * and PlayerTypes (PR-F2) were promoted to real screens with their
 * own dedicated test files; CreateEnsemble is the last placeholder
 * still rendering an endpoint-missing stub.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CreateEnsemble } from '../src/screens/CreateEnsemble';

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
