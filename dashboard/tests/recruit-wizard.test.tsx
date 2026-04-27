/**
 * Recruit wizard — covers step navigation, validation, and the
 * disabled submit on step 3.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Recruit } from '../src/screens/Recruit';

function renderRecruit() {
  return render(<Recruit />);
}

describe('Recruit wizard', () => {
  it('starts on step 1 with disabled Next until name is valid', () => {
    renderRecruit();
    expect(screen.getByTestId('recruit-wizard-step-1')).toBeInTheDocument();
    const next = screen.getByTestId('recruit-next');
    expect(next).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows a name validation error when the input is non-empty but invalid', () => {
    renderRecruit();
    const nameInput = screen.getByTestId('recruit-input-name');
    fireEvent.change(nameInput, { target: { value: 'has spaces' } });
    expect(screen.getByTestId('recruit-input-name-error')).toBeInTheDocument();
  });

  it('progresses through steps 1 → 2 → 3 with valid inputs', () => {
    renderRecruit();
    fireEvent.change(screen.getByTestId('recruit-input-name'), {
      target: { value: 'tempo-soloist-1' },
    });
    fireEvent.click(screen.getByTestId('recruit-next'));
    expect(screen.getByTestId('recruit-wizard-step-2')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('recruit-input-workdir'), {
      target: { value: '/repo/path' },
    });
    fireEvent.click(screen.getByTestId('recruit-next'));
    expect(screen.getByTestId('recruit-wizard-step-3')).toBeInTheDocument();
  });

  it('renders the disabled submit on step 3 with a tooltip explaining why', () => {
    renderRecruit();
    fireEvent.change(screen.getByTestId('recruit-input-name'), {
      target: { value: 'tempo-soloist-1' },
    });
    fireEvent.click(screen.getByTestId('recruit-next'));
    fireEvent.change(screen.getByTestId('recruit-input-workdir'), {
      target: { value: '/repo/path' },
    });
    fireEvent.click(screen.getByTestId('recruit-next'));

    const submit = screen.getByTestId('recruit-submit');
    expect(submit).toHaveAttribute('aria-disabled', 'true');
    expect(submit.getAttribute('title')).toMatch(/PR-7/);
  });

  it('Back button moves the user from step 2 back to step 1', () => {
    renderRecruit();
    fireEvent.change(screen.getByTestId('recruit-input-name'), {
      target: { value: 'tempo-soloist-1' },
    });
    fireEvent.click(screen.getByTestId('recruit-next'));
    expect(screen.getByTestId('recruit-wizard-step-2')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('recruit-back'));
    expect(screen.getByTestId('recruit-wizard-step-1')).toBeInTheDocument();
  });
});
