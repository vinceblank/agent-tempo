/**
 * PickerList — single-select list of rows. PR-E of #389.
 *
 * Used by the Recruit (player-type) and CreateEnsemble (lineup)
 * wizards. Renders rows as `<button>` so Enter/Space activate without
 * extra wiring; `.picker-row` styling (components.css) is reset+
 * re-applied inline so the original `<div>`-targeted rule still binds.
 *
 * Arrow-key navigation deferred — claude-in-chrome drives by
 * `data-testid` so the missing kbd nav doesn't block autonomous
 * validation. Worth adding when a non-test user reports it.
 */
import type { ReactNode } from 'react';

export interface PickerOption<T extends string = string> {
  value: T;
  name: ReactNode;
  desc?: ReactNode;
  /** Right-side decoration (TypeBadge, status pill, …). */
  right?: ReactNode;
  /** Terracotta tint + `+` marker glyph for "create new" rows. */
  accent?: boolean;
}

interface PickerListProps<T extends string = string> {
  /** Test surface — `data-testid` on the outer list. */
  testId: string;
  options: ReadonlyArray<PickerOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Optional inline style override (e.g. `maxHeight: 200, overflow: 'auto'`). */
  style?: React.CSSProperties;
}

export function PickerList<T extends string>({
  testId,
  options,
  value,
  onChange,
  style,
}: PickerListProps<T>) {
  return (
    <div className="picker-list" data-testid={testId} role="radiogroup" style={style}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            data-testid={`${testId}-option-${opt.value}`}
            data-state={active ? 'active' : undefined}
            role="radio"
            aria-checked={active}
            className={'picker-row' + (active ? ' is-active' : '')}
            onClick={() => onChange(opt.value)}
            // `.picker-row` targets a <div> in the design CSS; we render
            // <button> for kbd-activation, so reset UA chrome here.
            // Padding is intentionally not inlined — inline padding would
            // beat the `@container` phone rule by specificity.
            style={{
              all: 'unset',
              display: 'grid',
              gridTemplateColumns: '18px 1fr auto',
              gap: 10,
              alignItems: 'center',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
              ...(active
                ? {
                    background: 'var(--accent-soft)',
                    color: 'var(--text)',
                  }
                : opt.accent
                  ? { color: 'var(--accent)' }
                  : null),
            }}
          >
            <span
              className="marker"
              aria-hidden="true"
              style={{
                color: 'var(--accent)',
                fontFamily: 'var(--ff-mono)',
                fontSize: 11,
              }}
            >
              {opt.accent ? '+' : active ? '▸' : ''}
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              <span className="name" style={{ fontWeight: 500 }}>
                {opt.name}
              </span>
              {opt.desc && (
                <span
                  className="desc"
                  style={{
                    fontSize: 11.5,
                    color: 'var(--dim)',
                    fontFamily: 'var(--ff-mono)',
                  }}
                >
                  {opt.desc}
                </span>
              )}
            </span>
            {opt.right ?? <span />}
          </button>
        );
      })}
    </div>
  );
}
