import { useMemo } from "react";
import type { AppUsage, TimelineSegment } from "../../../shared/api";
import { formatDuration } from "../../../shared/format";

/** A few seconds of activity is sub-pixel on a 24 h axis; keep it visible. */
const MIN_BAR_PCT = 0.35;

/**
 * Length of the local day starting at `dayStart`, in ms.
 *
 * A local day is not always 24 hours: DST transitions make it 23 or 25. Using a
 * fixed 24 h compressed everything after a spring-forward and pushed the last
 * hour of a fall-back day past 100%, where the bar was clamped away entirely.
 */
function dayLengthMs(dayStart: number): number {
  const d = new Date(dayStart);
  const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return nextMidnight - dayStart;
}

/** Stable colour per app so the timeline and the legend agree. */
const PALETTE = [
  "--c-blue",
  "--c-green",
  "--c-yellow",
  "--c-magenta",
  "--c-cyan",
  "--c-orange",
  "--c-red",
  "--accent",
];

function hashClass(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % PALETTE.length;
}

export function colorFor(appClass: string): string {
  return `var(${PALETTE[hashClass(appClass)]})`;
}

export function Timeline({ segments, dayStart }: { segments: TimelineSegment[]; dayStart: number }) {
  const bars = useMemo(() => {
    const span = dayLengthMs(dayStart);
    return segments
      .map((s) => {
        const start = Math.max(0, (s.startedAt - dayStart) / span);
        const end = Math.min(1, (s.endedAt - dayStart) / span);
        if (end <= start) return null;
        return { ...s, left: start * 100, width: Math.max(MIN_BAR_PCT, (end - start) * 100) };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [segments, dayStart]);

  // Ticks are placed with the same span the bars use. Dividing by a literal 24
  // put every label up to an hour off on a 23- or 25-hour DST day.
  const spanMs = dayLengthMs(dayStart);
  const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24];

  return (
    <div className="timeline-wrap">
      <div className="timeline" role="img" aria-label={`Activity timeline, ${segments.length} segments`}>
        {bars.map((b) => (
          <div
            key={`${b.startedAt}-${b.appClass}`}
            className="timeline-bar"
            style={{ left: `${b.left}%`, width: `${b.width}%`, background: colorFor(b.appClass) }}
            title={`${b.appClass} · ${b.seconds}s${b.appTitle ? ` · ${b.appTitle}` : ""}`}
          />
        ))}
        {bars.length === 0 ? <div className="timeline-empty">No activity recorded yet</div> : null}
      </div>
      <div className="timeline-axis">
        {hours.map((h) => (
          <span key={h} style={{ left: `${((h * 3_600_000) / spanMs) * 100}%` }}>
            {String(h).padStart(2, "0")}
          </span>
        ))}
      </div>
    </div>
  );
}

export function TopApps({ apps }: { apps: AppUsage[] }) {
  if (apps.length === 0) return <div className="muted">No app usage recorded yet.</div>;
  const max = Math.max(...apps.map((a) => a.seconds), 1);

  return (
    <div className="top-apps">
      {apps.slice(0, 8).map((a) => (
        <div key={a.appClass} className="app-row">
          <span className="app-dot" style={{ background: colorFor(a.appClass) }} />
          <span className="app-name" title={a.appClass}>
            {a.appClass}
          </span>
          <span className="app-bar">
            <span style={{ width: `${(a.seconds / max) * 100}%`, background: colorFor(a.appClass) }} />
          </span>
          <span className="app-time">{formatDuration(a.seconds)}</span>
          <span className="app-share">{Math.round(a.share * 100)}%</span>
        </div>
      ))}
    </div>
  );
}
