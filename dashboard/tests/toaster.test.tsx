/**
 * Toaster tests — verifies the dashboard's toast helpers surface
 * stable testids + `role="alert"` (architect's testability addendum).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { Toaster } from 'sonner';
import { toastError, toastInfo, toastSuccess } from '../src/lib/toast';

afterEach(cleanup);

function mountToaster() {
  return render(<Toaster toastOptions={{ unstyled: true }} />);
}

describe('Toaster', () => {
  it('toastSuccess renders with data-testid="toast-success" and role="alert"', async () => {
    mountToaster();
    toastSuccess('Cued tempo-eng');
    await waitFor(() => {
      const t = screen.getByTestId('toast-success');
      expect(t).toBeInTheDocument();
      expect(t).toHaveAttribute('role', 'alert');
      expect(t).toHaveAttribute('data-toast-level', 'success');
      expect(t.textContent).toContain('Cued tempo-eng');
    });
  });

  it('toastError renders with data-testid="toast-error"', async () => {
    mountToaster();
    toastError('Failed to cue', { description: 'temporal-down' });
    await waitFor(() => {
      const t = screen.getByTestId('toast-error');
      expect(t).toBeInTheDocument();
      expect(t.textContent).toContain('Failed to cue');
      expect(t.textContent).toContain('temporal-down');
    });
  });

  it('toastInfo renders with data-testid="toast-info"', async () => {
    mountToaster();
    toastInfo('Released held sessions');
    await waitFor(() => {
      const t = screen.getByTestId('toast-info');
      expect(t).toBeInTheDocument();
      expect(t).toHaveAttribute('data-toast-level', 'info');
    });
  });
});
