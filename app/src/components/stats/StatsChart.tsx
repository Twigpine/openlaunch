import { fmtUsd } from "@/lib/launchpad/math";
import type { StatsDay } from "@/lib/stats/stats";
import styles from "./Stats.module.css";

type Metric = "volume_usd" | "launches" | "fees_collected_usd";

type Props = {
  points: StatsDay[];
  metric: Metric;
  title: string;
  caption: string;
  /** `usd` adds the dollar sign and compact notation; `count` prints whole numbers. */
  kind: "usd" | "count";
};

const W = 720;
const H = 238;
const LEFT = 56;
const RIGHT = 8;
const TOP = 14;
const BOTTOM = 26;
const PLOT_W = W - LEFT - RIGHT;
const PLOT_H = H - TOP - BOTTOM;

function valueOf(point: StatsDay, metric: Metric): number {
  if (metric === "volume_usd") return point.volume_usd;
  if (metric === "fees_collected_usd") return point.fees_collected_usd;
  return point.launches;
}

function label(value: number, kind: Props["kind"]): string {
  return kind === "usd" ? fmtUsd(value, { compact: true }) : Math.round(value).toLocaleString("en-US");
}

function shortDay(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * A server-rendered daily bar chart with the numbers in a disclosure below it.
 * No client JavaScript: the SVG is the visual, the table is the exact data, and
 * every bar carries its day and value in a <title> for a pointer. Long series
 * (the all-time window) share bars sub-pixel, which is honest at that scale.
 */
export default function StatsChart({ points, metric, title, caption, kind }: Props) {
  if (points.length === 0) {
    return <div className={styles.chartEmpty}>No indexed activity in this window yet.</div>;
  }
  const values = points.map((p) => Math.max(0, valueOf(p, metric)));
  const max = Math.max(1, ...values);
  const slot = PLOT_W / points.length;
  const barWidth = Math.max(0.8, Math.min(24, slot * 0.68));
  const tickPercent = [0, 0.5, 1];
  const xLabels = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];

  return (
    <figure className={styles.chart}>
      <figcaption className={styles.chartCaption}>
        <span className={styles.chartTitle}>{title}</span>
        <span className={styles.chartNote}>{caption}</span>
      </figcaption>
      <svg className={styles.plot} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. ${caption}`}>
        {tickPercent.map((pct) => {
          const y = TOP + PLOT_H - PLOT_H * pct;
          return (
            <g key={pct}>
              <line className={styles.grid} x1={LEFT} x2={W - RIGHT} y1={y} y2={y} />
              <text className={styles.axis} x={LEFT - 8} y={y + 3} textAnchor="end">{label(max * pct, kind)}</text>
            </g>
          );
        })}
        {points.map((point, i) => {
          const value = Math.max(0, valueOf(point, metric));
          const height = (value / max) * PLOT_H;
          const x = LEFT + i * slot + (slot - barWidth) / 2;
          return (
            <rect
              key={point.day}
              className={styles.bar}
              x={x}
              y={TOP + PLOT_H - height}
              width={barWidth}
              height={height}
              rx={Math.min(2, barWidth / 2)}
            >
              <title>{`${point.day}: ${label(value, kind)}`}</title>
            </rect>
          );
        })}
        {xLabels.map((i) => (
          <text key={i} className={styles.axis} x={LEFT + i * slot + slot / 2} y={H - 8} textAnchor="middle">
            {shortDay(points[i].day)}
          </text>
        ))}
      </svg>
      <details className={styles.dataTable}>
        <summary>View daily figures</summary>
        <div className={styles.tableScroll}>
          <table>
            <caption className="sr-only">{title}</caption>
            <thead><tr><th scope="col">Day (UTC)</th><th scope="col" className={styles.numeric}>{title}</th></tr></thead>
            <tbody>
              {points.map((point) => <tr key={point.day}><td>{point.day}</td><td className={styles.numeric}>{label(valueOf(point, metric), kind)}</td></tr>)}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
