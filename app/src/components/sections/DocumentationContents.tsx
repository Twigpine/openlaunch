"use client";

import { useEffect, useState } from "react";
import styles from "./DocumentationContents.module.css";

type Section = { id: string; number: string; label: string };

/** Native anchors still work before hydration. Only the reading marker is enhanced. */
export default function DocumentationContents({ sections, title = "On this page", "aria-label": label }: { sections: readonly Section[]; title?: string; "aria-label": string }) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const elements = sections.map(({ id }) => document.getElementById(id)).filter((element): element is HTMLElement => element !== null);
      const current = elements.findLast((element) => element.getBoundingClientRect().top <= 160) ?? elements[0];
      setActive(current?.id ?? null);
    };
    const queue = () => { if (!frame) frame = requestAnimationFrame(update); };
    queue();
    window.addEventListener("scroll", queue, { passive: true });
    window.addEventListener("resize", queue);
    window.addEventListener("hashchange", queue);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", queue);
      window.removeEventListener("resize", queue);
      window.removeEventListener("hashchange", queue);
    };
  }, [sections]);

  return <nav className={styles.contents} aria-label={label}>
    <p className={styles.title}>{title}</p>
    <ol>{sections.map(({ id, number, label: text }) => <li key={id}>
      <a href={`#${id}`} aria-current={active === id ? "location" : undefined}><span>{number}</span>{text}</a>
    </li>)}</ol>
  </nav>;
}
