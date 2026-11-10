"use client";

import { useId, type ReactNode } from "react";
import { ArrowUpRight, Flame, LockKeyhole, Wallet } from "lucide-react";
import { useTranslations } from "use-intl";
import { isAddress } from "viem";
import { FEE_PRESETS, MAX_RECIPIENTS } from "@/lib/launchpad/config";
import { bpsToPct, isBurnAddress, type SplitResult } from "@/lib/launchpad/recipients";
import { shortAddr } from "@/lib/chainPublic";
import { card } from "@/components/ui";
import styles from "./LaunchFeeSettings.module.css";

export type FeeBeneficiary = "burn" | "me" | "custom";

type Props = {
  feePips: number;
  beneficiary: FeeBeneficiary;
  address?: string;
  split: SplitResult;
  children: ReactNode;
  onFeeChange: (pips: number) => void;
  onBeneficiaryChange: (value: FeeBeneficiary) => void;
};

export default function LaunchFeeSettings({ feePips, beneficiary, address, split, children, onFeeChange, onBeneficiaryChange }: Props) {
  const t = useTranslations("launch.fees");
  const id = useId();
  const feePerHundred = feePips / 10_000;
  const custom = beneficiary === "custom";
  const customReady = split.errors.length === 0 && split.recipients.length > 0;
  const destination = beneficiary === "burn" ? "0x…dEaD" : address;
  const routes = [
    { value: "burn", title: t("routes.burn.title"), description: t("routes.burn.description"), Icon: Flame },
    { value: "me", title: t("routes.me.title"), description: address ? shortAddr(address) : t("routes.me.description"), Icon: Wallet },
    { value: "custom", title: t("routes.custom.title"), description: t("routes.custom.description", { max: MAX_RECIPIENTS }), Icon: ArrowUpRight },
  ] as const;

  return (
    <section className={`${card} ${styles.section}`} aria-labelledby={`${id}-heading`}>
      <div className={styles.heading}>
        <h2 id={`${id}-heading`}>{t("heading")}</h2>
        <span className={styles.platform}>{t("platform")}</span>
      </div>
      <p className={styles.intro}>{t("intro")}</p>

      <fieldset className={styles.fieldset}>
        <legend className="sr-only">{t("rateLegend")}</legend>
        <div className={styles.rates}>
          {FEE_PRESETS.map((fee) => (
            <label key={fee.pips} className={styles.rate} data-selected={feePips === fee.pips}>
              <input
                type="radio"
                name={`${id}-rate`}
                value={fee.pips}
                checked={feePips === fee.pips}
                onChange={() => {
                  onFeeChange(fee.pips);
                  if (fee.pips === 0) onBeneficiaryChange("burn");
                }}
                aria-label={t("rateLabel", { rate: fee.label })}
              />
              <span className={styles.rateValue}>{fee.label}</span>
              <span className={styles.rateCaption}>{fee.pips === 0 ? t("noFee") : t("perHundred", { amount: fee.pips / 10_000 })}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {feePips > 0 ? (
        <fieldset className={`${styles.fieldset} ${styles.routing}`}>
          <legend>{t("routeLegend")}</legend>
          <p className={styles.routeHelp}>{t("routeHelp")}</p>
          <div className={styles.routes}>
            {routes.map(({ value, title, description, Icon }) => (
              <label key={value} className={styles.route} data-selected={beneficiary === value}>
                <Icon size={19} strokeWidth={1.7} aria-hidden="true" />
                <span className={styles.routeCopy}>
                  <span className={styles.routeTitle}>{title}</span>
                  <span className={styles.routeDescription}>{description}</span>
                </span>
                <input type="radio" name={`${id}-recipient`} value={value} checked={beneficiary === value} onChange={() => onBeneficiaryChange(value)} aria-label={title} />
              </label>
            ))}
          </div>
          {custom ? (
            <div className={styles.custom}>
              {children}
              {split.errors.length > 0 ? <p className={styles.error}>{split.errors.join(" ")}</p> : null}
            </div>
          ) : null}
        </fieldset>
      ) : null}

      <div className={styles.summary}>
        <div className={styles.summaryTitle}>
          <h3>{feePips === 0 ? t("summary.none") : t("summary.yours")}</h3>
          {feePips > 0 ? <span>{custom ? customReady ? t("summary.across", { count: split.recipients.length }) : t("summary.incomplete") : t("summary.one")}</span> : null}
        </div>
        <dl className={styles.breakdown}>
          {feePips > 0 && custom && customReady ? split.recipients.map((recipient) => (
            <div key={recipient.payout}>
              <dt title={recipient.payout}>{isBurnAddress(recipient.payout) ? t("burnAddress") : shortAddr(recipient.payout)}</dt>
              <dd>{t("ofFees", { pct: bpsToPct(recipient.bps) })}</dd>
            </div>
          )) : (
            <div>
              <dt>{feePips === 0 ? t("tradingFee") : custom ? t("beneficiaries") : beneficiary === "burn" ? t("burnAddress") : t("yourWallet")}</dt>
              <dd>{feePips === 0 ? "0%" : custom ? t("completeSplit") : t("allFees")}</dd>
            </div>
          )}
          <div>
            <dt>Openlaunch</dt>
            <dd className={styles.platform}>0%</dd>
          </div>
        </dl>
        {feePips > 0 ? (
          <p className={styles.destination}>
            {custom ? customReady ? t("destination.paid") : t("destination.incomplete") : beneficiary === "burn" ? t("destination.burned") : !address ? t("destination.connect") : t("destination.claimable")}
            {!custom && destination && (beneficiary === "burn" || isAddress(destination)) ? <span title={destination}>{beneficiary === "burn" ? destination : shortAddr(destination)}</span> : null}
          </p>
        ) : null}
        <p className={styles.example}>
          {feePips === 0 ? t("exampleFree") : t.rich("example", { count: feePerHundred, strong: (chunks) => <strong>{chunks}</strong> })}
        </p>
      </div>

      <p className={styles.permanent}>
        <LockKeyhole size={14} strokeWidth={1.8} aria-hidden="true" />
        <span>{feePips > 0 ? t("permanentAllocation") : t("permanent")}</span>
      </p>
    </section>
  );
}
