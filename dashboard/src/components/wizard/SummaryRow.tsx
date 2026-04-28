/**
 * SummaryRow — KV row used on wizard review steps. PR-E of #389.
 *
 * Two-column grid (label / value) with a dashed bottom border so a
 * stack of rows reads as a checklist. Mono on both sides so values
 * (paths, names, options) align cleanly.
 */
interface SummaryRowProps {
  testId: string;
  label: string;
  value: string;
}

export function SummaryRow({ testId, label, value }: SummaryRowProps) {
  return (
    <div
      data-testid={testId}
      style={{
        display: 'grid',
        gridTemplateColumns: '140px 1fr',
        gap: 12,
        fontSize: 13,
        padding: '6px 0',
        borderBottom: '1px dashed var(--rule)',
      }}
    >
      <span className="dim" style={{ fontFamily: 'var(--ff-mono)' }}>
        {label}
      </span>
      <span style={{ fontFamily: 'var(--ff-mono)', wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}
