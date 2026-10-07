"use client";

import { useState } from "react";
import styles from "./Roll.module.css";

/**
 * A figure that rolls when its text changes: the old text slides out and the new text slides in, in the card's
 * direction (`--dir`: up for a buy, down for a sell) and on the card's turn (`--st`), both set by the board.
 * The text is always real text in the page. The outgoing copy is a hidden, absolutely placed ghost that fades to
 * nothing and then stays invisible, so nothing lingers and nothing shifts. Reduced motion: the text just changes.
 */
export default function Roll({ text }: { text: string }) {
  // changing state while rendering is React's own pattern for "remember the previous value": it re-renders at once
  const [shown, setShown] = useState({ text, from: null as string | null, n: 0 });
  if (shown.text !== text) setShown({ text, from: shown.text, n: shown.n + 1 });
  const rolled = shown.from !== null;
  return (
    <span className={styles.roll}>
      {rolled ? <span key={`o${shown.n}`} aria-hidden="true" className={styles.out}>{shown.from}</span> : null}
      <span key={`i${shown.n}`} className={rolled ? styles.in : undefined}>{text}</span>
    </span>
  );
}
