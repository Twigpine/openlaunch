"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { AgentExample } from "./agent-examples";
import styles from "./Agents.module.css";

/** A copy-only reference. Examples are never sent, evaluated or executed. */
export default function AgentsCodeBlock({ title, language, code = "", examples }: { title: string; language: string; code?: string; examples?: readonly AgentExample[] }) {
  const [chain, setChain] = useState(examples?.[0]?.chain);
  const selected = examples?.find((example) => example.chain === chain) ?? examples?.[0];
  return <div className={styles.example}>
    {examples && examples.length > 1 ? <label className={styles.exampleChain}>Example network<select value={chain} onChange={(event) => setChain(event.target.value)} aria-label={`${title} example network`}>{examples.map((example) => <option key={example.chain} value={example.chain}>{example.label}</option>)}</select><span>Reference only</span></label> : null}
    <CopyReference key={selected?.code ?? code} title={selected?.title ?? title} language={language} code={selected?.code ?? code} />
  </div>;
}

function CopyReference({ title, language, code }: { title: string; language: string; code: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const [copying, setCopying] = useState(false);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); };
  }, []);

  async function copy() {
    if (copying) return;
    setCopying(true);
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(code);
      if (!alive.current) return;
      setStatus("copied");
      timer.current = setTimeout(() => setStatus("idle"), 2400);
    } catch {
      if (alive.current) setStatus("error");
    } finally {
      if (alive.current) setCopying(false);
    }
  }

  return <div className={styles.codePanel}>
    <div className={styles.codeHeader}>
      <div><span className={styles.codeTitle}>{title}</span><span className={styles.language}>{language}</span></div>
      <button type="button" onClick={copy} disabled={copying} data-copied={status === "copied" || undefined} className={styles.copyButton} aria-label={`Copy ${title.toLowerCase()}`}>
        {status === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        <span>{copying ? "Copying…" : status === "copied" ? "Copied" : "Copy"}</span>
      </button>
    </div>
    <pre tabIndex={0} role="region" aria-label={`${title}, scrollable code`} className={styles.code}><code>{code}</code></pre>
    <p role="status" className={status === "error" ? styles.copyError : "sr-only"}>{status === "copied" ? `${title} copied to clipboard.` : status === "error" ? "Copy unavailable. Select and copy the code instead." : ""}</p>
  </div>;
}
