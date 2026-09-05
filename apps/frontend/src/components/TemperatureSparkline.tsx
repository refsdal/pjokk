import type { MeasurementType } from "@pjokk/shared";
import { sparklinePoints } from "@/lib/measurements";
import { cn } from "@/lib/utils";

const WIDTH = 64;
const HEIGHT = 24;

// Three days of temperature in 64×24 px, hand-rolled rather than charted.
// recharts is lazy-loaded and heavy (Stats pays that cost deliberately); a
// dozen points on a status card do not justify it, and an inline SVG has no
// bundle cost at all.
//
// The dashed line is the 38.0 °C fever threshold, and sparklinePoints keeps
// it inside the y-domain always: a squiggle scaled only to its own values has
// no reference, so "below fever" would have nothing to be below.
export function TemperatureSparkline({
  rows,
  className,
}: {
  rows: { time: string; type: MeasurementType; value: number }[];
  className?: string;
}) {
  const { points, thresholdY } = sparklinePoints(rows, {
    width: WIDTH,
    height: HEIGHT,
  });
  if (points.length === 0) return null;

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
  const last = points[points.length - 1]!;

  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      // Decorative: the reading and its arrow carry the same information as
      // text right beside it, so a screen reader gains nothing here.
      aria-hidden="true"
      focusable="false"
      className={cn("overflow-visible", className)}
    >
      <line
        x1={0}
        y1={thresholdY}
        x2={WIDTH}
        y2={thresholdY}
        stroke="currentColor"
        strokeWidth={1}
        strokeDasharray="2 2"
        opacity={0.35}
      />
      {points.length > 1 && (
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      <circle cx={last.x} cy={last.y} r={2.5} fill="currentColor" />
    </svg>
  );
}
