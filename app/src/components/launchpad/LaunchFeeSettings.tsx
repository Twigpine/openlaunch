"use client";

import { useId, type ReactNode } from "react";
import { ArrowUpRight, Flame, LockKeyhole, Wallet } from "lucide-react";
import { isAddress } from "viem";
import { FEE_PRESETS, MAX_RECIPIENTS } from "@/lib/launchpad/config";
import { bpsToPct, isBurnAddress, type SplitResult } from "@/lib/launchpad/recipients";
import { shortAddr } from "@/lib/chainPublic";
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
  const id = useId();
  const feePerHundred = feePips / 10_000;
  const custom = beneficiary === "custom";
  const customReady = split.errors.length === 0 && split.recipients.length > 0;
  const destination = beneficiary === "burn" ? "0x…dEaD" : address;
  const routes = [
    { value: "burn", title: "Burn the fees", description: "Sent to 0x…dEaD when collected. Nobody receives them.", Icon: Flame },
    { value: "me", title: "Your wallet", description: address ? shortAddr(address) : "The wallet you connect to launch.", Icon: Wallet },
    { value: "custom", title: "Wallets or a split", description: `Choose up to ${MAX_RECIPIENTS} beneficiaries, including a partial burn.`, Icon: ArrowUpRight },
  ] as const;

  return (
    <section className={styles.section} aria-labelledby={`${id}-heading`}>
      <div className={styles.heading}>
        <h2 id={`${id}-heading`}>Trading fee</h2>
        <span className={styles.platform}>0% platform fee</span>
      </div>
      <p className={styles.intro}>Choose what traders pay on each buy and sell.</p>

      <fieldset className={styles.fieldset}>
        <legend className="sr-only">Trading fee rate</legend>
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
                aria-label={`${fee.label} trading fee`}
              />
              <span className={styles.rateValue}>{fee.label}</span>
              <span className={styles.rateCaption}>{fee.pips === 0 ? "No trading fee" : `${fee.pips / 10_000} per 100 traded`}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {feePips > 0 ? (
        <fieldset className={`${styles.fieldset} ${styles.routing}`}>
          <legend>Where should the fees go?</legend>
          <p className={styles.routeHelp}>The full trading fee follows your allocation. Openlaunch takes none.</p>
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
          <h3>{feePips === 0 ? "No fees to distribute" : "Your fee allocation"}</h3>
          {feePips > 0 ? <span>{custom ? customReady ? `100% across ${split.recipients.length} ${split.recipients.length === 1 ? "destination" : "destinations"}` : "Allocation incomplete" : "100% to one destination"}</span> : null}
        </div>
        <dl className={styles.breakdown}>
          {feePips > 0 && custom && customReady ? split.recipients.map((recipient) => (
            <div key={recipient.payout}>
              <dt title={recipient.payout}>{isBurnAddress(recipient.payout) ? "Burn address" : shortAddr(recipient.payout)}</dt>
              <dd>{bpsToPct(recipient.bps)}% of fees</dd>
            </div>
          )) : (
            <div>
              <dt>{feePips === 0 ? "Trading fee" : custom ? "Beneficiaries" : beneficiary === "burn" ? "Burn address" : "Your wallet"}</dt>
              <dd>{feePips === 0 ? "0%" : custom ? "Complete the split above" : "100% of fees"}</dd>
            </div>
          )}
          <div>
            <dt>Openlaunch</dt>
            <dd className={styles.platform}>0%</dd>
          </div>
        </dl>
        {feePips > 0 ? (
          <p className={styles.destination}>
            {custom ? customReady ? "Paid directly to each wallet at collection. Burn shares go to 0x…dEaD." : "Add valid addresses and shares totaling 100% before launch." : beneficiary === "burn" ? "Burned at collection" : !address ? "Connect your wallet before launch" : "Claimable by"}
            {!custom && destination && (beneficiary === "burn" || isAddress(destination)) ? <span title={destination}>{beneficiary === "burn" ? destination : shortAddr(destination)}</span> : null}
          </p>
        ) : null}
        <p className={styles.example}>
          {feePips === 0 ? "No trading fees are collected. " : <>For every 100 units traded, <strong>{feePerHundred} {feePerHundred === 1 ? "unit is" : "units are"} the trading fee</strong>. </>}
          Network gas and price impact still apply.
        </p>
      </div>

      <p className={styles.permanent}>
        <LockKeyhole size={14} strokeWidth={1.8} aria-hidden="true" />
        <span>Fixed at launch. The fee rate{feePips > 0 ? " and allocation" : ""} cannot be changed later.</span>
      </p>
    </section>
  );
}
