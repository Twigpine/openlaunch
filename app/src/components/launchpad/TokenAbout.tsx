import { ArrowUpRight, Globe } from "lucide-react";
import CopyChip from "./CopyChip";
import { XMark } from "./BrandMarks";
import { safeSocials } from "@/lib/launchpad/socials";
import { explorerAddress, shortAddr, type ChainKey } from "@/lib/chainPublic";
import { agoParts } from "@/lib/launchpad/time";
import { WhoName } from "@/components/profile/Who";
import { getTranslations } from "@/i18n/server";

/**
 * The token at a glance, beside the trade box: what the creator wrote, where to find them, and who launched it.
 * The full record (pool, fee route, supply, launch transaction) stays in the About & contracts tab.
 */
export default async function TokenAbout({ chain, token, symbol, description, website, x_handle, launcher, launchedAt, now, swap }: {
  chain: ChainKey;
  token: string;
  symbol: string;
  description: string | null;
  website: string | null;
  x_handle: string | null;
  launcher: string;
  launchedAt: string;
  now: number;
  swap: { name: string; url: string } | null;
}) {
  const { x, site, host } = safeSocials({ website, x_handle });
  const [t, tc] = await Promise.all([getTranslations("token"), getTranslations("common")]);
  const { n, unit } = agoParts(launchedAt, now);
  return (
    <section aria-labelledby="token-about-heading" className="rounded-2xl border border-line bg-card p-5">
      <h2 id="token-about-heading" className="text-sm font-semibold text-ink">{t("about.heading", { symbol })}</h2>
      <p className={`mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-pretty ${description ? "text-body" : "text-muted"}`}>
        {description || t("about.noDescription")}
      </p>
      {x || site || swap ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {x ? <a href={`https://x.com/${x}`} target="_blank" rel="noopener noreferrer nofollow" className={chip}><XMark />@{x}</a> : null}
          {site ? <a href={site} target="_blank" rel="noopener noreferrer nofollow" className={chip}><Globe size={13} aria-hidden="true" /><span className="max-w-40 truncate">{host}</span></a> : null}
          {swap ? <a href={swap.url} target="_blank" rel="noopener noreferrer" className={chip}>{t("about.openIn", { name: swap.name })}<ArrowUpRight size={12} aria-hidden="true" /></a> : null}
        </div>
      ) : null}
      <dl className="mt-4 divide-y divide-line border-t border-line text-xs">
        <div className="flex items-center justify-between gap-3 py-2.5">
          <dt className="text-muted">{t("about.creator")}</dt>
          <dd className="min-w-0"><WhoName address={launcher} explorer={explorerAddress(chain, launcher)} fallback={<a href={explorerAddress(chain, launcher)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-code text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">{shortAddr(launcher)}<ArrowUpRight size={11} aria-hidden="true" /></a>} /></dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-2.5">
          <dt className="text-muted">{t("about.contract")}</dt>
          <dd><CopyChip value={token} /></dd>
        </div>
        <div className="flex items-center justify-between gap-3 pt-2.5">
          <dt className="text-muted">{t("about.launched")}</dt>
          <dd className="font-mono text-body tnum"><time dateTime={launchedAt} title={new Date(launchedAt).toUTCString()}>{tc("time.ago", { time: tc(`time.${unit}`, { n }) })}</time></dd>
        </div>
      </dl>
    </section>
  );
}

const chip = "inline-flex min-h-8 items-center gap-1.5 rounded-full border border-line px-3 text-xs font-medium text-body transition-colors hover:border-line-strong hover:text-ink motion-reduce:transition-none";
