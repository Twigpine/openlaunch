"use client";

import Link from "next/link";
import Image from "next/image";
import { useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { useTranslations } from "use-intl";
import { ArrowDownUp, ArrowRight, ArrowUpRight, Check, ChevronDown, Copy, LayoutDashboard, LogOut, X } from "lucide-react";
import { CHAIN_LABELS, CHAIN_SHORT, chainKeyOf, explorerAddress, explorerName, shortAddr, type ChainKey } from "@/lib/chainPublic";
import { BRIDGE_CHAINS, isBridgeChainId } from "@/lib/bridge/types";
import { VISIBLE_CHAINS } from "@/lib/launchpad/config";
import WalletAvatar from "./WalletAvatar";
import { ChainLogo } from "./launchpad/ChainLogo";
import styles from "./WalletMenu.module.css";

/** Official network marks (app/public/brand). A chain with a dark-mode variant lists both; the CSS swaps them by theme. */
const NETWORK_LOGOS: Record<ChainKey, { light: string; dark?: string; width: number; height: number }> = {
  base: { light: "/brand/base.svg", width: 22, height: 22 },
  robinhood: { light: "/brand/robinhood-black.svg", dark: "/brand/robinhood-white.svg", width: 16, height: 21 },
  arc: { light: "/brand/arc.svg", width: 21, height: 22 },
};

function NetworkLogo({ chain }: { chain: ChainKey }) {
  const logo = NETWORK_LOGOS[chain];
  return (
    <span className={styles.networkLogo} aria-hidden>
      {logo.dark ? <>
        <Image className={styles.lightLogo} src={logo.light} alt="" width={logo.width} height={logo.height} draggable={false} />
        <Image className={styles.darkLogo} src={logo.dark} alt="" width={logo.width} height={logo.height} draggable={false} />
      </> : <Image src={logo.light} alt="" width={logo.width} height={logo.height} draggable={false} />}
    </span>
  );
}

/**
 * The header chip's network, pinned to the avatar's corner like the chain on a token avatar, or a warm "!" on a
 * network the site doesn't support. The chip's name for it pushed the Launch button out of the header, so only the
 * mobile row spells it out.
 */
function NetworkBadge({ chain }: { chain: ChainKey | null }) {
  if (!chain) return <span className={styles.networkWarn} aria-hidden>!</span>;
  return <ChainLogo chain={chain} size={14} className="absolute -right-1 -bottom-1 ring-2 ring-card" />;
}

type WalletMenuProps = {
  address: string;
  chainId?: number;
  connectorName?: string;
  block?: boolean;
  switching?: boolean;
  disconnecting?: boolean;
  onSwitchChain: (chain: ChainKey) => Promise<unknown>;
  onDisconnect: () => Promise<unknown>;
  onNavigate?: () => void;
};

/** Presentation is separate from wagmi so account actions can be reviewed safely. */
export default function WalletMenu(props: WalletMenuProps) {
  // Replacing an account closes its old panel and discards pending feedback.
  return <AccountMenu key={props.address.toLowerCase()} {...props} />;
}

function AccountMenu({ address, chainId, connectorName, block = false, switching = false, disconnecting = false, onSwitchChain, onDisconnect, onNavigate }: WalletMenuProps) {
  const [open, setOpen] = useState(false);
  const t = useTranslations("wallet");
  const tc = useTranslations("common");
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState("");
  const [localBusy, setLocalBusy] = useState<ChainKey | "disconnect" | null>(null);
  const actionLock = useRef(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const key = chainKeyOf(chainId);
  const bridgeNetwork = isBridgeChainId(chainId) ? BRIDGE_CHAINS[chainId] : null;
  // a registry chain the site has no contracts on yet (Arc before its factory is set) is bridge-only for now
  const launchable = key !== null && VISIBLE_CHAINS.includes(key);
  const busy = switching || disconnecting || localBusy !== null;
  const network = key ? CHAIN_SHORT[key] : bridgeNetwork?.name ?? t("unsupportedNetwork");
  const explorer = key ? explorerAddress(key, address) : bridgeNetwork ? `${bridgeNetwork.explorer}/address/${address}` : null;

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setNotice(t("copiedNotice"));
    } catch {
      setCopied(false);
      setNotice(t("copyFailed"));
    }
  }

  async function runAction(target: ChainKey | "disconnect") {
    if (busy || actionLock.current || target === key) return;
    actionLock.current = true;
    setLocalBusy(target);
    setNotice("");
    try {
      if (target === "disconnect") {
        await onDisconnect();
        setOpen(false);
      } else {
        await onSwitchChain(target);
        setNotice(t("switched", { chain: CHAIN_LABELS[target] }));
      }
    } catch {
      setNotice(target === "disconnect" ? t("disconnectFailed") : t("switchFailed"));
    } finally {
      actionLock.current = false;
      setLocalBusy(null);
    }
  }

  return (
    <Popover.Root modal={block} open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); setCopied(false); setNotice(""); }}>
      <Popover.Trigger
        className={`${styles.trigger} ${block ? styles.block : ""}`}
        aria-label={t("trigger", { address: shortAddr(address), network })}
        title={block ? undefined : key || bridgeNetwork ? t("onNetwork", { network }) : t("unsupportedTitle")}
        data-unsupported={(!key && !bridgeNetwork) || undefined}
      >
        <span className={styles.triggerMark}><WalletAvatar address={address} />{block ? <span className={styles.connectionDot} /> : <NetworkBadge chain={key ?? bridgeNetwork?.key ?? null} />}</span>
        <span className={styles.triggerAddress}>{shortAddr(address)}</span>
        {block ? <span className={styles.triggerNetwork}>{key || bridgeNetwork ? network : t("switch")}</span> : null}
        <ChevronDown size={13} className={styles.chevron} aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        {block ? <Popover.Backdrop className={styles.backdrop} /> : null}
        <Popover.Positioner side="bottom" align="end" sideOffset={10} collisionPadding={12} positionMethod="fixed" className={`${styles.positioner} ${block ? styles.mobilePositioner : ""}`}>
          <Popover.Popup
            ref={popupRef}
            initialFocus={popupRef}
            aria-modal={block || undefined}
            className={styles.popup}
            data-wallet-popup=""
            onKeyDown={(event) => {
              // Escape dismisses this level, not the mobile navigation behind it.
              if (event.key === "Escape") { event.stopPropagation(); setOpen(false); }
            }}
          >
            <div className={styles.panelHeader}>
              <Popover.Title className={styles.title}><span className={styles.statusDot} />{t("connected")}</Popover.Title>
              <Popover.Close aria-label={t("close")} className={styles.close}><X size={16} aria-hidden /></Popover.Close>
            </div>
            <div className={styles.identity}>
              <WalletAvatar address={address} size={48} />
              <div className={styles.identityText}>
                <p className={styles.account}>{shortAddr(address)}</p>
                <Popover.Description className={styles.provider}>{connectorName || tc("wallet")}</Popover.Description>
              </div>
            </div>
            <p className={styles.fullAddress} aria-label={t("fullAddress")}>{address}</p>
            <div className={styles.shortcuts}>
              <button type="button" onClick={copyAddress} className={styles.shortcut}>
                {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
                {copied ? t("copied") : t("copy")}
              </button>
              {explorer ? (
                <a className={styles.shortcut} href={explorer} target="_blank" rel="noreferrer" aria-label={t("viewOn", { explorer: key ? explorerName(key) : t("networkExplorer", { network }) })}>
                  <ArrowUpRight size={16} aria-hidden />{t("explorer")}
                </a>
              ) : null}
            </div>
            <div className={styles.networkSection}>
              <div className={styles.sectionLabel}><span>{t("network")}</span><ArrowDownUp size={13} aria-hidden /></div>
              {!key && !bridgeNetwork ? <p className={styles.unsupported}>{t("unsupportedHelp")}</p> : null}
              <div className={styles.networks} role="group" aria-label={t("walletNetwork")}>
                {VISIBLE_CHAINS.map((chain) => (
                  <button type="button" key={chain} className={styles.networkButton} aria-pressed={chain === key} disabled={busy} onClick={() => void runAction(chain)}>
                    <NetworkLogo chain={chain} />
                    <span>{CHAIN_SHORT[chain]}</span>
                    {localBusy === chain ? <span className={styles.pendingDot} aria-label={t("switching")} /> : chain === key ? <Check size={14} className={styles.networkCheck} aria-hidden /> : null}
                  </button>
                ))}
              </div>
              <p className={styles.networkNote}>{switching || (localBusy && localBusy !== "disconnect") ? t("confirmNetwork") : key && launchable ? t("connectedTo", { chain: CHAIN_LABELS[key] }) : key || bridgeNetwork ? t("connectedBridgeOnly", { network }) : t("needsApproval")}</p>
            </div>
            <Link href="/me" className={styles.workspace} onClick={() => { setOpen(false); onNavigate?.(); }}>
              <LayoutDashboard size={17} aria-hidden />
              <span><strong>{t("workspace")}</strong><small>{t("workspaceHint")}</small></span>
              <ArrowRight size={16} aria-hidden />
            </Link>
            <div className={styles.bottom}>
              <button type="button" className={styles.disconnect} disabled={busy} onClick={() => void runAction("disconnect")}><LogOut size={15} aria-hidden />{disconnecting || localBusy === "disconnect" ? t("disconnecting") : t("disconnect")}</button>
              <span>{t("thisSiteOnly")}</span>
            </div>
            <p className={styles.notice} role="status" aria-live="polite">{notice}</p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
