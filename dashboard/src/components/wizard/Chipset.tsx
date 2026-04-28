/**
 * Chipset — single-select chip group. PR-E of #389.
 *
 * Multi-select isn't currently used by either wizard; if a future
 * screen needs it, ship a separate `MultiChipset` rather than
 * overloading this surface (the visual + a11y semantics differ).
 */
import type { ReactNode } from 'react';

export interface ChipsetOption<T extends string = string> {
  value: T;
  label: ReactNode;
}

interface ChipsetProps<T extends string = string> {
  testId: string;
  options: ReadonlyArray<ChipsetOption<T>>;
  value: T;
  onChange: (value: T) => void;
}

export function Chipset<T extends string>({
  testId,
  options,
  value,
  onChange,
}: ChipsetProps<T>) {
  return (
    <div className="chipset" data-testid={testId} role="radiogroup">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            data-testid={`${testId}-chip-${opt.value}`}
            data-state={active ? 'active' : undefined}
            role="radio"
            aria-checked={active}
            className={'chip' + (active ? ' is-active' : '')}
            onClick={() => onChange(opt.value)}
            style={{ border: 'none', cursor: 'pointer' }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
