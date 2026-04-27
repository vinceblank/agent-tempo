/**
 * Placeholder screen — used for routes that ship in PR-5/6.
 * Renders a labelled card so deep-links resolve cleanly during PR-4
 * smoke-testing without crashing the router.
 */

interface PlaceholderScreenProps {
  testId: string;
  title: string;
  arrivingIn: string;
}

export function PlaceholderScreen({ testId, title, arrivingIn }: PlaceholderScreenProps) {
  return (
    <section
      data-testid={testId}
      style={{
        padding: 'var(--density-pad)',
        background: 'var(--bg-1)',
        border: '1px solid var(--rule)',
        borderRadius: 8,
      }}
    >
      <h1 style={{ marginTop: 0, fontFamily: 'var(--ff-display)', fontSize: 22, fontWeight: 400 }}>
        {title}
      </h1>
      <p className="dim" style={{ marginBottom: 0 }}>
        Coming in {arrivingIn} of #340. Route is wired so deep-links resolve.
      </p>
    </section>
  );
}
