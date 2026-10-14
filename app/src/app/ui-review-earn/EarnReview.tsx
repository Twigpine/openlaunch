"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { X } from "lucide-react";
import { EarnCardView } from "@/components/earn/EarnCard";
import { EarnShell } from "@/components/earn/EarnDialog";
import EarnPanel, { type EarnView } from "@/components/earn/EarnPanel";
import type { EarnVaultSnapshot } from "@/lib/earn/info";
import { EARN_VAULTS } from "@/lib/earn/vaults";
import styles from "@/components/earn/EarnDialog.module.css";

// Synthetic figures shaped like the real vault on 2026-10-14. Nothing here reads a wallet or sends anything.
const vault = EARN_VAULTS.base!;
const snapshot: EarnVaultSnapshot = { rate: 0.0436, rateFrom: "2026-09-14T08:49:55.000Z", rateTo: "2026-10-14T08:49:55.000Z", totalAssets: "182843577259894", performanceFeePct: 0, managementFeeYearPct: 0, terms: { ok: true } };
const noop = () => {};
const base: EarnView = {
  vault, isConnected: true, onChain: true, switching: false, tab: "deposit", text: "", all: false, amount: null, problem: "Enter an amount", needsApproval: null,
  liveTerms: { ok: true }, phase: { k: "idle" }, busy: false, balance: 1_250_500_000n, shares: 0n, position: 0n, unreadable: false, noGas: false,
  setTab: noop, setAmount: noop, setMax: noop, reset: noop, switchToVaultChain: async () => {}, submit: async () => {}, recheck: async () => {},
};
const typed = (text: string, amount: bigint): Partial<EarnView> => ({ text, amount, problem: null });
const hash = `0x${"ab".repeat(32)}` as const;
const deposited: Partial<EarnView> = { shares: 478_838_632_555_005_049_702n, position: 500_000_000n };

const scenes: { id: string; title: string; view: Partial<EarnView>; snap?: EarnVaultSnapshot | null }[] = [
  { id: "disconnected", title: "Disconnected", view: { isConnected: false, balance: undefined, shares: undefined, position: undefined } },
  { id: "empty", title: "Connected, nothing typed", view: {} },
  { id: "deposit_first", title: "First deposit (needs an approval)", view: { ...typed("250", 250_000_000n), needsApproval: true } },
  { id: "deposit_again", title: "Deposit (already approved)", view: { ...typed("250", 250_000_000n), needsApproval: false, ...deposited } },
  { id: "over_balance", title: "More than the wallet holds", view: { text: "5000", amount: 5_000_000_000n, problem: "More than your USDC" } },
  { id: "wrong_network", title: "Wallet on another network", view: { ...typed("250", 250_000_000n), onChain: false } },
  { id: "approving", title: "Approving", view: { ...typed("250", 250_000_000n), needsApproval: true, phase: { k: "approving" }, busy: true } },
  { id: "signing", title: "Confirm in wallet", view: { ...typed("250", 250_000_000n), phase: { k: "signing" }, busy: true } },
  { id: "sent", title: "Confirming", view: { ...typed("250", 250_000_000n), phase: { k: "sent", hash }, busy: true } },
  { id: "unconfirmed_tx", title: "Sent, confirmation unreadable", view: { busy: true, phase: { k: "unconfirmed", tab: "deposit", amount: 250_000_000n, sent: { kind: "tx", hash }, checking: false, note: null } } },
  { id: "unconfirmed_batch", title: "Batch sent, still not confirmed", view: { busy: true, phase: { k: "unconfirmed", tab: "withdraw", amount: 500_000_000n, sent: { kind: "batch", id: "0x01" }, checking: false, note: "Still no confirmation. It can take a while when the network is busy; check again in a moment, or look at your wallet's activity." } } },
  { id: "done_deposit", title: "Deposited", view: { phase: { k: "done", hash, tab: "deposit", amount: 250_000_000n } } },
  { id: "withdraw_all", title: "Withdraw everything", view: { tab: "withdraw", ...deposited, text: "500", amount: 500_000_000n, all: true, problem: null } },
  { id: "withdraw_part", title: "Withdraw part", view: { tab: "withdraw", ...deposited, ...typed("120", 120_000_000n) } },
  { id: "error_liquidity", title: "Vault short of free funds", view: { tab: "withdraw", ...deposited, ...typed("500", 500_000_000n), all: true, phase: { k: "error", message: "The vault cannot pay out that much right now: most of it is lent out. Try a smaller amount, or try again later." } } },
  { id: "done_withdraw", title: "Withdrawn", view: { tab: "withdraw", phase: { k: "done", hash, tab: "withdraw", amount: 500_000_000n } } },
  { id: "paused", title: "Vault terms changed", view: { ...typed("250", 250_000_000n), liveTerms: { ok: false, reason: "The vault now keeps 10% of the interest it earns." } } },
  { id: "no_rate", title: "Rate unavailable, no gas", view: { noGas: true }, snap: null },
];

/** The sheet drawn in place (no modal), with one scene's synthetic state. */
function Panel({ view, snap }: { view: EarnView; snap: EarnVaultSnapshot | null }) {
  return (
    <div className={`${styles.panel} ${styles.static}`}>
      <EarnShell vault={vault} title={<h2 className={styles.title}>Earn on USDC</h2>} close={<button type="button" className={styles.close} aria-label="Close"><X size={19} aria-hidden /></button>}
        description={<p className={styles.description}>Lend your USDC through a Morpho vault on Base. Take it out whenever the vault has it free.</p>}>
        <EarnPanel view={view} snapshot={snap} onConnect={noop} />
      </EarnShell>
    </div>
  );
}

/** Every scene, or one with ?scene=<id> (?scene=card for the /me card); ?dark=1 or 0 picks the theme. */
export default function EarnReview() {
  const params = useSearchParams();
  const only = params.get("scene");
  // ?dark=1 / ?dark=0 picks the theme, for screenshots of both
  const dark = params.get("dark");
  const { setTheme } = useTheme();
  useEffect(() => {
    if (dark === "1" || dark === "0") setTheme(dark === "1" ? "dark" : "light");
  }, [dark, setTheme]);
  if (only === "card") return <main className="mx-auto max-w-3xl p-6"><EarnCardView vault={vault} snapshot={snapshot} balance={1_250_500_000n} position={500_000_000n} onOpen={noop} /><EarnCardView vault={vault} snapshot={null} balance={0n} position={0n} onOpen={noop} /></main>;
  const shown = only ? scenes.filter((s) => s.id === only) : scenes;
  return (
    <main className="mx-auto max-w-[1500px] p-6">
      {!only ? (
        <section className="mb-8 max-w-3xl">
          <h1 className="mb-3 text-lg font-semibold">/me card</h1>
          <EarnCardView vault={vault} snapshot={snapshot} balance={1_250_500_000n} position={500_000_000n} onOpen={noop} />
          <EarnCardView vault={vault} snapshot={null} balance={0n} position={0n} onOpen={noop} />
        </section>
      ) : null}
      <div className="grid gap-8" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(460px, 100%), 1fr))" }}>
        {shown.map((s) => (
          <section key={s.id} aria-label={s.title}>
            <h2 className="mb-2 text-sm font-semibold text-muted">{s.title} <code className="font-mono text-xs">?scene={s.id}</code></h2>
            <Panel view={{ ...base, ...s.view }} snap={s.snap === undefined ? snapshot : s.snap} />
          </section>
        ))}
      </div>
    </main>
  );
}
