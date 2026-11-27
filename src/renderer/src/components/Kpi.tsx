/**
 * A dashboard/analytics stat tile.
 *
 * It lived inside `App.tsx`, where Analytics could not import it without a
 * circular dependency, so Analytics re-implemented the same three-div markup
 * four times.
 *
 * `onClick` makes the tile a button. F-DASH-03 requires every dashboard KPI to
 * be clickable through to its module; a plain `<div>` made the tiles look
 * interactive (they sit in the same row as real controls) while doing nothing.
 */
export function Kpi({
  label,
  value,
  sub,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub ? <div className="kpi-sub">{sub}</div> : null}
    </>
  );
  if (!onClick) return <div className="kpi">{body}</div>;
  return (
    <button type="button" className="kpi kpi-link" onClick={onClick}>
      {body}
    </button>
  );
}
