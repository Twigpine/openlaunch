import Link from "next/link";
import { btn } from "@/components/ui";
import { getTranslations } from "@/i18n/server";

export default async function NotFound() {
  const t = await getTranslations("info");
  const tc = await getTranslations("common");
  return (
    <main aria-label={t("errors.pageNotFound")} className="mx-auto max-w-3xl px-4 py-24 text-center space-y-5">
      <h1 className="font-display font-bold text-7xl text-brand-soft [text-shadow:0_1px_0_#d6d3d1]">404</h1>
      <p className="text-[15px] text-body">{t("errors.notFound")}</p>
      <div className="flex items-center justify-center gap-3">
        <Link href="/" className={btn.primary}>
          {t("errors.backHome")}
        </Link>
        <Link href="/launch" className={btn.secondary}>
          {tc("launchToken")}
        </Link>
      </div>
    </main>
  );
}
