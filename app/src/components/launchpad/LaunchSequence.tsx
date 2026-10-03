import { useId } from "react";
import styles from "./LaunchMachine.module.css";

const sequence = [
  { label: "Create", offset: "13%", dashOffset: 0 },
  { label: "Pool", offset: "49%", dashOffset: -36 },
  { label: "Lock", offset: "85%", dashOffset: -72 },
] as const;

/** Original curved type treatment; its only input is the machine's existing stage. */
export default function LaunchSequence({ stage }: { stage: number }) {
  const pathId = `launch-sequence-${useId()}`;

  return (
    <g className={styles.sequence}>
      <defs>
        <path id={pathId} d="M191 28 Q321 -15 475 101" />
      </defs>
      <path d="M191 40 Q321 -3 469 113" pathLength="100" className={styles.sequenceTrack} />
      {sequence.map((item, index) => (
        <g key={item.label} className={styles.sequenceStep} data-active={stage === index}>
          <path
            d="M191 40 Q321 -3 469 113"
            pathLength="100"
            strokeDasharray="26 100"
            strokeDashoffset={item.dashOffset}
            className={styles.sequenceSegment}
          />
          <text className={styles.sequenceLabel} textAnchor="middle">
            <textPath href={`#${pathId}`} startOffset={item.offset}>{item.label}</textPath>
          </text>
        </g>
      ))}
    </g>
  );
}
