/**
 * What is running: the release version and the commit it was built from. Pure (node --test loads it directly), and read
 * on the server only (the footer and /api/health): package.json is not sent to the browser.
 *
 * The version lives in package.json alone. A release is the git tag `v<version>` on the deployed commit, with its notes
 * on GitHub Releases; scripts/deploy.sh refuses to deploy a commit whose tag and version disagree.
 */
import pkg from "../../package.json";
import { BRAND_GITHUB } from "./brand.ts";

const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{7,40}$/;

/** A plain major.minor.patch, or null: a version is shown and linked only when it is exactly that. */
export function cleanVersion(raw: unknown): string | null {
  return typeof raw === "string" && SEMVER.test(raw) ? raw : null;
}

/** A git commit id as the build passed it (GIT_SHA), or null: anything else is never echoed back. */
export function cleanCommit(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return SHA.test(s) ? s : null;
}

/** The release in package.json, e.g. "1.0.0"; null if the field is not a plain version. */
export const APP_VERSION: string | null = cleanVersion(pkg.version);

/** The commit this build was made from (the Dockerfile's GIT_SHA build arg); null on a local run. */
export function appCommit(raw: string | undefined = process.env.GIT_SHA): string | null {
  return cleanCommit(raw);
}

/** The release's notes on GitHub. */
export function releaseUrl(version: string): string {
  return `${BRAND_GITHUB}/releases/tag/v${version}`;
}
