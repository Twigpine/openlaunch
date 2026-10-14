import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import Web3Provider from "@/components/Web3Provider";
import Header from "@/components/Header";
import TxToasts from "@/components/launchpad/TxToasts";
import LiveProvider from "@/components/launchpad/LiveProvider";
import { getLaunchFeed, getLaunchTotalsForRequest } from "@/lib/launchpad/queries";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { SITE_URL } from "@/lib/chainPublic";
import { BRAND, BRAND_DOMAIN, BRAND_GITHUB, BRAND_X, SITE_DESCRIPTION, SITE_TITLE, SOCIAL_DESCRIPTION } from "@/lib/brand";
import { siteJsonLdHtml, siteVerification } from "@/lib/seo";
import Footer from "@/components/Footer";
import RouteProgress from "@/components/RouteProgress";
import ThemeProvider from "@/components/ThemeProvider";
import IntlProvider from "@/components/IntlProvider";
import { getLocale, getTranslations } from "@/i18n/server";
import { translationOf } from "@/i18n/messages";
import { Suspense } from "react";
import { geist, geistMono } from "./fonts";

const TITLE = SITE_TITLE;
const DESCRIPTION = SITE_DESCRIPTION;

const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: TITLE, template: `%s · ${BRAND_DOMAIN}` },
  description: DESCRIPTION,
  applicationName: BRAND,
  // No canonical here: metadata merges shallowly, so a root canonical of "/" was inherited by every
  // page without its own (launch, rules, feed, agents) and told search engines they were duplicates
  // of the home page. Each indexable page declares its own canonical.
  verification: siteVerification(process.env),
  openGraph: { siteName: BRAND_DOMAIN, title: TITLE, description: SOCIAL_DESCRIPTION, type: "website", url: SITE_URL },
  twitter: { card: "summary_large_image", site: `@${BRAND_X}`, title: TITLE, description: SOCIAL_DESCRIPTION },
};

/**
 * The tab title and description in the reader's language. The OpenGraph and X previews stay English: link crawlers
 * send no language, so that is what every share shows anyway.
 */
export async function generateMetadata(): Promise<Metadata> {
  if ((await getLocale()) === "en") return metadata;
  const t = await getTranslations("common");
  return { ...metadata, title: { default: t("site.title"), template: `%s · ${BRAND_DOMAIN}` }, description: t("site.description") };
}

// Light is the default; dark is a class the header toggle adds, never an OS preference, so the
// pre-CSS hints stay light. ThemeProvider keeps theme-color in step after a toggle.
export const viewport: Viewport = { themeColor: "#FAFAF8", colorScheme: "light", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Minted per request in src/proxy.ts; next-themes' inline theme script must carry it to run under the CSP.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const locale = await getLocale();
  const usd = await ethUsd();
  const [feed, totals] = await Promise.all([getLaunchFeed(24, usd).catch(() => []), getLaunchTotalsForRequest(usd)]);
  // Organization + WebSite + WebApplication: the entity record search engines reconcile the brand word against.
  const siteJsonLd = siteJsonLdHtml({ siteUrl: SITE_URL, brand: BRAND, domain: BRAND_DOMAIN, description: SITE_DESCRIPTION, sameAs: [`https://x.com/${BRAND_X}`, BRAND_GITHUB] });
  return (
    <html lang={locale} className={`${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body id="site-top" tabIndex={-1} className="min-h-screen flex flex-col">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: siteJsonLd }} />
        <IntlProvider locale={locale} translation={locale === "en" ? undefined : translationOf(locale)}>
        <ThemeProvider nonce={nonce}>
        <Web3Provider>
          <LiveProvider initial={{ at: 0, feed, totals, ethUsd: usd }}>
          <Suspense fallback={null}>
            <RouteProgress />
          </Suspense>
          <Header />
          <TxToasts />
          <div className="flex-1 min-w-0">{children}</div>
          <Footer />
          </LiveProvider>
        </Web3Provider>
        </ThemeProvider>
        </IntlProvider>
      </body>
    </html>
  );
}
