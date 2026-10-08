"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useConfig } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { ArrowUpRight, Check, Copy } from "lucide-react";
import Sheet from "@/components/Sheet";
import { btn, helper, input, label } from "@/components/ui";
import ImageUpload from "@/components/launchpad/ImageUpload";
import { XMark } from "@/components/launchpad/BrandMarks";
import { CHAINS, DEFAULT_CHAIN, type ChainKey } from "@/lib/chainPublic";
import { friendlyError } from "@/lib/errors";
import { buildProfileMessage } from "@/lib/profiles/auth";
import { BIO_MAX, DISPLAY_NAME_MAX, USERNAME_MAX, validateProfile } from "@/lib/profiles/validate";
import { forgetCachedName } from "@/lib/profiles/names-client";
import type { PublicProfile, XCodeView } from "@/lib/profiles/server";

/** The localStorage key that remembers this wallet's open X code in this browser. */
const codeKey = (w: string) => `ol:xcode:${w.toLowerCase()}`;

/** The open X code for this wallet, remembered in this browser only (a convenience: saving again issues a new one). */
export function loadCode(wallet: string): XCodeView | null {
  try {
    const raw = localStorage.getItem(codeKey(wallet));
    if (!raw) return null;
    const c = JSON.parse(raw) as XCodeView;
    // a code saved before verify keys existed cannot verify: saving again issues both
    return c && typeof c.code === "string" && typeof c.secret === "string" && Date.parse(c.expires_at) > Date.now() ? c : null;
  } catch {
    return null;
  }
}
/** Remember (or forget) the open X code for this wallet in this browser; private mode just does not remember. */
function storeCode(wallet: string, c: XCodeView | null) {
  try {
    if (c) localStorage.setItem(codeKey(wallet), JSON.stringify(c));
    else localStorage.removeItem(codeKey(wallet));
  } catch {
    /* private mode: the code just isn't remembered */
  }
}

/** A random single-use nonce for the profile signature (32 hex characters). */
function nonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** The chain key the connected wallet is on, or the default chain when it is on one we do not support. */
function chainKeyOf(id: number | undefined): ChainKey {
  const hit = (Object.keys(CHAINS) as ChainKey[]).find((k) => CHAINS[k].id === id);
  return hit ?? DEFAULT_CHAIN;
}

type Form = { username: string; display_name: string; bio: string; avatar: string; x_handle: string };

/**
 * Create or edit the public profile, then verify it with one post on X. Saving asks the wallet for one free
 * signature (no transaction); with an X handle the reply carries a one-time code bound to this wallet and that
 * handle. The post itself earns nothing; it only proves the account is yours.
 */
export default function ProfileSheet({ address, initial, startOnVerify = false, onClose, onSaved }: { address: string; initial: PublicProfile | null; startOnVerify?: boolean; onClose: () => void; onSaved: (p: PublicProfile) => void }) {
  const config = useConfig();
  const { chainId } = useAccount();
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const [f, setF] = useState<Form>({
    username: initial?.username ?? "",
    display_name: initial?.display_name ?? "",
    bio: initial?.bio ?? "",
    avatar: initial?.avatar_url ? `${origin}${initial.avatar_url}` : "",
    // a verified handle is public; an unverified claim (x_state "none" until a post is submitted) is known only to this
    // browser, from the code it was given. Every save rewrites or clears that code, so it always matches the claim.
    x_handle: initial?.x?.handle ?? (initial ? (loadCode(address)?.handle ?? "") : ""),
  });
  const [profile, setProfile] = useState<PublicProfile | null>(initial);
  const [code, setCode] = useState<XCodeView | null>(() => (startOnVerify ? loadCode(address) : null));
  const [step, setStep] = useState<"form" | "verify">(startOnVerify && loadCode(address) ? "verify" : "form");
  const [phase, setPhase] = useState<"idle" | "sign" | "save" | "check">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [avail, setAvail] = useState<{ name: string; ok: boolean; error?: string } | null>(null);
  const [postUrl, setPostUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const v = validateProfile({ username: f.username, display_name: f.display_name, bio: f.bio, avatar: f.avatar, x_handle: f.x_handle });
  const busy = phase !== "idle";

  // username availability, debounced (the save checks again for real)
  const wanted = f.username.trim().replace(/^@/, "").toLowerCase();
  const seq = useRef(0);
  useEffect(() => {
    if (!wanted || wanted === initial?.username) return;
    const n = ++seq.current;
    const id = setTimeout(async () => {
      try {
        const r = await fetch(`/api/profile/check?username=${encodeURIComponent(wanted)}&wallet=${address}`, { cache: "no-store" });
        if (!r.ok) return; // the check could not run (or was rate limited): say nothing, the save checks for real
        const d = (await r.json()) as { available?: boolean; error?: string };
        if (n === seq.current) setAvail({ name: wanted, ok: Boolean(d.available), error: d.error });
      } catch {
        /* the save will tell */
      }
    }, 350);
    return () => clearTimeout(id);
  }, [wanted, address, initial?.username]);
  const nameState = !wanted || wanted === initial?.username ? null : avail && avail.name === wanted ? avail : null;

  async function save() {
    if (!v.ok) return;
    setErr(null);
    setNote(null);
    try {
      setPhase("sign");
      const chain = chainKeyOf(chainId);
      const n = nonce();
      const ts = Date.now();
      const wallet = await getWalletClient(config);
      const signature = await wallet.signMessage({ message: buildProfileMessage({ wallet: address, nonce: n, ts, fields: v.value }) });
      setPhase("save");
      const r = await fetch("/api/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chain, wallet: address, nonce: n, ts, signature, fields: { username: v.value.username, display_name: v.value.display_name, bio: v.value.bio, avatar: v.value.avatar_key ?? "", x_handle: v.value.x_handle } }) });
      const d = (await r.json()) as { ok?: boolean; error?: string; profile?: PublicProfile; code?: XCodeView | null };
      if (!r.ok || !d.ok || !d.profile) throw new Error(d.error ?? "could not save");
      setProfile(d.profile);
      forgetCachedName(address);
      onSaved(d.profile);
      storeCode(address, d.code ?? null);
      if (d.code) {
        setCode(d.code);
        setStep("verify");
      } else {
        onClose();
      }
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setPhase("idle");
    }
  }

  async function verify() {
    setErr(null);
    setNote(null);
    setPhase("check");
    try {
      const r = await fetch("/api/profile/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: address, code: code?.code, secret: code?.secret, postUrl }) });
      const d = (await r.json()) as { ok?: boolean; error?: string; status?: string; profile?: PublicProfile | null };
      if (!r.ok || !d.ok) throw new Error(d.error ?? "could not verify");
      if (d.profile) {
        setProfile(d.profile);
        onSaved(d.profile);
      }
      forgetCachedName(address);
      if (d.status === "verified") {
        storeCode(address, null);
        setNote("Verified. The ✓ now shows next to your name.");
        setTimeout(onClose, 1200);
      } else {
        setNote("X did not answer us right now, so a person will check your post. Your ✓ appears once it is approved.");
      }
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setPhase("idle");
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* select-and-copy still works */
    }
  }

  if (step === "verify" && code) {
    return (
      <Sheet title="Verify with X" onClose={onClose}>
        <div className="space-y-4">
          <p className="text-sm text-body text-pretty">Post this from <strong className="text-ink">@{code.handle}</strong>, then paste the link to your post. The post proves the account is yours; it does not earn anything by itself.</p>
          <div className="rounded-xl border border-line bg-paper p-4">
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-ink">{code.text}</pre>
            <div className="mt-3 flex flex-wrap gap-2">
              <a href={code.intent} target="_blank" rel="noopener noreferrer" className={btn.primarySm}><XMark />Post on X<ArrowUpRight size={13} aria-hidden="true" /></a>
              <button type="button" className={btn.secondarySm} onClick={() => void copy(code.text)}>{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied ? "Copied" : "Copy text"}</button>
            </div>
          </div>
          <div>
            <label className={label} htmlFor="p-post">Link to your post</label>
            <input id="p-post" className={input} inputMode="url" autoComplete="off" placeholder={`https://x.com/${code.handle}/status/…`} value={postUrl} onChange={(e) => setPostUrl(e.target.value)} />
            <p className={helper}>Code {code.code} · valid until {new Date(code.expires_at).toLocaleString()}</p>
          </div>
          {err ? <p className="text-sm text-down-ink" role="alert">{err}</p> : null}
          {note ? <p className="text-sm text-up" role="status">{note}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" className="text-xs text-muted underline underline-offset-4 hover:text-ink" onClick={() => setStep("form")}>Back to profile</button>
            <button type="button" className={btn.primary} disabled={busy || !postUrl.trim()} onClick={() => void verify()}>{phase === "check" ? "Checking your post…" : "Verify"}</button>
          </div>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title={profile ? "Edit profile" : "Create your profile"} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-muted text-pretty">Your username shows next to your trades, posts and launches. Saving asks your wallet for a free signature, no transaction.</p>
        <div>
          <label className={label} htmlFor="p-user">Username</label>
          <input id="p-user" className={input} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={USERNAME_MAX + 1} placeholder="yourname" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.replace(/\s/g, "") })} />
          <p className={helper} aria-live="polite">{nameState ? (nameState.ok ? "Available" : nameState.error ?? "Taken") : "3–20 letters, numbers or _. You can change it once every 30 days."}</p>
        </div>
        <div>
          <label className={label} htmlFor="p-name">Name</label>
          <input id="p-name" className={input} autoComplete="nickname" maxLength={DISPLAY_NAME_MAX * 2} placeholder="How people know you" value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} />
        </div>
        <div>
          <label className={label} htmlFor="p-x">X account <span className="font-normal text-muted">(optional, for the ✓)</span></label>
          <input id="p-x" className={input} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="@yourhandle" value={f.x_handle} onChange={(e) => setF({ ...f, x_handle: e.target.value })} />
          <p className={helper}>{profile && profile.x_state !== "none" && profile.x_state !== "verified" && !f.x_handle ? "Your X claim is waiting: enter the handle again to keep it, or leave it empty to drop it." : "After saving you post a short code from this account. The handle stays hidden until it is verified."}</p>
        </div>
        <div>
          <span className={label}>Picture <span className="font-normal text-muted">(optional)</span></span>
          <ImageUpload value={f.avatar} onChange={(url) => setF({ ...f, avatar: url })} wallet={address} compact />
        </div>
        <div>
          <label className={label} htmlFor="p-bio">Bio <span className="font-normal text-muted">(optional)</span></label>
          <textarea id="p-bio" className={`${input} h-auto min-h-20 py-3`} maxLength={BIO_MAX + 40} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} />
          <p className={helper}>{BIO_MAX - [...f.bio].length} left</p>
        </div>
        {!v.ok && f.username ? <p className="text-sm text-muted">{v.error}</p> : null}
        {err ? <p className="text-sm text-down-ink" role="alert">{err}</p> : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {profile && profile.x_state !== "verified" && loadCode(address) ? <button type="button" className={btn.secondary} onClick={() => { setCode(loadCode(address)); setStep("verify"); }}>I already have a code</button> : null}
          <button type="button" className={btn.primary} disabled={busy || !v.ok || (nameState !== null && !nameState.ok)} onClick={() => void save()}>{phase === "sign" ? "Sign in your wallet…" : phase === "save" ? "Saving…" : f.x_handle && profile?.x_state !== "verified" ? "Save and verify with X" : "Save profile"}</button>
        </div>
      </div>
    </Sheet>
  );
}
