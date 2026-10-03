import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";
import { ArrowDown, ArrowUpRight, Braces, FileCode2, Terminal } from "lucide-react";
import SectionIntro from "@/components/sections/SectionIntro";
import DocumentationContents from "@/components/sections/DocumentationContents";
import AgentsCodeBlock from "@/components/sections/AgentsCodeBlock";
import { agentExamples } from "@/components/sections/agent-examples";
import shell from "@/components/sections/SectionShell.module.css";
import styles from "@/components/sections/Agents.module.css";
import { launchpad } from "@/lib/launchpad/config";
import { CHAIN_KEYS, CHAIN_LABELS, CHAINS, SITE_URL, explorerAddress } from "@/lib/chainPublic";
import { BRAND_GITHUB } from "@/lib/brand";

export const metadata: Metadata = pageMetadata({ path: "/agents", title: "Agents", description: "Launch and trade tokens from an agent: one contract call, plus a JSON API for the list, trades and metadata." });

const sections = [
  { id: "launch", number: "01", label: "Launch a token" },
  { id: "read", number: "02", label: "Read the API" },
  { id: "trade", number: "03", label: "Trade & collect" },
] as const;

const endpoints = [
  { path: "/api/launch/list", description: "Browse and sort launches", query: "?chain=base|robinhood|arc&sort=live|new|mcap|volume|gainers|holders&window=1h|24h|all&limit=50" },
  { path: "/api/launch/feed", description: "Latest launches + trades" },
  { path: "/api/launch/meta/<token>", description: "Image, description and links" },
  { path: "/llms.txt", description: "Machine-readable reference" },
] as const;

export default function AgentsPage() {
  return (
    <main className={`${shell.page} ${styles.page}`}>
      <SectionIntro eyebrow="Developer reference" title="Agents" description={<>No API key, no signup, no platform fee. A launch is one contract call from your wallet. Keep ETH for gas on Base and Robinhood Chain, or USDC on Arc. Everything the site shows is also JSON.</>}>
        <a href="/llms.txt" className={shell.action}><FileCode2 size={16} aria-hidden="true" />Read llms.txt<ArrowUpRight size={14} aria-hidden="true" /></a>
        <a href={BRAND_GITHUB} target="_blank" rel="noreferrer" className={shell.textLink}>Explore the source<ArrowUpRight size={14} aria-hidden="true" /></a>
      </SectionIntro>

      <div className={styles.entry}>
        <div className={styles.entryHeading}><Terminal size={19} aria-hidden="true" /><p>The interface is optional.<span>The same protocol is yours to build with.</span></p></div>
        <a href="#launch">Start with a launch<ArrowDown size={15} aria-hidden="true" /></a>
      </div>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <DocumentationContents sections={sections} aria-label="Agent documentation sections" />
          <p className={styles.sidebarNote}>Use the JSON API to read.<br />Use your wallet to write on-chain.</p>
        </aside>

        <div className={styles.content}>
          <section id="launch" tabIndex={-1} className={`${shell.anchorSection} ${styles.section}`} aria-labelledby="agents-launch-title">
            <div className={styles.sectionHeading}><span className={styles.sectionNumber}>01</span><div><h2 id="agents-launch-title">Launch a token</h2><p>One call, from your own wallet.</p></div></div>
            <div className={styles.networks}>
              {CHAIN_KEYS.map((chain) => {
                const config = launchpad(chain);
                return <div key={chain} className={styles.network}>
                  <div className={styles.networkHeading}><h3>{CHAIN_LABELS[chain]}</h3><span>Chain <b>{CHAINS[chain].id}</b></span></div>
                  <dl>{(["factory", "locker"] as const).map((contract) => <div key={contract}>
                    <dt>{contract}</dt>
                    <dd>{config[contract] ? <a href={explorerAddress(chain, config[contract])} target="_blank" rel="noreferrer" aria-label={`${CHAIN_LABELS[chain]} ${contract}: ${config[contract]}, view on explorer`}><code>{config[contract]}</code><ArrowUpRight size={13} aria-hidden="true" /></a> : <span>not deployed yet</span>}</dd>
                  </div>)}</dl>
                </div>;
              })}
            </div>
            <p className={styles.prose}>Call <code>launch(params)</code> on that chain&apos;s factory. Choose a network below to see its address and chain ID. Base and Robinhood examples use ETH; Arc uses ERC-20 USDC with 6 decimals and an opening market cap of approximately 10,000 USDC.</p>
            <AgentsCodeBlock title="Launch parameters" language="JSON · parameter reference" examples={agentExamples("launch")} />
            <p className={styles.exampleNote}>Example only, not an executable transaction. Replace the placeholders, create a unique salt and simulate the call with your own wallet tooling before signing. Copying does not connect a wallet or send anything. Never share your private key.</p>
            <div className={styles.reference}>
              <div className={styles.referenceHeading}><Braces size={16} aria-hidden="true" /><h3>Parameters, without the guesswork</h3></div>
              <dl className={styles.parameters}>
                <div><dt><code>quote</code></dt><dd>ETH uses address zero on Base and Robinhood Chain. Arc requires the ERC-20 USDC address, not address zero; native USDC accounting uses 18 decimals while the ERC-20 quote uses 6. {CHAIN_KEYS.map((chain) => <span key={chain}>{CHAIN_LABELS[chain]} quote addresses: {launchpad(chain).quotes.filter((quote) => quote.key !== "eth").map((quote, index) => <span key={quote.key}>{index > 0 ? "; " : ""}{quote.symbol} <code>{quote.address}</code></span>)}. </span>)}For any ERC-20 quote call <code>findSalt(...)</code> first so the token address sorts above the quote.</dd></div>
                <div><dt><code>supply</code></dt><dd><code>0</code> means the default <code>1B</code> supply.</dd></div>
                <div><dt><code>startTick</code></dt><dd>Sets the opening market cap. A multiple of <code>200</code>; <code>184200 ≈ 10 ETH</code> FDV for <code>1B</code> supply. The examples derive this value using the chosen quote&apos;s decimals. Do not reuse an ETH tick for Arc&apos;s 6-decimal USDC quote.</dd></div>
                <div><dt><code>lpFee</code></dt><dd>In pips: <code>0</code>, <code>10000 = 1%</code>, or <code>30000 = 3%</code>.</dd></div>
                <div><dt><code>recipients</code></dt><dd>Empty means fees are burned. Otherwise, shares are in bps and sum to <code>10000</code>.</dd></div>
              </dl>
            </div>
            <div className={styles.metadata}>
              <div className={styles.subheading}><span className={styles.method}>POST</span><h3>Add metadata first</h3><span className={styles.optional}>Optional</span></div>
              <p className={styles.prose}>For an image, description or links, send metadata first. The response contains the <code>uri</code> to pass as <code>metadataURI</code> and the predicted token address.</p>
              <p className={styles.prose}>Buy a little right after the launch confirms (a Universal Router swap on the new pool; the site&apos;s form suggests about $25). A token with no holder and no price move reads as dead on screeners and sits under quiet launches on the home page until an outside wallet trades it.</p>
              <AgentsCodeBlock title="Metadata request shape" language="Reference" code={`POST ${SITE_URL}/api/launch/meta\n\n{chain, launcher, salt, name, symbol, description?, image_url?, website?, x_handle?}`} />
            </div>
          </section>

          <section id="read" tabIndex={-1} className={`${shell.anchorSection} ${styles.section}`} aria-labelledby="agents-read-title">
            <div className={styles.sectionHeading}><span className={styles.sectionNumber}>02</span><div><h2 id="agents-read-title">Read the API</h2><p>JSON endpoints, plus a plain-text agent reference.</p></div></div>
            <div className={styles.endpoints}>
              <div className={styles.endpointHeader}><span>Public endpoints</span><span>No API key</span></div>
              {endpoints.map((endpoint) => <div key={endpoint.path} className={styles.endpoint}>
                <span className={styles.method}>GET</span>
                <div><code className={styles.endpointPath}>{endpoint.path}</code><p>{endpoint.description}</p>{"query" in endpoint && <code className={styles.query}>{endpoint.query}</code>}</div>
              </div>)}
            </div>
            <AgentsCodeBlock title="Read endpoints" language="HTTP reference" examples={agentExamples("read")} />
            <div className={styles.dataNote}>
              <p>Raw token and quote amounts are decimal integer strings. Use <code>quote_decimals</code> for quote amounts, not a blanket <code>18</code> decimals. <code>price_quote</code> and <code>fdv_quote</code> are numbers in the token&apos;s quote asset; explicit <code>price_usd</code>, <code>fdv_usd</code> and <code>volume_usd</code> fields are USD values and may be <code>null</code> when pricing is unavailable.</p>
              <p>Poll modestly and back off on errors. Indexing and server-side caching mean responses are not a guarantee of the latest chain state, even when an HTTP response uses <code>no-store</code>.</p>
            </div>
          </section>

          <section id="trade" tabIndex={-1} className={`${shell.anchorSection} ${styles.section}`} aria-labelledby="agents-trade-title">
            <div className={styles.sectionHeading}><span className={styles.sectionNumber}>03</span><div><h2 id="agents-trade-title">Trade & collect</h2><p>Standard pools. Direct contract calls.</p></div></div>
            <div className={styles.tradeReference}>
              <div><span className={styles.tradeLabel}>Swap</span><h3>Speak Uniswap v4</h3><p className={styles.prose}>Pools are plain Uniswap v4, with tick spacing <code>200</code> and no hook. The quote can be ETH, GITLAWB (Base and Robinhood Chain), USDG (Robinhood Chain), USDC (Arc) or a supported issuer-registry stock token. Get the actual pool key with <code>poolKeyOf(token)</code> on the factory. Swap through the Universal Router with a <code>V4_SWAP</code> command, or any router that speaks v4.</p></div>
              <div><span className={styles.tradeLabel}>Collect</span><h3>Pay out accrued fees</h3><p className={styles.prose}>Anyone may call <code>collect(tokenId)</code> on that chain&apos;s locker to pay out accrued fees. Use the matching chain address above. Simulate the call first; collecting still needs a signed transaction and network gas.</p></div>
            </div>
            <p className={styles.exampleNote}>Tokenized stocks are third-party securities offered under Regulation S, not to US persons. The site recognizes them from issuer registries, not on-chain names.</p>
            <div className={styles.metadata}>
              <div className={styles.subheading}><span className={styles.method}>POST</span><h3>Sync your transaction</h3></div>
              <p className={styles.prose}>After a transaction you sent, request immediate indexing with this endpoint. Background polling normally runs about every <code>15s</code>; receipt availability and RPC errors can delay indexing.</p>
              <AgentsCodeBlock title="Transaction sync endpoint" language="HTTP reference" examples={agentExamples("sync")} />
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
