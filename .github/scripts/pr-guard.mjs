#!/usr/bin/env node
// pr-guard: the security gate for pull requests into main (.github/workflows/pr-guard.yml).
//
// It runs from main's copy of this file (pull_request_target) with a read-only token, and it reads the pull request only as
// git objects: nothing from the pull request is checked out, installed or executed here. Node built-ins only, so the guard
// has no dependencies of its own to trust.
//
// Two kinds of finding:
//   block   red for everyone, the owners included. Merging takes a deliberate admin bypass.
//   review  red until an owner approves the exact head commit with a pull request review (then re-run the job). On an
//           owner's own pull request it is a notice, as long as an owner pushed the head commit.
//
// Findings name the matched token (an address, a host, a function), never the whole line, and never a secret's value.
//
// Local replay:  node .github/scripts/pr-guard.mjs --base <ref> --head <ref> [--author <login>] [--pusher <login>] [--approved] [--json]

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Logins whose approval counts, and whose own pull requests turn "review" findings into notices. */
export const OWNERS = ["kevincodex1"];

export const LOCK_PATH = "contracts/deployed.lock";
/** Locked whether or not the lock lists them: the lock, the scripts that check it, and the submodule table. */
const ALWAYS_LOCKED = [LOCK_PATH, "contracts/script/check-deployed-sources.sh", "contracts/script/check-arc-factory.sh", ".gitmodules"];
/** The library folder is locked as a whole: a new folder beside the pinned submodules could stand in for an import. */
const LOCKED_FOLDER = "contracts/lib/";

const MAX_SCAN_FILES = 1500;
const MAX_TEXT_BYTES = 2_000_000;
const MAX_BLOB_BYTES = 25_000_000;
const MAX_LINE = 2000;
const MAX_FINDINGS_PER_FILE = 200;

export const RULES = {
  "contract-locked": { tier: "block", title: "Deployed contract files changed", help: "These files are pinned in contracts/deployed.lock, or stand guard over it (the lock itself, the scripts that check it, .gitmodules, everything under contracts/lib/), and stay byte-identical to what is live. A change for another chain goes in a new copied file (see contracts/src/LaunchFactoryArc.sol)." },
  "ci-config": { tier: "block", title: "CI, the guard or code owners changed", help: "Workflow and guard changes come from the maintainers, in a pull request of their own." },
  "dev-machine": { tier: "block", title: "Editor, agent or git hook configuration", help: "These files can run commands or steer an AI agent on a maintainer's machine the moment the branch is checked out. The repository tracks none of them." },
  "registry-config": { tier: "block", title: "Package manager configuration", help: "A registry, proxy or script setting here redirects every install." },
  "secret-file": { tier: "block", title: "A file that holds keys or wallet material", help: "Environment files, key files and wallet files are never committed. If this was real, rotate it now: the branch is public." },
  secret: { tier: "block", title: "A credential in the diff", help: "Remove it from the branch history and rotate it now: the branch is public. The value is not repeated here." },
  submodule: { tier: "block", title: "Submodule added, removed or re-pinned", help: "The pinned libraries decide the contract bytecode and run in CI." },
  symlink: { tier: "block", title: "Symbolic link", help: "A link can point outside the repository or stand in for a file the guard would otherwise read." },
  "hidden-unicode": { tier: "block", title: "Invisible or direction-changing characters", help: "They make code read differently from what runs. Write the character as a \\u escape so it shows in review." },
  binary: { tier: "block", title: "A binary that is not a plain image or web font", help: "It cannot be reviewed as text. An image (PNG, JPEG, GIF, WebP, AVIF, ICO) or a web font (WOFF, WOFF2) must be a real file of the type its name says." },
  "svg-active": { tier: "block", title: "An SVG that carries script", help: "A scripted SVG served from the site runs with the site's origin." },
  lockfile: { tier: "block", title: "Lockfile entry outside the npm registry", help: "Every package resolves to https://registry.npmjs.org with a sha512 integrity hash, under its own name and version." },
  "install-script": { tier: "block", title: "A new script that runs at install time", help: "Install scripts run on every maintainer machine, in CI and in the production image build." },
  "dependency-source": { tier: "block", title: "A dependency that does not come from the npm registry", help: "Git, URL, file and aliased dependencies skip the registry's integrity checks." },
  "case-collision": { tier: "block", title: "A path that differs from another one only by letter case", help: "On macOS and Windows the two overwrite each other at checkout. The other one may be in the repository already or new in this pull request." },
  "odd-path": { tier: "block", title: "A file name with control, invisible or non-ASCII characters", help: "A Mac folds letters such as the long s onto plain ones, so a name like this can land on an existing file at checkout. Rename the file with plain characters." },
  "criss-cross": { tier: "block", title: "A history with more than one common ancestor", help: "With a history like this the diff does not show what merging the pull request changes: the merge can undo work on main that the diff never mentions. Rebase the branch on main, or merge main into it, and push." },
  unread: { tier: "block", title: "A file the guard could not read", help: "The rules that hold for everyone (credentials, hidden characters) could not be applied to it. Split the change up, or an admin merges it after reading it." },

  contracts: { tier: "review", title: "Contracts folder", help: "Any change under contracts/ that is not blocked above (a new contract, a test, a script, a document; added, edited or deleted) is read by an owner before it merges." },
  "contract-rules": { tier: "review", title: "Owner, pause, upgrade or fee switch in a contract", help: "CONTRIBUTING.md: no fee, no owner, no admin. Contracts that add one are not merged." },
  dependencies: { tier: "review", title: "Dependencies or npm scripts", help: "New packages are checked for who publishes them and why they are needed." },
  address: { tier: "review", title: "On-chain address", help: "Addresses decide where funds and approvals go. Each one is checked against its source." },
  "wallet-call": { tier: "review", title: "Wallet signing or sending", help: "Code that asks a wallet to sign, approve or send." },
  "new-host": { tier: "review", title: "A host the repository has not used before", help: "New network destinations and links. A host that code puts together at run time shows as (computed): there is nothing to compare it with." },
  "new-env": { tier: "review", title: "A new environment variable", help: "New configuration the deployment has to carry, or new access to existing secrets." },
  "dangerous-code": { tier: "review", title: "Code execution, raw HTML or shell", help: "Patterns that run code, inject markup, start processes or decode hidden text, and code that reads the whole environment, the home directory or a key store." },
  "auth-removed": { tier: "review", title: "A security check was removed", help: "Signature, nonce, rate limit or validation calls that the change drops." },
  "security-config": { tier: "review", title: "Security headers, proxy or files served as the site", help: "The Content-Security-Policy, the request proxy, the Next.js configuration, and files the site serves as they are: anything in app/public that is not a plain image, font or text file, and every SVG, page or XML file, since those run as, or vouch for, the site's origin." },
  "build-deploy": { tier: "review", title: "Build, deploy, database or script files", help: "Files that run during the build, the deploy or a migration against the production database." },
  policy: { tier: "review", title: "License or security policy", help: "The security contact and the license are changed by the maintainers." },
  "git-config": { tier: "review", title: "Git attributes", help: "Attributes change how files are diffed, merged and exported." },
  "dot-file": { tier: "review", title: "A hidden file or folder that is new to the repository", help: "Tools read their settings from names that begin with a dot. The ones known to run commands or steer an agent are blocked; any other new one is read by an owner (.gitignore, .gitkeep and .keep aside)." },
  opaque: { tier: "review", title: "Content that cannot be read by eye", help: "Very long lines, encoded blobs and obfuscated names." },
  media: { tier: "review", title: "Audio, video or PDF", help: "It cannot be reviewed as text." },
  unscanned: { tier: "review", title: "Not scanned in full", help: "The guard read this only for what is blocked for everyone, or could not list everything it found, so a person has to read the rest." },
};

// ---------- path rules ----------

const BLOCK_PATHS = [
  ["ci-config", /^\.github\/|^(docs\/)?CODEOWNERS$/i],
  ["dev-machine", /(^|\/)\.(claude|cursor|codex|gemini|qwen|windsurf|continue|aider[^/]*|clinerules|roo|kiro|zed|fleet|junie|amazonq|augment|trae|opencode|goose|vscode|idea|devcontainer|husky|githooks)(\/|$)|(^|\/)(CLAUDE|AGENTS|GEMINI|QWEN)(\.[^/]*)?\.md$|(^|\/)(\.cursorrules|\.clinerules|\.windsurfrules|\.goosehints|\.mcp\.json|opencode\.jsonc?|\.devcontainer\.json|[^/]*\.code-workspace|\.envrc|\.huskyrc(\.[^/]*)?|\.lintstagedrc(\.[^/]*)?|\.pre-commit-config\.ya?ml|\.?lefthook\.ya?ml|\.?mise(\.[^/]*)?\.toml)$/i],
  ["registry-config", /(^|\/)(\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|pnpm-workspace\.yaml|bunfig\.toml)$/i],
];
/** Added or modified only: deleting one of these is fine. */
const SECRET_FILE = /(^|\/)\.env(\.(?!example$)[^/]*)?$|\.(pem|p12|pfx|jks|keystore|key|address)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)$|(^|\/)(\.netrc|\.git-credentials)$|(^|\/)\.(aws|ssh|gnupg)\/|(^|\/)keystores?\/|(^|\/)(wallet|mnemonic|secrets?)[^/]*\.(json|txt|dat|ya?ml|toml|env)$/i;

const REVIEW_PATHS = [
  ["contracts", /^contracts\//],
  // app/public is served as it is, so everything in it counts except what cannot act: images and fonts (their bytes are
  // checked against their names) and plain text. A browser runs script in anything served as HTML or XML, and there are
  // dozens of such file types, so the rule names the few that are inert. Markup elsewhere in the app is served too
  // (icon.svg, sitemap.xml, an imported image), and so is the web app manifest.
  ["security-config", /^app\/src\/(proxy|middleware|instrumentation)\.[cm]?[jt]s$|^app\/src\/lib\/(security-headers|rpc-proxy)\.ts$|^app\/next\.config\.[cm]?[jt]s$|^app\/public\/(?!.*\.(png|jpe?g|gif|webp|avif|ico|woff2?|txt)$)|^app\/.*\.(svg|xml|xhtml?|html?|webmanifest)$|^app\/src\/app\/(.*\/)?manifest\.json$|^app\/(public|src\/app)\/\.well-known\//i],
  ["policy", /^(LICENSE[^/]*|SECURITY\.md)$/i],
  ["git-config", /(^|\/)\.gitattributes$/],
  ["build-deploy", /(^|\/)(Dockerfile[^/]*|\.dockerignore|docker-compose[^/]*\.ya?ml|fly[^/]*\.toml|vercel\.json|Makefile|Procfile)$|^app\/(scripts|db)\/|^app\/(postcss|eslint)\.config\.[cm]?[jt]s$|^app\/tsconfig[^/]*\.json$|^app\/\.env\.example$|\.(sh|bash|zsh|py|rb|pl|ps1|bat|cmd)$/i],
];

const MANIFEST = /(^|\/)package\.json$/;
const NPM_LOCK = /(^|\/)(package-lock|npm-shrinkwrap)\.json$/;
const OTHER_LOCK = /(^|\/)(yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|deno\.lock)$/;

/**
 * Named as a test. App code that imports one of these is flagged, so nothing that ships can hide here. Under a pages/
 * folder Next.js serves every file as a page, whatever it is called, so nothing there is a test.
 */
const isTest = (p) => /\.(test|spec)\.[cm]?[jt]sx?$|\.t\.sol$|^contracts\/test\//.test(p) && !/^app\/(src\/)?pages\//.test(p);
/** Everything that is not plainly prose is read as code, whatever its extension: LICENSE and LICENSE-MIT.txt are prose, LICENSES.ts is not. */
const isCode = (p) => !/\.(md|markdown|txt|rst|adoc|csv|tsv|diff|patch)$/i.test(p) && !/(^|\/)(LICENSE|NOTICE|AUTHORS)(-[\w.]+)?$/.test(p);
/** The file extension, lowercase and without its dot; "" when there is none. */
const ext = (p) => (/\.([A-Za-z0-9]+)$/.exec(p)?.[1] ?? "").toLowerCase();

// ---------- content rules ----------

/** A slice of a file's bytes as text, for comparing with a format's signature. */
const ascii = (b, from, to) => b.subarray(from, to).toString("latin1");
/** Images and fonts may be binary, when the bytes are what the name says. */
const MAGIC = {
  png: (b) => ascii(b, 0, 8) === "\x89PNG\r\n\x1a\n",
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => /^GIF8[79]a$/.test(ascii(b, 0, 6)),
  webp: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP",
  avif: (b) => ascii(b, 4, 8) === "ftyp" && /^(avif|avis|mif1)$/.test(ascii(b, 8, 12)),
  ico: (b) => b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0,
  woff: (b) => ascii(b, 0, 4) === "wOFF",
  woff2: (b) => ascii(b, 0, 4) === "wOF2",
};
const MEDIA = /\.(mp4|webm|mov|mp3|wav|ogg|m4a|pdf)$/i;

/** This machine, and the names reserved for documentation and tests. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|([a-z0-9-]+\.)*example\.(com|org|net)|([a-z0-9-]+\.)*(localhost|test|invalid|example))$/;
const PLACEHOLDER_PASSWORD = /^(pass(word)?|pw|secret|changeme|example|x{3,}|\*{3,}|\.{3}|your[-_]?\w*|<[^>]*>|\[[^\]]*\]|\$\{?\w+\}?)$/i;

/** [what it is, pattern, optional check on the match]. The value is never reported. */
const SECRETS = [
  ["a private key block", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/],
  ["a raw private key or seed", /(?:private[\s_-]?key|priv[\s_-]?key|secret[\s_-]?key|deployer[\s_-]?key|signer[\s_-]?key|\bsecret\b|\bseed\b|\bpk\b)[^\n]{0,40}?\b(?:0x)?[0-9a-f]{64}\b/i],
  ["a recovery phrase", /(?:mnemonic|seed[\s_-]?phrase|recovery[\s_-]?phrase)\W{1,8}((?:[a-z]{3,8}\s+){11,23}[a-z]{3,8})\b/i, (m) => !/^(test\s+){11}junk$/i.test(m[1].trim())],
  ["an AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ["an npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["an API secret key", /\b(?:sk|rk)[-_](?:ant-|proj-|live_|test_)[A-Za-z0-9_-]{20,}\b/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["a Fly.io token", /\bFlyV1\s+fm\d_[A-Za-z0-9+/=_-]{20,}/],
  ["a Telegram bot token", /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/],
  ["a signed token (JWT)", /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/],
  ["an RPC URL with its key", /(?:alchemy\.com\/v2\/|infura\.io\/v3\/|quiknode\.pro\/|blastapi\.io\/|ankr\.com\/[a-z_]+\/)[A-Za-z0-9_-]{20,}/i],
  ["a database URL with its password", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)s?:\/\/[^\s:@/]+:([^\s@/]{3,})@([^\s/:?"'`]+)/i, (m) => !PLACEHOLDER_PASSWORD.test(m[1]) && !LOCAL_HOST.test(m[2].toLowerCase())],
];

/** A finding's text with anything shaped like a credential taken out: a detail may quote a dependency's address or a version. */
const scrub = (text) =>
  SECRETS.reduce((out, [what, re]) => out.replace(new RegExp(re.source, `${re.flags.replace("g", "")}g`), `<${what}>`), String(text)).replace(/(:\/\/)[^\s/@"'<>]+@/g, "$1<credentials>@");

const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const INVISIBLE = /[\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B\u200C\u2028\u2029\u2060-\u2064\u206A-\u206F\u3164\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const EMOJI_BEFORE = /[\p{Extended_Pictographic}\uFE0F\u{1F3FB}-\u{1F3FF}]$/u;
const EMOJI_AFTER = /^\p{Extended_Pictographic}/u;

/** What is hidden in this text, or null. A joiner is fine inside an emoji sequence; a byte order mark only at the very start of a file. */
export function hiddenCharacter(text, atFileStart = false) {
  if (BIDI.test(text)) return "a text direction control";
  if (INVISIBLE.test(text)) return "an invisible character";
  if (CONTROL.test(text)) return "a control character";
  for (let i = text.indexOf("\u200D"); i !== -1; i = text.indexOf("\u200D", i + 1)) {
    if (!EMOJI_BEFORE.test(text.slice(Math.max(0, i - 2), i)) || !EMOJI_AFTER.test(text.slice(i + 1, i + 3))) return "a zero-width joiner outside an emoji";
  }
  // a line break to the compiler and the editor, but not to git or to this scan: what follows a "//" would run
  if (text.includes("\r")) return "a carriage return inside a line";
  // a variation selector belongs right after an emoji, or between a digit and its keycap; a run of them carries hidden bytes
  for (const m of text.matchAll(/[\uFE00-\uFE0F]/gu)) {
    const afterEmoji = /\p{Extended_Pictographic}$/u.test(text.slice(Math.max(0, m.index - 2), m.index));
    if (!afterEmoji && !(m[0] === "\uFE0F" && text[m.index + 1] === "\u20E3")) return "a variation selector outside an emoji";
  }
  const mark = text.indexOf("\uFEFF");
  if (mark > 0 || (mark === 0 && !atFileStart) || text.indexOf("\uFEFF", 1) > 0) return "a byte order mark inside the file";
  return null;
}

/** An element that runs or embeds something, under any namespace prefix: <script>, <svg:script>, <x:script xmlns:x="…">. */
const SVG_ELEMENT = /<(?:[^\s<>\/:"'=]+:)?(?:script|foreignObject|iframe|embed|object|handler|listener)\b/i;
/** An event handler attribute, or an animation that sets one. An attribute may sit on a line of its own, away from its "=". */
const SVG_HANDLER = /\son[a-z]+\s*=|attributeName\s*=\s*["']\s*on/i;
/** A stylesheet instruction, or a document type that defines text or default attributes (a default onload among them). */
const SVG_DECLARATION = /<\?xml-stylesheet|<!ENTITY|<!ATTLIST/i;
/**
 * The end of the XHTML namespace address, http://www.w3.org/1999/xhtml. HTML elements work inside an SVG only under that
 * namespace, so the file may not mention it anywhere. The end is enough, and it keeps this what it is: a search of the
 * file's text, not a check of where an address leads.
 */
const XHTML_NAMESPACE = "/1999/xhtml";

/**
 * What makes an SVG active, or null when nothing does. It is read as a whole file, because XML lets a tag and its
 * attributes run over several lines, and after undoing character references, because a browser reads
 * "&#106;avascript&#58;" as "javascript:" and drops tabs and line breaks from inside an address.
 * The matching is loose on purpose: a comment or a caption that only mentions <script> is refused as well.
 */
export function activeSvg(text) {
  const decoded = text
    .replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (whole, ref) => {
      const point = /^x/i.test(ref) ? parseInt(ref.slice(1), 16) : parseInt(ref, 10);
      return point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    })
    .replace(/&(colon|Tab|NewLine);/g, (whole, name) => ({ colon: ":", Tab: "\t", NewLine: "\n" })[name]);
  if (SVG_ELEMENT.test(decoded)) return "a script or an embedded document";
  if (SVG_HANDLER.test(decoded)) return "an event handler";
  if (/javascript:/i.test(decoded.replace(/[\t\n\r]/g, ""))) return "a javascript: address";
  if (SVG_DECLARATION.test(decoded)) return "a stylesheet instruction, or a document type that adds to the file";
  if (decoded.includes(XHTML_NAMESPACE)) return "HTML inside the image";
  return null;
}

const JS_FILE = /\.([cm]?[jt]sx?|mdx|vue|svelte|astro)$/i;
/** [what it is, pattern, optional: the files it applies to (Solidity's require() is not Node's)]. */
const DANGEROUS = [
  ["eval()", /(?<![\w$-])eval\s*(?:\?\.\s*)?\(|[,(=]\s*eval\s*[),;]/],
  ["the Function constructor", /(?<![\w$])Function\s*\(/],
  ["a timer given its code as a string", /\bset(?:Timeout|Interval)\s*\(\s*["'`]/],
  ["raw HTML injection", /dangerouslySetInnerHTML|\.(?:inner|outer)HTML\s*=|insertAdjacentHTML|document\.write(?:ln)?\s*\(/],
  ["a script, frame or embed tag", /<(?:script|iframe|embed|object)\b|createElement\(\s*["'`](?:script|iframe|embed|object)["'`]/i],
  ["starting a process", /child_process|\b(?:execSync|execFileSync|spawnSync|execFile)\s*\(|\bDeno\.(?:run|Command)\b|\bBun\.spawn/],
  ["the vm module", /["'](?:node:)?vm["']|\bvm\.(?:runIn\w+|Script|compileFunction)\b/],
  ["a computed import or require", /\b(?:import|require)\s*\(\s*(?:(?!["'`])[^)\s]|`[^`]*\$\{)/, JS_FILE],
  // the environment as one object: printed, spread, taken apart ({ KEY } = process.env) or handed on. A single variable
  // read by its name is "new-env" below.
  ["reading the whole environment", /\b(?:process|import\.meta)\.env\b(?!\s*(?:\?\.|\.)\s*[A-Za-z_$[]|\s*\[)/],
  ["an environment variable read by a computed name", /process\.env\[\s*(?!["'`])/],
  ["decoding hidden text", /\batob\s*\(|String\.fromCharCode|Buffer\.from\([^)\n]*["']base64(?:url)?["']/],
  ["a download piped to a shell", /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|base64\s+(?:-d|--decode)\b|\/dev\/tcp\//],
  ["reading the home directory or a key store", /\bhomedir\s*\(|\.ssh\/|\.aws\/|\.gnupg|\/etc\/passwd|\.config\/(?:solana|gcloud)|\.foundry\/keystores/],
];

const TEST_IMPORT = /(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*["'`][^"'`]*\.(?:test|spec)(?:\.[cm]?[jt]sx?)?["'`]/;

const WALLET = /\b(?:writeContracts?(?:Async)?|sendTransaction(?:Async)?|sendRawTransaction|sendCalls|signMessage(?:Async)?|signTypedData(?:Async)?|signTransaction|signAuthorization|personal_sign|eth_sign\w*|eth_send\w*|eth_requestAccounts|setApprovalForAll|increaseAllowance|max[Uu]int256|use(?:WriteContract|SendTransaction|SendCalls|SignMessage|SignTypedData|WalletClient)|(?:get|create)WalletClient|privateKeyToAccount|mnemonicToAccount)\b|window\.ethereum|["'`]wallet_[A-Za-z]+["'`]|functionName:\s*["'](?:approve|permit|transfer|transferFrom|setApprovalForAll)["']/g;

/** Checks whose removal matters: signatures, nonces, rate limits, validation, escaping. */
const AUTH = /\b(?:verify[A-Z]\w*|validate[A-Z]\w*|check[A-Z]\w*|admit[A-Z]\w*|assert[A-Z]\w*|require[A-Z]\w*|authori[sz]e\w*|authenticate\w*|recover\w+Address|consumeNonce|isNonce|issueNonce|rateLimited|cspNonce|isAddress|isOrigin|isOwn[A-Z]\w*|ADMIN_WALLETS|isAdmin\w*|sanitize[A-Z]\w*|escape[A-Z]\w*)\b/g;

/** CONTRIBUTING.md ground rules: no fee switch, owner, pause, allowlist or upgrade path. */
const CONTRACT_RULES = /\b(?:Ownable\w*|onlyOwner|owner|transferOwnership|renounceOwnership|setOwner|Pausable|whenNotPaused|_?pause[ds]?|_?unpause|UUPS\w*|\w*Upgradeable|upgradeTo\w*|delegatecall|selfdestruct|tx\.origin|allowlist\w*|whitelist\w*|blacklist\w*|blocklist\w*|set\w*Fee\w*|protocolFee\w*|platformFee\w*|feeSwitch\w*|\w*feeBps|admin)\b/gi;

const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
/** Not anyone's wallet: zero, the burn address, the native-asset placeholder. */
const SENTINELS = new Set(["0x" + "0".repeat(40), "0x000000000000000000000000000000000000dead", "0x" + "e".repeat(40)]);

/**
 * "scheme://authority", or "//authority" with no scheme. The authority (user, host, port) may hold a template placeholder
 * or a wildcard, and may be empty: "https://" + host. The same characters are searched for in the base branch (analyze).
 */
const URL_RE = /(\b(?:https?|wss?|ftp):)?\/\/([A-Za-z0-9.\-_~%:@[\]${}*]*)/gi;
/** The host of a URL authority, lowercased; "(computed)" when it is built at run time; null when there is none. */
export function hostOf(authority) {
  if (/[${}]/.test(authority)) return "(computed)";
  const host = authority.replace(/^[^@]*@/, "").replace(/:(?:\d*|\*)$/, "").replace(/\.+$/, "").toLowerCase();
  // "[https://example.org]": the bracket closes something around the address. "[::1]" is an address of its own.
  return (host.startsWith("[") ? host : host.replace(/[[\]]+$/, "")) || null;
}

/**
 * The hosts one line names. "(computed)" stands for a host that is put together at run time, where there is nothing to
 * compare: a placeholder in a template, and in code also a scheme with no host after it ("https://" + target) or an
 * address that ends its string and has more joined on ("https://known.org" + ".elsewhere.io"). In prose a scheme on
 * its own is only a mention. A scheme split further ("https:" + "//" + target) is not seen: a string that is only
 * "https:" is how code compares a protocol.
 */
export function hostsIn(line, code) {
  const hosts = new Set();
  for (const m of line.matchAll(URL_RE)) {
    const [whole, scheme, authority] = m;
    const rest = line.slice(m.index + whole.length);
    if (!scheme) {
      // without a scheme it is an address only where a string or a url() opens with it: "//cdn.example.io/x", "//" + host
      if (!/["'`(]/.test(line[m.index - 1] ?? "")) continue;
      if (authority === "" ? !/^["'`]/.test(rest) : !/[.$]/.test(authority)) continue;
    }
    const host = hostOf(authority);
    // the string ends with the address and more is joined on, other than a path, a query or a fragment written out
    const joined = /^["'`]\s*(?:\+|\.concat\()(?!\s*["'`][/?#])/.test(rest);
    if (host === "(computed)" || (code && (host === null || joined))) hosts.add("(computed)");
    if (host && host !== "(computed)") hosts.add(host);
  }
  // "https:\/\/x\.com" names x.com as well: a string with its slashes escaped, or a pattern. Only a host that is written
  // out in full is taken from these, since the rest of a pattern (/^https:\/\//, /\/$/) is not an address at all.
  if (line.includes("\\/")) {
    for (const [, scheme, authority] of line.replace(/\\([/.-])/g, "$1").matchAll(URL_RE)) {
      const host = scheme ? hostOf(authority) : null;
      if (host && /^(?:[a-z0-9*](?:[a-z0-9*-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) hosts.add(host);
    }
  }
  return hosts;
}

/** How often each security check is named in some lines: { name: count }. */
export function checksIn(lines) {
  const counts = new Map();
  for (const text of lines) {
    if (/^\s*(?:\/\/|\/\*|\*)/.test(text)) continue; // a check that is commented out is not a check
    for (const [name] of text.matchAll(AUTH)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/** A variable read by its name: process.env.NAME, process.env["NAME"], or a helper called with it, as in intEnv("NAME", 5). */
const ENV_RE = /process\.env\??\.([A-Za-z_]\w*)|process\.env(?:\?\.)?\[\s*["'`]([^"'`]+)["'`]\s*\]|import\.meta\.env\??\.([A-Za-z_]\w*)|\b[A-Za-z_$]*[eE]nv[A-Za-z_$]*\(\s*["'`]([A-Z][A-Z0-9_]*)["'`]/g;
const OPAQUE = [
  ["a long base64 blob", /[A-Za-z0-9+/]{400,}={0,2}/],
  ["a long hex blob", /(?:0x)?[0-9a-fA-F]{400,}/],
  ["a run of escaped characters", /(?:\\x[0-9a-fA-F]{2}){16,}|(?:\\u[0-9a-fA-F]{4}){16,}/],
  ["obfuscated names", /\b_0x[a-f0-9]{4,}\b/],
];

/**
 * Findings for one text file. `added` is [{ n, text }], `removed` is [text]. `facts` holds what the base branch already has:
 * addresses (lowercase), hosts, env (variable names).
 */
export function scanLines(path, added, removed, facts, blocksOnly = false) {
  const out = [];
  const add = (rule, detail, line) => out.push({ rule, path, detail, line });
  const code = isCode(path), test = isTest(path), svg = ext(path) === "svg";
  const contractSource = /^contracts\/(src|script)\/.*\.sol$/.test(path);

  for (const { n, text } of added) {
    const hidden = hiddenCharacter(text, n === 1);
    if (hidden) add("hidden-unicode", hidden, n);
    for (const [what, re, check] of SECRETS) {
      const m = re.exec(text);
      if (m && (!check || check(m))) add("secret", what, n);
    }
    if (blocksOnly) continue;
    if (text.length > MAX_LINE * 5) { add("opaque", `a line of ${text.length} characters, too long to match against the rules`, n); continue; }

    for (const host of hostsIn(text, code)) {
      if (host === "(computed)" || (!LOCAL_HOST.test(host) && !facts.hosts.has(host))) add("new-host", host, n);
    }
    if (!test) {
      for (const [address] of text.matchAll(ADDRESS)) {
        const lower = address.toLowerCase();
        if (!SENTINELS.has(lower)) add("address", `${address} (${facts.addresses.has(lower) ? "already in the repository" : "new to the repository"})`, n);
      }
    }
    if (text.length > MAX_LINE && code) add("opaque", `a line of ${text.length} characters`, n);
    for (const [what, re] of OPAQUE) if (re.test(text)) add("opaque", what, n);

    if (code && !svg) for (const [what, re, only] of DANGEROUS) if ((!only || only.test(path)) && re.test(text)) add("dangerous-code", what, n);
    if (code && !test) {
      if (TEST_IMPORT.test(text)) add("dangerous-code", "app code importing a test file", n);
      for (const [call] of text.matchAll(WALLET)) add("wallet-call", call.replace(/\s+/g, " "), n);
      for (const m of text.matchAll(ENV_RE)) {
        const name = m[1] ?? m[2] ?? m[3] ?? m[4];
        if (!facts.env.has(name)) add("new-env", name, n);
      }
    }
    if (contractSource && !/^\s*(\/\/|\/\*|\*)/.test(text)) for (const [word] of text.matchAll(CONTRACT_RULES)) add("contract-rules", word, n);
  }

  if (code && !test && !blocksOnly && removed.length > 0) {
    const kept = checksIn(added.map((l) => l.text));
    for (const [name, gone] of checksIn(removed)) {
      const net = gone - (kept.get(name) ?? 0);
      if (net > 0) add("auth-removed", `${name}: ${net} fewer ${net === 1 ? "use" : "uses"}`, null);
    }
  }
  return out;
}

/** Findings for a file's bytes: null when the file is text to scan line by line, otherwise the findings (possibly none). */
export function scanBytes(path, bytes) {
  const type = ext(path);
  if (MAGIC[type]) return MAGIC[type](bytes) ? [] : [{ rule: "binary", path, detail: `is not a real .${type} file`, line: null }];
  if (!bytes.subarray(0, 8000).includes(0)) return null;
  if (MEDIA.test(path)) return [{ rule: "media", path, detail: `${Math.ceil(bytes.length / 1024)} KB`, line: null }];
  return [{ rule: "binary", path, detail: "binary content", line: null }];
}

// ---------- dependencies ----------

const LIFECYCLE = new Set(["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare", "prepack", "postpack", "dependencies"]);
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions"];
/**
 * What the registry is asked for: a version, a range or a tag. Anything else names a place. npm reads a leading dot, a
 * slash, a colon, an @ or a tarball's name as a folder, a file, a URL, a git remote or an alias, so the rule lists what a
 * registry spec may hold instead of every way to leave the registry.
 */
const REGISTRY_SPEC = /^(?!\.)[\w.^~<>=*|+ -]*$/;
/** A tarball's name, as npm tests it. The dot in "tar.gz" is left bare on purpose: older npm reads "x.tar-gz" as a file too. */
const TARBALL = /\.(tgz|tar.gz|tar)$/i;
/** In `overrides`, "$name" stands for the version this manifest already asks for under that name. */
const OVERRIDE_REFERENCE = /^\$(@[a-z\d~-][\w.~-]*\/)?[a-z\d~-][\w.~-]*$/i;
/** True when a dependency's spec takes the package from anywhere but the npm registry. */
function offRegistry(field, spec) {
  const text = spec.trim();
  if (field === "overrides" && OVERRIDE_REFERENCE.test(text)) return false;
  return !REGISTRY_SPEC.test(text) || TARBALL.test(text);
}

/** A JSON object from a file's text: {} when the file is absent, null when it is not an object. */
const parseJson = (text) => {
  if (text === null) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};
/** { "name" or "parent > name": spec } for a dependency field, overrides flattened. */
function flatten(field, prefix = "") {
  const out = {};
  for (const [name, spec] of Object.entries(field ?? {})) {
    const key = prefix ? `${prefix} > ${name}` : name;
    if (spec && typeof spec === "object") Object.assign(out, flatten(spec, key));
    else out[key] = String(spec);
  }
  return out;
}

/** package.json at the head against the base (null when the file is new). */
export function lintManifest(path, headText, baseText) {
  const out = [];
  const add = (rule, detail) => out.push({ rule, path, detail, line: null });
  const head = parseJson(headText), base = parseJson(baseText);
  if (!head) return [{ rule: "dependency-source", path, detail: "is not a valid package.json", line: null }];
  if (baseText === null) add("dependencies", "a new package manifest");

  const before = base?.scripts ?? {}, after = head.scripts ?? {};
  for (const [name, command] of Object.entries(after)) {
    const had = Object.hasOwn(before, name);
    if (had && before[name] === command) continue;
    if (LIFECYCLE.has(name)) add("install-script", `the "${name}" script runs at install time`);
    else add("dependencies", `npm script "${name}" ${had ? "changed" : "added"}`);
  }
  for (const name of Object.keys(before)) if (!Object.hasOwn(after, name)) add("dependencies", `npm script "${name}" removed`);

  for (const field of DEP_FIELDS) {
    const now = flatten(head[field]), was = flatten(base?.[field]);
    for (const [name, spec] of Object.entries(now)) {
      const had = Object.hasOwn(was, name);
      if (had && was[name] === spec) continue;
      if (offRegistry(field, spec)) add("dependency-source", `${name} comes from "${spec}"`);
      else add("dependencies", had ? `${name} ${was[name]} → ${spec}` : `${name} ${spec} added (${field})`);
    }
    for (const name of Object.keys(was)) if (!Object.hasOwn(now, name)) add("dependencies", `${name} removed (${field})`);
  }
  const other = [...new Set([...Object.keys(head), ...Object.keys(base ?? {})])].filter(
    (key) => key !== "scripts" && !DEP_FIELDS.includes(key) && JSON.stringify(head[key]) !== JSON.stringify(base?.[key]),
  );
  if (baseText !== null && other.length > 0) add("dependencies", `other fields changed: ${other.join(", ")}`);
  return out;
}

/** package-lock.json at the head against the base: every entry from the registry, by its own name, with a sha512 hash. */
export function lintNpmLock(path, headText, baseText) {
  const out = [];
  const add = (rule, detail) => out.push({ rule, path, detail, line: null });
  const head = parseJson(headText), base = parseJson(baseText);
  if (!head || typeof head.packages !== "object" || head.packages === null) {
    return [{ rule: "lockfile", path, detail: "is not a lockfile the guard can read (lockfileVersion 3 with a packages table)", line: null }];
  }
  const before = base?.packages ?? {};
  const added = [], changed = [];
  for (const [key, entry] of Object.entries(head.packages)) {
    if (key === "") continue;
    if (!entry || typeof entry !== "object") { add("lockfile", `${key}: unreadable entry`); continue; }
    const name = key.split("node_modules/").pop();
    // "x/../../other/-/other-1.0.0" as a version would turn this package's address into another package's
    const versioned = typeof entry.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(entry.version);
    const label = versioned ? `${name}@${entry.version}` : name;
    if (!key.startsWith("node_modules/") && !key.includes("/node_modules/")) add("lockfile", `${key}: a package outside node_modules`);
    else if (!/^(?:@[A-Za-z0-9~-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/.test(name)) add("lockfile", `${key}: not a package name`);
    else if (entry.link) add("lockfile", `${name}: a link to a local folder`);
    else if (entry.inBundle) add("lockfile", `${label}: bundled inside another package, with no hash of its own`);
    else if (entry.name && entry.name !== name) add("lockfile", `${name} is an alias for ${entry.name}`);
    else if (!versioned) add("lockfile", `${name}: its version is not a version number`);
    else {
      const tarball = `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${entry.version}.tgz`;
      if (entry.resolved !== tarball) add("lockfile", `${label} does not resolve to its own registry tarball`);
      if (typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)) add("lockfile", `${label} has no sha512 integrity hash`);
    }
    const was = Object.hasOwn(before, key) ? before[key] : null;
    if (!was) added.push(label);
    else if (was.version !== entry.version || was.resolved !== entry.resolved || was.integrity !== entry.integrity) changed.push(label);
    if (entry.hasInstallScript && !Object.entries(before).some(([k, e]) => e?.hasInstallScript && k.split("node_modules/").pop() === name)) {
      add("install-script", `${label} runs a script at install time`);
    }
  }
  const removed = Object.keys(before).filter((key) => key !== "" && !Object.hasOwn(head.packages, key));
  const sample = (list) => list.slice(0, 12).join(", ") + (list.length > 12 ? `, and ${list.length - 12} more` : "");
  if (added.length > 0) add("dependencies", `${added.length} ${added.length === 1 ? "package" : "packages"} added: ${sample(added)}`);
  if (changed.length > 0) add("dependencies", `${changed.length} changed: ${sample(changed)}`);
  if (removed.length > 0) add("dependencies", `${removed.length} removed`);
  if (out.length === 0) add("dependencies", "lockfile metadata changed");
  return out;
}

// ---------- the pull request as git objects ----------

/** Paths the lock pins, plus the files that guard the lock itself. */
export function parseLock(text) {
  const paths = new Set(ALWAYS_LOCKED);
  for (const line of text.split("\n")) {
    const m = /^(?:sha256 [0-9a-f]{64}|gitlink [0-9a-f]{40})\s+(\S+)$/.exec(line);
    if (m) paths.add(m[1]);
  }
  return paths;
}

/** `git diff-tree -r -z` output to [{ status, path, oldMode, newMode, oldSha, newSha }]. */
export function parseRaw(raw) {
  const parts = raw.split("\0");
  const changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])/.exec(parts[i]);
    if (!m) throw new Error("unreadable diff entry");
    changes.push({ oldMode: m[1], newMode: m[2], oldSha: m[3], newSha: m[4], status: m[5], path: parts[i + 1] });
  }
  return changes;
}

/** A line without the carriage return a Windows line ending leaves behind. */
const stripCr = (line) => (line.endsWith("\r") ? line.slice(0, -1) : line);
/** A zero-context unified diff to { added: [{ n, text }], removed: [text] }. */
export function parseHunks(diff) {
  const added = [], removed = [];
  let n = 0, inHunk = false;
  for (const line of diff.split("\n")) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) { n = Number(m[1]); inHunk = true; }
    else if (!inHunk) continue;
    else if (line.startsWith("+")) added.push({ n: n++, text: stripCr(line.slice(1)) });
    else if (line.startsWith("-")) removed.push(stripCr(line.slice(1)));
  }
  return { added, removed };
}
/** Every line of a new file as an added line: [{ n, text }]. */
const allLines = (text) => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, i) => ({ n: i + 1, text: stripCr(line) }));
};

/** The pull request's own changes: merge base of `base` and `head` to `head`, read from the git objects in `cwd`. */
export function openRepo(cwd, base, head) {
  const git = (args, { literal = true, ...options } = {}) =>
    execFileSync("git", [...(literal ? ["--literal-pathspecs"] : []), "-c", "core.quotePath=false", ...args], {
      cwd, maxBuffer: 512 * 1024 * 1024, timeout: 120_000, stdio: ["pipe", "pipe", "pipe"], ...options,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
  const text = (args) => git(args).toString("utf8").trim();
  const headSha = text(["rev-parse", "--verify", "--quiet", `${head}^{commit}`]);
  const baseSha = text(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  // With more than one common ancestor the diff from any one of them is not what a merge does (analyze refuses that).
  const mergeBases = text(["merge-base", "--all", baseSha, headSha]).split("\n").filter(Boolean);
  const mergeBase = mergeBases[0];
  const changes = parseRaw(git(["diff-tree", "-r", "-z", "--no-renames", "--no-abbrev", mergeBase, headSha]).toString("utf8"));

  /**
   * Every match of an extended regex in the merge base's files. Submodule contents are not part of the tree, and package
   * lockfiles are left out: the hundreds of hosts they mention are not hosts this code talks to.
   */
  const baseMatches = (pattern) => {
    try {
      const where = [":(top)", ...["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"].map((name) => `:(top,exclude,glob)**/${name}`)];
      return git(["grep", "-I", "-h", "-o", "-i", "-E", pattern, mergeBase, "--", ...where], { literal: false }).toString("utf8").split("\n").filter(Boolean);
    } catch (error) {
      if (error.status === 1) return [];
      throw error;
    }
  };
  return {
    headSha, baseSha, mergeBase, mergeBases, changes, baseMatches,
    /** The file's bytes, or null when it is larger than the guard reads. */
    blob: (sha) => {
      try {
        return git(["cat-file", "blob", sha], { maxBuffer: MAX_BLOB_BYTES });
      } catch (error) {
        if (error.code === "ENOBUFS") return null;
        throw error;
      }
    },
    diff: (oldSha, newSha) => parseHunks(git(["diff", "-U0", "--text", "--no-color", "--no-ext-diff", "--no-textconv", oldSha, newSha]).toString("utf8")),
    baseText: (path) => {
      try {
        return git(["cat-file", "blob", `${mergeBase}:${path}`]).toString("utf8");
      } catch {
        return null;
      }
    },
    basePaths: () => git(["ls-tree", "-r", "-z", "--name-only", mergeBase]).toString("utf8").split("\0").filter(Boolean),
  };
}

/** A value computed on first use and kept: the base branch is only searched when a rule needs it. */
const lazy = (make) => {
  let value;
  return () => (value ??= make());
};

/** Every finding for the pull request. `lockedPaths` comes from the trusted checkout, never from the pull request. */
export function analyze(repo, { lockedPaths }) {
  const findings = [];
  const add = (rule, path, detail, line = null) => findings.push({ rule, tier: RULES[rule].tier, path, detail: scrub(detail), line });
  if ((repo.mergeBases?.length ?? 1) > 1) add("criss-cross", "(the branch's history)", `${repo.mergeBases.length} common ancestors with the base branch`);
  const facts = lazy(() => ({
    addresses: new Set(repo.baseMatches("0x[0-9a-f]{40,}").filter((hit) => hit.length === 42).map((hit) => hit.toLowerCase())),
    hosts: new Set(repo.baseMatches("(https?|wss?|ftp)://[]a-z0-9._~%:@[*-]+").map((hit) => hostOf(hit.replace(/^[a-z]+:\/\//i, ""))).filter(Boolean)),
    env: new Set(repo.baseMatches("(process\\.env|import\\.meta\\.env)(\\??\\.[a-z_][a-z0-9_]*|(\\?\\.)?\\[[^]]+\\])|[a-z_$]*env[a-z_$]*\\([[:space:]]*[\"'`][a-z_][a-z0-9_]*[\"'`]").flatMap((hit) => [...hit.matchAll(ENV_RE)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]))),
  }));
  /** lowercase path or folder -> its spelling in the base tree */
  const spellings = lazy(() => {
    const map = new Map();
    for (const path of repo.basePaths()) {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join("/");
        map.set(prefix.toLowerCase(), prefix);
      }
    }
    return map;
  });

  const locked = (path) => lockedPaths.has(path) || path.startsWith(LOCKED_FOLDER);

  /** Paths this pull request deletes, and the spellings of what it adds: lowercase path or folder -> as written. */
  const deleted = new Set(repo.changes.filter((change) => change.status === "D").map((change) => change.path));
  const addedSpellings = new Map();
  let scanned = 0;
  /** Code files this pull request deletes, and the checks its other files gain: a check that reappears was moved. */
  const deletedCode = [], gained = new Map();
  for (const change of repo.changes) {
    const { path, status, oldMode, newMode } = change;
    const gone = status === "D";

    if (hiddenCharacter(path) || /[\\\n\r\t]/.test(path) || path.split("/").includes("..")) add("odd-path", path, "the file name");
    else if (/[^\x20-\x7E]/.test(path)) add("odd-path", path, "the file name has characters outside plain ASCII");
    if (locked(path)) add("contract-locked", path, gone ? "deleted" : status === "A" ? "added" : "edited");
    if (oldMode === "160000" || newMode === "160000") add("submodule", path, gone ? "removed" : status === "A" ? "added" : "pinned to a different commit");
    if (newMode === "120000") add("symlink", path, "a symbolic link");
    for (const [rule, re] of BLOCK_PATHS) if (re.test(path)) add(rule, path, gone ? "deleted" : status === "A" ? "added" : "changed");
    if (!gone && SECRET_FILE.test(path)) add("secret-file", path, status === "A" ? "added" : "changed");
    // npm builds a package that has this file with node-gyp at install time, with no script in package.json at all
    if (!gone && /(^|\/)binding\.gyp$/i.test(path)) add("install-script", path, "npm runs node-gyp on this file at install time");
    let hiddenName = null;
    if (status === "A") {
      const parts = path.split("/");
      let collided = false;
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join("/"), lower = prefix.toLowerCase();
        // against the base branch and against what this pull request itself adds; a file renamed only in its case is one file
        const existing = spellings().get(lower) ?? addedSpellings.get(lower);
        if (existing && existing !== prefix && !(i === parts.length && deleted.has(existing))) { add("case-collision", path, `collides with ${existing}`); collided = true; break; }
        if (!addedSpellings.has(lower)) addedSpellings.set(lower, prefix);
      }
      // .gitignore and the empty files that keep a folder in git configure no tool
      if (!collided) hiddenName = parts.find((part, i) => part.startsWith(".") && !/^\.(gitignore|gitkeep|keep)$/.test(part) && !spellings().has(parts.slice(0, i + 1).join("/").toLowerCase())) ?? null;
    }
    if (!locked(path) && !BLOCK_PATHS.some(([, re]) => re.test(path))) {
      const match = REVIEW_PATHS.find(([, re]) => re.test(path));
      if (match) add(match[0], path, gone ? "deleted" : status === "A" ? "added" : "changed");
      else if (!gone && newMode === "100755" && oldMode !== "100755") add("build-deploy", path, "marked executable");
      // a new name that begins with a dot, where no rule above already refuses the file or sends it to an owner
      if (!match && hiddenName && !SECRET_FILE.test(path)) add("dot-file", path, `${hiddenName} is new`);
    }
    if (OTHER_LOCK.test(path) && !gone) add("dependencies", path, "a lockfile for another package manager");
    // a deletion is never read below, and it is a change to the dependencies all the same
    if (gone && MANIFEST.test(path)) add("dependencies", path, "deleted");
    if (gone && (NPM_LOCK.test(path) || OTHER_LOCK.test(path))) add("dependencies", path, "deleted, so nothing pins the packages it listed");

    if (gone && (oldMode === "100644" || oldMode === "100755") && isCode(path) && !isTest(path) && !NPM_LOCK.test(path) && !OTHER_LOCK.test(path)) deletedCode.push(change);
    if (gone || (newMode !== "100644" && newMode !== "100755")) continue;
    // A manifest, a lockfile or an SVG the guard could not check is refused, not handed on for review: failing to read
    // it must never rank below what reading it would have found.
    const wholeFileRule = MANIFEST.test(path) ? "dependency-source" : NPM_LOCK.test(path) ? "lockfile" : ext(path) === "svg" ? "svg-active" : null;
    let checked = !wholeFileRule;
    const unread = (why) => (checked ? add("unread", path, why) : add(wholeFileRule, path, `could not be checked: ${why}`));
    if (++scanned > MAX_SCAN_FILES) { unread(`more than ${MAX_SCAN_FILES} files in one pull request`); continue; }
    try {
      const bytes = repo.blob(change.newSha);
      if (!bytes) { unread(`larger than ${MAX_BLOB_BYTES / 1_000_000} MB`); continue; }
      const byteFindings = scanBytes(path, bytes);
      if (byteFindings) { for (const f of byteFindings) add(f.rule, f.path, f.detail, f.line); continue; }

      // dependency files and SVGs are read whole whatever their size; the limit below is on what is matched line by line
      if (MANIFEST.test(path)) for (const f of lintManifest(path, bytes.toString("utf8"), repo.baseText(path))) add(f.rule, f.path, f.detail);
      if (NPM_LOCK.test(path)) {
        for (const f of lintNpmLock(path, bytes.toString("utf8"), repo.baseText(path))) add(f.rule, f.path, f.detail);
      }
      const active = ext(path) === "svg" ? activeSvg(bytes.toString("utf8")) : null;
      if (active) add("svg-active", path, active);
      checked = true;
      const lines = status === "A" || /^0+$/.test(change.oldSha) || oldMode === "160000" || oldMode === "120000"
        ? { added: allLines(bytes.toString("utf8")), removed: [] }
        : repo.diff(change.oldSha, change.newSha);
      // A lockfile (thousands of registry addresses and hashes; its structure was checked above) and a file too large to
      // match line by line are still read for what is blocked for everyone: credentials and hidden characters.
      const lockfile = NPM_LOCK.test(path), large = bytes.length > MAX_TEXT_BYTES;
      if (lockfile || large) {
        const plainLines = lockfile ? lines.added.map((l) => ({ n: l.n, text: l.text.replace(/"(?:integrity|resolved)":\s*"[^"]*"/g, "") })) : lines.added;
        const blocking = scanLines(path, plainLines, [], facts(), true);
        for (const f of blocking.slice(0, MAX_FINDINGS_PER_FILE)) add(f.rule, f.path, f.detail, f.line);
        if (blocking.length > MAX_FINDINGS_PER_FILE) add("unscanned", path, `${blocking.length - MAX_FINDINGS_PER_FILE} more findings in this file are not listed`);
        if (!lockfile) add("unscanned", path, `a text file of ${Math.ceil(bytes.length / 1_000_000)} MB, read for credentials and hidden characters only`);
        continue;
      }
      const found = scanLines(path, lines.added, lines.removed, facts());
      if (isCode(path) && !isTest(path)) {
        const lost = checksIn(lines.removed);
        for (const [name, count] of checksIn(lines.added.map((l) => l.text))) {
          const net = count - (lost.get(name) ?? 0);
          if (net > 0) gained.set(name, (gained.get(name) ?? 0) + net);
        }
      }
      // blocks first, so a flood of minor findings cannot push one off the end
      found.sort((a, b) => (RULES[a.rule].tier === "block" ? 0 : 1) - (RULES[b.rule].tier === "block" ? 0 : 1));
      for (const f of found.slice(0, MAX_FINDINGS_PER_FILE)) add(f.rule, f.path, f.detail, f.line);
      if (found.length > MAX_FINDINGS_PER_FILE) add("unscanned", path, `${found.length - MAX_FINDINGS_PER_FILE} more findings in this file are not listed`);
    } catch (error) {
      unread(`could not be read (${error.code ?? error.status ?? "error"})`);
    }
  }

  // A deleted file is never read above, and it takes its security checks with it. One that turns up again in what the
  // pull request adds elsewhere was moved, not removed.
  for (const { path, oldSha } of deletedCode) {
    if (++scanned > MAX_SCAN_FILES) { add("unscanned", path, `deleted, past the ${MAX_SCAN_FILES} files one pull request may have read`); continue; }
    try {
      const bytes = repo.blob(oldSha);
      if (!bytes || bytes.length > MAX_TEXT_BYTES) { add("unscanned", path, "deleted, and too large to read for the checks it held"); continue; }
      if (scanBytes(path, bytes)) continue;
      for (const [name, held] of checksIn(bytes.toString("utf8").split("\n"))) {
        const moved = Math.min(held, gained.get(name) ?? 0);
        gained.set(name, (gained.get(name) ?? 0) - moved);
        if (held > moved) add("auth-removed", path, `${name}: ${held - moved} fewer ${held - moved === 1 ? "use" : "uses"}, with the file deleted`);
      }
    } catch (error) {
      add("unscanned", path, `deleted, and could not be read (${error.code ?? error.status ?? "error"})`);
    }
  }
  return findings;
}

// ---------- verdict ----------

/** The owner who approved exactly `headSha`, or null. Each owner's latest verdict counts; a comment is not a verdict. */
export function ownerApproval(reviews, owners, headSha) {
  const latest = new Map();
  const ordered = [...reviews].sort((a, b) => String(a.submitted_at ?? "").localeCompare(String(b.submitted_at ?? "")) || (a.id ?? 0) - (b.id ?? 0));
  for (const review of ordered) {
    const login = String(review.user?.login ?? "").toLowerCase();
    if (!owners.includes(login) || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) continue;
    latest.set(login, review);
  }
  for (const [login, review] of latest) if (review.state === "APPROVED" && review.commit_id === headSha) return login;
  return null;
}

/**
 * Who pushed `headSha` to the pull request's branch, from the branch's activity log (newest first), or null when the log
 * does not list that push. Creating the branch, a force push and a merge into the branch all count as pushing it.
 */
export function pusherOf(activity, headSha) {
  const push = Array.isArray(activity) ? activity.find((entry) => entry?.after === headSha) : null;
  return push?.actor?.login ?? null;
}

/**
 * pass / review / block. An owner's own pull request, at a head commit an owner pushed, turns "review" findings into
 * notices; so does an owner's approval of the exact head commit. Nothing turns a "block" into a pass.
 *
 * `pusher` is whoever pushed the head commit, which is not always whoever started the run: reopening a pull request, or
 * opening one from a branch someone else pushed, does not make the commit the owner's.
 */
export function verdict(findings, { author, pusher, approvedBy, owners = OWNERS }) {
  const is = (login) => owners.includes(String(login ?? "").toLowerCase());
  const blocks = findings.filter((f) => f.tier === "block").length;
  const reviews = findings.filter((f) => f.tier === "review").length;
  const byOwner = is(author);
  const ownPr = byOwner && is(pusher);
  if (blocks > 0) return { outcome: "block", ok: false, blocks, reviews, byOwner, ownPr, approvedBy: null };
  if (reviews > 0 && !ownPr && !approvedBy) return { outcome: "review", ok: false, blocks, reviews, byOwner, ownPr, approvedBy: null };
  return { outcome: "pass", ok: true, blocks, reviews, byOwner, ownPr, approvedBy: reviews > 0 && !ownPr ? approvedBy : null };
}

// ---------- report ----------

/** Untrusted text made safe to print: one line, no control characters, bounded. */
export const plain = (value, max = 200) => {
  const text = String(value).replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ").replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "?");
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
/**
 * Untrusted text for the job log. The runner reads "::command::" at the start of a line (after any spaces) and
 * "##[command]" anywhere in one, so the second is broken up here and the first by never starting a line with such text.
 */
const logged = (value, max) => plain(value, max).replace(/##\[/g, "# #[");
/** Untrusted text as a Markdown code span, where nothing in it is read as Markdown, HTML or a link. */
const code = (value) => `\`${plain(value).replace(/`/g, "'") || " "}\``;
/** A workflow command with its data and properties escaped, so file names and details cannot start a command of their own. */
export function annotation(level, { path, line, title }, message) {
  const data = (s) => plain(s, 400).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const property = (s) => data(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
  const properties = [`title=${property(title)}`];
  if (path && /^[\w@./+ -]+$/.test(path)) properties.push(`file=${property(path)}`, ...(line ? [`line=${line}`] : []));
  return `::${level} ${properties.join(",")}::${data(message)}`;
}

/** [[rule, [[path, [finding…]]…]]…] in rule order. */
function grouped(findings, tier) {
  const byRule = new Map();
  for (const f of findings) {
    if (f.tier !== tier) continue;
    if (!byRule.has(f.rule)) byRule.set(f.rule, new Map());
    const byPath = byRule.get(f.rule);
    if (!byPath.has(f.path)) byPath.set(f.path, []);
    byPath.get(f.path).push(f);
  }
  return Object.keys(RULES).filter((rule) => byRule.has(rule)).map((rule) => [rule, [...byRule.get(rule)]]);
}
/**
 * One file's findings on one line: each distinct detail once, with the lines it was found on. `show` makes a detail safe
 * for where the line is printed. Details carry text from the pull request (a dependency's name, a script's name, a host).
 */
const describe = (list, show) => {
  const seen = new Map();
  for (const f of list) {
    if (!seen.has(f.detail)) seen.set(f.detail, []);
    if (f.line) seen.get(f.detail).push(f.line);
  }
  const parts = [...seen].slice(0, 6).map(([detail, lines]) => {
    const where = lines.length === 0 ? "" : ` (line ${lines.slice(0, 4).join(", ")}${lines.length > 4 ? `, +${lines.length - 4}` : ""})`;
    return `${show(detail)}${where}`;
  });
  return parts.join("; ") + (seen.size > 6 ? `; and ${seen.size - 6} more` : "");
};

/** The job summary, in Markdown: the verdict, what to do next, and the findings by rule. */
export function renderSummary(findings, result, { headSha, owners = OWNERS, note = "" }) {
  const short = headSha.slice(0, 7);
  const names = owners.map((login) => `@${login}`).join(" or ");
  const out = [];
  if (result.outcome === "block") {
    out.push("## pr-guard: blocked", "", `${result.blocks} blocking ${result.blocks === 1 ? "finding" : "findings"} at \`${short}\`. These are refused for everyone. Take the change out of the pull request, or a repository admin merges it with an explicit bypass after reading it.`);
  } else if (result.outcome === "review") {
    out.push("## pr-guard: needs an owner's approval", "", `Nothing is blocked, and ${result.reviews} sensitive ${result.reviews === 1 ? "change needs" : "changes need"} a look from ${names}.`, "");
    // an author cannot approve their own pull request on GitHub, so an owner's has a second way through
    if (result.byOwner) out.push(`This is an owner's pull request, but commit \`${short}\` does not count as an owner's push. **To pass:** an owner reads the points below and pushes the next commit to the branch, or another owner approves commit \`${short}\` with a pull request review and re-runs this job.`);
    else out.push(`**To pass:** ${names} reads the points below, approves commit \`${short}\` with a pull request review, then re-runs this job. A new push needs a new approval.`);
  } else if (result.reviews > 0) {
    out.push("## pr-guard: passed", "", result.approvedBy ? `@${result.approvedBy} approved commit \`${short}\`. The sensitive changes are listed below for the record.` : `An owner's own pull request, and an owner pushed \`${short}\`. The sensitive changes are listed below as notices.`);
  } else {
    out.push("## pr-guard: passed", "", `Nothing blocked and nothing sensitive at \`${short}\`.`);
  }
  if (note) out.push("", `> ${plain(note, 600)}`);
  let budget = 400;
  for (const [tier, heading] of [["block", "Blocked"], ["review", result.ok ? "Sensitive changes" : "Needs an owner's approval"]]) {
    const groups = grouped(findings, tier);
    if (groups.length === 0) continue;
    out.push("", `### ${heading}`);
    for (const [rule, paths] of groups) {
      out.push("", `**${RULES[rule].title}** (\`${rule}\`)  `, RULES[rule].help, "");
      for (const [path, list] of paths) {
        if (--budget < 0) break;
        out.push(`- ${code(path)}: ${describe(list, code)}`);
      }
      if (budget < 0) out.push("- and more; the list is cut here");
    }
  }
  return `${out.join("\n")}\n`;
}

/** The same verdict and findings as plain text, for the job log and a local run. */
export function renderText(findings, result) {
  const out = [`pr-guard: ${result.outcome}  (${result.blocks} blocking, ${result.reviews} for review)`];
  if (result.outcome === "review" && result.byOwner) out.push("  an owner's pull request, held because the head commit does not count as an owner's push");
  for (const tier of ["block", "review"]) {
    for (const [rule, paths] of grouped(findings, tier)) {
      out.push(`  [${tier}] ${rule}: ${RULES[rule].title}`);
      for (const [path, list] of paths) out.push(`      - ${logged(path)}: ${describe(list, logged)}`);
    }
  }
  return out.join("\n");
}

// ---------- entry point ----------

/**
 * GET a GitHub API path as JSON, with the job's read-only token when there is one. A failure is one of a few fixed
 * reasons, so nothing the API sent back ends up in the report.
 */
async function getJson(env, path) {
  let response;
  try {
    response = await fetch(`${env.GITHUB_API_URL ?? "https://api.github.com"}${path}`, {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(error?.name === "TimeoutError" ? "no answer in 30 seconds" : "no answer");
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error("the answer was not JSON");
  }
}

/** Every review on the pull request, oldest first. */
async function fetchReviews(env) {
  const reviews = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await getJson(env, `/repos/${env.GITHUB_REPOSITORY}/pulls/${env.PR_NUMBER}/reviews?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("the answer was not a list");
    reviews.push(...batch);
    if (batch.length < 100) return reviews;
  }
  throw new Error("more than 2000 reviews");
}

/** Who pushed `headSha` to the pull request's branch. Throws, with the reason, when GitHub cannot say. */
async function fetchPusher(env, headSha) {
  const pr = await getJson(env, `/repos/${env.GITHUB_REPOSITORY}/pulls/${env.PR_NUMBER}`);
  if (pr?.head?.sha !== headSha) throw new Error("the pull request's head is now another commit");
  const branch = pr.head.ref, source = pr.head.repo?.full_name;
  if (typeof branch !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(source ?? "")) throw new Error("the pull request's branch is gone");
  const pusher = pusherOf(await getJson(env, `/repos/${source}/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&per_page=100`), headSha);
  if (!pusher) throw new Error("the branch's activity log does not list that push");
  return pusher;
}

/** Read the pull request, ask GitHub what the rules cannot see, print the report. Returns the exit code. */
async function main(argv, env) {
  const flag = (name) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
  const cwd = resolve(flag("repo") ?? ".");
  const head = flag("head") ?? env.GUARD_HEAD;
  const base = flag("base") ?? env.GUARD_BASE ?? "HEAD";
  if (!head) throw new Error("no head commit: pass --head or set GUARD_HEAD");
  const author = flag("author") ?? env.PR_AUTHOR ?? "";
  const isOwner = (login) => OWNERS.includes(String(login ?? "").toLowerCase());

  // the lock is read from this checkout (main's copy in CI), never from the pull request
  const lockedPaths = parseLock(readFileSync(resolve(flag("lock") ?? LOCK_PATH), "utf8"));
  if (lockedPaths.size <= ALWAYS_LOCKED.length) throw new Error(`${LOCK_PATH} lists no deployed files`);

  const repo = openRepo(cwd, base, head);
  const findings = analyze(repo, { lockedPaths });
  const short = repo.headSha.slice(0, 7);
  const notes = [];
  const needsApproval = findings.some((f) => f.tier === "review") && !findings.some((f) => f.tier === "block");
  const onGitHub = Boolean(env.PR_NUMBER && env.GITHUB_REPOSITORY);

  // Who pushed the head commit. A local replay reads the branch as its author's own. In Actions nothing is assumed: a
  // push event names the pusher of the commit it left as the head, and for anything else (opened, reopened, a head that
  // has moved past that push) the branch's activity log is asked.
  let pusher = flag("pusher") ?? (env.GITHUB_ACTIONS ? "" : author);
  if (flag("pusher") === undefined && env.GITHUB_ACTIONS && needsApproval && isOwner(author)) {
    if (env.EVENT_ACTION === "synchronize" && env.EVENT_AFTER === repo.headSha) pusher = env.EVENT_SENDER ?? "";
    else {
      try {
        if (!onGitHub) throw new Error("this run has no pull request to ask about");
        pusher = await fetchPusher(env, repo.headSha);
      } catch (error) {
        notes.push(`Could not confirm who pushed ${short} (${error.message}), so it is not counted as an owner's push. Re-run this job to ask again.`);
      }
    }
  }

  let approvedBy = argv.includes("--approved") ? OWNERS[0] : null;
  if (needsApproval && !approvedBy && onGitHub && !(isOwner(author) && isOwner(pusher))) {
    try {
      approvedBy = ownerApproval(await fetchReviews(env), OWNERS, repo.headSha);
    } catch (error) {
      notes.push(`Could not read the pull request's reviews (${error.message}), so no approval was counted. Re-run this job.`);
    }
  }
  const result = verdict(findings, { author, pusher, approvedBy });
  const note = notes.join(" ");

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ result, notes, findings }, null, 1));
    return result.ok ? 0 : 1;
  }
  console.log(renderText(findings, result));
  if (note) console.log(`  note: ${logged(note, 600)}`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary(findings, result, { headSha: repo.headSha, note }));
  if (env.GITHUB_ACTIONS) {
    const level = { block: "error", review: result.ok ? "notice" : "warning" };
    for (const tier of ["block", "review"]) {
      for (const f of findings.filter((f) => f.tier === tier).slice(0, 10)) {
        console.log(annotation(level[tier], { path: f.path, line: f.line, title: `pr-guard: ${RULES[f.rule].title}` }, `${f.path}: ${f.detail}`));
      }
    }
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Any failure of the guard itself is a failed check, never a pass. The exit code is set rather than forced, so a report
  // still on its way into a pipe is written in full before the process ends.
  main(process.argv.slice(2), process.env).then(
    (exit) => { process.exitCode = exit; },
    (error) => {
      console.log(`pr-guard could not finish, so the check fails: ${logged(error?.message ?? error, 300)}`);
      process.exitCode = 1;
    },
  );
}
