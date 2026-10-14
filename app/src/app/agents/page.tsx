import type { Metadata } from "next";
import type { ReactNode } from "react";
import { pageMetadata } from "@/lib/seo";
import { ArrowDown, ArrowLeftRight, ArrowRight, ArrowUpRight, BookOpen, Bot, Braces, FileCode2, Rocket, Terminal } from "lucide-react";
import SectionIntro from "@/components/sections/SectionIntro";
import AgentsCodeBlock from "@/components/sections/AgentsCodeBlock";
import shell from "@/components/sections/SectionShell.module.css";
import styles from "@/components/sections/Agents.module.css";
import { launchpad } from "@/lib/launchpad/config";
import { CHAIN_KEYS, CHAIN_LABELS, CHAINS, SITE_URL, explorerAddress } from "@/lib/chainPublic";
import { BRAND_GITHUB } from "@/lib/brand";
import { ChainLogo } from "@/components/launchpad/ChainLogo";
import { getTranslations } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("info");
  return pageMetadata({ path: "/agents", title: t("agents.meta.title"), description: t("agents.meta.description") });
}

/** The page's sections, each with the mark its heading carries (labels: info.agents.sections.<id>). */
const sections = [
  { id: "launch", icon: Rocket },
  { id: "read", icon: BookOpen },
  { id: "trade", icon: ArrowLeftRight },
] as const;

// descriptions are messages: info.agents.read.<key>
const endpoints = [
  { path: "/api/launch/list", key: "list", query: "?chain=base|robinhood|arc&sort=live|new|mcap|volume|gainers|holders&window=1h|24h|all&limit=50" },
  { path: "/api/launch/feed", key: "feed" },
  { path: "/api/launch/meta/<token>", key: "meta" },
  { path: "/llms.txt", key: "llms" },
] as const;

/** Inline code in the prose. Identifiers and numbers are written inside the messages, the same in every language; addresses come from here. */
const code = (chunks: ReactNode) => <code>{chunks}</code>;

export default async function AgentsPage() {
  const t = await getTranslations("info");
  const factory = launchpad("base").factory ?? "<factory>";
  const locker = launchpad("base").locker ?? "<locker>";
  const launchExample = `cast send ${factory} \\
  "launch((string,string,string,address,uint256,int24,uint24,bytes32,(address,uint16)[]))" \\
  "(My Token,MYT,,0x0000000000000000000000000000000000000000,0,184200,10000,0x$(openssl rand -hex 32),[(0xYourWallet,10000)])" \\
  --rpc-url https://mainnet.base.org --private-key $PK`;

  return (
    <main className={`${shell.page} ${styles.page}`}>
      <SectionIntro eyebrow={t("agents.eyebrow")} icon={<Bot />} title={t("agents.title")} description={t("agents.description")}>
        <a href="/llms.txt" className={shell.action}><FileCode2 size={16} aria-hidden="true" />{t("agents.readLlms")}<ArrowUpRight size={14} aria-hidden="true" /></a>
        <a href={BRAND_GITHUB} target="_blank" rel="noreferrer" className={shell.textLink}>{t("agents.exploreSource")}<ArrowUpRight size={14} aria-hidden="true" /></a>
      </SectionIntro>

      <div className={styles.entry}>
        <div className={styles.entryHeading}><span className={styles.entryIcon} aria-hidden="true"><Terminal size={17} /></span><p>{t("agents.entryTop")}<span>{t("agents.entryBottom")}</span></p></div>
        <a href="#launch">{t("agents.start")}<ArrowDown size={15} aria-hidden="true" /></a>
      </div>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <nav aria-label={t("agents.sectionsLabel")}>
            <p className={styles.indexLabel}>{t("agents.onThisPage")}</p>
            {sections.map(({ id, icon: Icon }) => <a key={id} href={`#${id}`}><span aria-hidden="true"><Icon size={13} /></span>{t(`agents.sections.${id}`)}<ArrowRight size={13} aria-hidden="true" /></a>)}
          </nav>
          <p className={styles.sidebarNote}>{t("agents.readHint")}<br />{t("agents.writeHint")}</p>
        </aside>

        <div className={styles.content}>
          <section id="launch" tabIndex={-1} className={`${shell.anchorSection} ${styles.section}`} aria-labelledby="agents-launch-title">
            <div className={styles.sectionHeading}><span className={styles.sectionIcon} aria-hidden="true"><Rocket size={17} /></span><div><h2 id="agents-launch-title">{t("agents.sections.launch")}</h2><p>{t("agents.launch.subtitle")}</p></div></div>
            <div className={styles.networks}>
              {CHAIN_KEYS.map((chain) => {
                const config = launchpad(chain);
                return <div key={chain} className={styles.network}>
                  <div className={styles.networkHeading}><h3><ChainLogo chain={chain} size={16} />{CHAIN_LABELS[chain]}</h3><span>{t("agents.launch.chain")} <b>{CHAINS[chain].id}</b></span></div>
                  <dl>{(["factory", "locker"] as const).map((contract) => <div key={contract}>
                    <dt>{t(`agents.launch.${contract}`)}</dt>
                    <dd>{config[contract] ? <a href={explorerAddress(chain, config[contract])} target="_blank" rel="noreferrer" aria-label={t(`agents.launch.${contract}Address`, { chain: CHAIN_LABELS[chain], address: config[contract] })}><code>{config[contract]}</code><ArrowUpRight size={13} aria-hidden="true" /></a> : <span>{t("agents.launch.notDeployed")}</span>}</dd>
                  </div>)}</dl>
                </div>;
              })}
            </div>
            <p className={styles.prose}>{t.rich("agents.launch.call", { code })}</p>
            <AgentsCodeBlock title={t("agents.launch.exampleTitle")} language="Shell · cast" code={launchExample} />
            <p className={styles.exampleNote}>{t("agents.launch.exampleNote")}</p>
            <div className={styles.reference}>
              <div className={styles.referenceHeading}><Braces size={16} aria-hidden="true" /><h3>{t("agents.launch.parameters")}</h3></div>
              <dl className={styles.parameters}>
                <div><dt><code>quote</code></dt><dd>{t.rich("agents.launch.quote", { code, twig: "0x6aC18bcf4eDE02591d4917452700ea5eaAea13c1", gitlawbBase: "0x5F980Dcfc4c0fa3911554cf5ab288ed0eb13DBa3", gitlawbRobinhood: "0xd1b0d44E4f6ed940fcC7A9F59Bf30Daf62cCFe3D", usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" })}</dd></div>
                <div><dt><code>supply</code></dt><dd>{t.rich("agents.launch.supply", { code })}</dd></div>
                <div><dt><code>startTick</code></dt><dd>{t.rich("agents.launch.startTick", { code })}</dd></div>
                <div><dt><code>lpFee</code></dt><dd>{t.rich("agents.launch.lpFee", { code })}</dd></div>
                <div><dt><code>recipients</code></dt><dd>{t.rich("agents.launch.recipients", { code })}</dd></div>
              </dl>
            </div>
            <div className={styles.metadata}>
              <div className={styles.subheading}><span className={styles.method}>POST</span><h3>{t("agents.launch.metadataHeading")}</h3><span className={styles.optional}>{t("agents.launch.optional")}</span></div>
              <p className={styles.prose}>{t.rich("agents.launch.metadata", { code })}</p>
              <p className={styles.prose}>{t("agents.launch.firstBuy")}</p>
              <AgentsCodeBlock title={t("agents.launch.metadataTitle")} language={t("agents.reference")} code={`POST ${SITE_URL}/api/launch/meta\n\n{chain, launcher, salt, name, symbol, description?, image_url?, website?, x_handle?}`} />
            </div>
          </section>

          <section id="read" tabIndex={-1} className={`${shell.anchorSection} ${styles.section}`} aria-labelledby="agents-read-title">
            <div className={styles.sectionHeading}><span className={styles.sectionIcon} aria-hidden="true"><BookOpen size={17} /></span><div><h2 id="agents-read-title">{t("agents.sections.read")}</h2><p>{t("agents.read.subtitle")}</p></div></div>
            <div className={styles.endpoints}>
              <div className={styles.endpointHeader}><span>{t("agents.read.publicEndpoints")}</span><span>{t("agents.read.noKey")}</span></div>
              {endpoints.map((endpoint) => <div key={endpoint.path} className={styles.endpoint}>
                <span className={styles.method}>GET</span>
                <div><code className={styles.endpointPath}>{endpoint.path}</code><p>{t(`agents.read.${endpoint.key}`)}</p>{"query" in endpoint && <code className={styles.query}>{endpoint.query}</code>}</div>
              </div>)}
            </div>
            <AgentsCodeBlock title={t("agents.read.exampleTitle")} language={t("agents.httpReference")} code={`GET ${SITE_URL}/api/launch/list?chain=base|robinhood|arc&sort=live|new|mcap|volume|gainers|holders&window=1h|24h|all&limit=50\nGET ${SITE_URL}/api/launch/feed              # latest launches + trades\nGET ${SITE_URL}/api/launch/meta/<token>      # image / description / links\nGET ${SITE_URL}/llms.txt`} />
            <div className={styles.dataNote}>
              <p>{t.rich("agents.read.amounts", { code })}</p>
              <p>{t.rich("agents.read.polling", { code })}</p>
            </div>
          </section>

          <section id="trade" tabIndex={-1} className={`${shell.anchorSection} ${styles.section}`} aria-labelledby="agents-trade-title">
            <div className={styles.sectionHeading}><span className={styles.sectionIcon} aria-hidden="true"><ArrowLeftRight size={17} /></span><div><h2 id="agents-trade-title">{t("agents.sections.trade")}</h2><p>{t("agents.trade.subtitle")}</p></div></div>
            <div className={styles.tradeReference}>
              <div><span className={styles.tradeLabel}>{t("agents.trade.swapLabel")}</span><h3>{t("agents.trade.swapHeading")}</h3><p className={styles.prose}>{t.rich("agents.trade.swap", { code })}</p></div>
              <div><span className={styles.tradeLabel}>{t("agents.trade.collectLabel")}</span><h3>{t("agents.trade.collectHeading")}</h3><p className={styles.prose}>{t.rich("agents.trade.collect", { code, locker })}</p></div>
            </div>
            <p className={styles.exampleNote}>{t("agents.trade.stocks")}</p>
            <div className={styles.metadata}>
              <div className={styles.subheading}><span className={styles.method}>POST</span><h3>{t("agents.trade.syncHeading")}</h3></div>
              <p className={styles.prose}>{t.rich("agents.trade.sync", { code })}</p>
              <AgentsCodeBlock title={t("agents.trade.syncTitle")} language={t("agents.httpReference")} code={`POST ${SITE_URL}/api/launch/sync?chain=base|robinhood|arc&tx=0x…`} />
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
