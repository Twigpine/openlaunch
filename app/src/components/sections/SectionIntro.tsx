import type { ReactNode } from "react";
import styles from "./SectionShell.module.css";

/** Shared editorial hierarchy for the supporting product pages. */
export default function SectionIntro({ eyebrow, title, description, children }: {
  eyebrow: string;
  title: string;
  description: ReactNode;
  children?: ReactNode;
}) {
  return <header className={styles.intro}>
    <div className={styles.introRow}>
      <div className={styles.introCopy}>
        <h1 className={`font-display ${styles.title}`}>{title}</h1>
        <p className={styles.eyebrow}>{eyebrow}</p>
        <p className={styles.description}>{description}</p>
      </div>
      {children ? <div className={styles.actions}>{children}</div> : null}
    </div>
  </header>;
}
