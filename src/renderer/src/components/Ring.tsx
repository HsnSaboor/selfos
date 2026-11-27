/**
 * One progress ring, shared by the habit rows and goal cards.
 *
 * The SVG and its comment were duplicated verbatim; the circumference is
 * derived from the radius so a radius change cannot leave a stale constant.
 */
const RADIUS = 15.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function Ring({ fraction, label }: { fraction: number; label?: string }) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return (
    <svg
      className="ring"
      viewBox="0 0 36 36"
      role="img"
      aria-label={label ?? `${Math.round(clamped * 100)}%`}
    >
      <circle cx="18" cy="18" r={RADIUS} className="ring-bg" />
      {clamped > 0 ? (
        <circle
          cx="18"
          cy="18"
          r={RADIUS}
          className="ring-fg"
          strokeDasharray={`${clamped * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
        />
      ) : null}
    </svg>
  );
}
