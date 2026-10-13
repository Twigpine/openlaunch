import type { ReactNode } from "react";
import styles from "./SectionShell.module.css";

/** Shared page header for the supporting product pages: a small label chip, the title, one paragraph and the page's actions. */
export default function SectionIntro({ eyebrow, icon, title, description, children }: {
  eyebrow: string;
  /** a small mark for the chip; the same icon the navigation uses for the page */
  icon?: ReactNode;
  title: string;
  description: ReactNode;
  children?: ReactNode;
}) {
  return <header className={styles.intro}>
    <p className={styles.eyebrow}>{icon ? <span aria-hidden="true" className={styles.eyebrowIcon}>{icon}</span> : null}{eyebrow}</p>
    <div className={styles.introRow}>
      <div className={styles.introCopy}>
        <h1 className={`font-display ${styles.title}`}>{title}</h1>
        <p className={styles.description}>{description}</p>
      </div>
      {children ? <div className={styles.actions}>{children}</div> : null}
    </div>
  </header>;
}
