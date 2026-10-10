export type PendingSolanaAction = {
  version: 1;
  programId: string;
  cluster: string;
  wallet: string;
  signature: string;
  lastValidBlockHeight: number;
  label: string;
  pool: string | null;
};

export function journalKey(programId: string, cluster: string, wallet: string) {
  return `openlaunch:solana:v1:${cluster}:${programId}:${wallet}`;
}
/** A new connection to the same address is still a different signing session. */
export type ActionContext = { key: string; session: object | null };
export function sameActionContext(
  expected: ActionContext,
  current: ActionContext,
): boolean {
  return expected.key === current.key && expected.session === current.session;
}
/** Per-view identity is intentionally separate from wallet-keyed recovery. */
export type ReviewScope = { value: string };
export function sameReviewScope(
  expected: ReviewScope,
  current: ReviewScope | null,
): boolean {
  // Identity, not just text: A -> B -> A must not revive the first A's request.
  return expected === current;
}
function base58Bytes(value: string, size: number): boolean {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (!value || value.length > 88 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value))
    return false;
  let number = 0n;
  for (const char of value)
    number = number * 58n + BigInt(alphabet.indexOf(char));
  let length = 0;
  while (number > 0n) {
    length++;
    number >>= 8n;
  }
  for (const char of value) {
    if (char !== "1") break;
    length++;
  }
  return length === size;
}
export function readJournal(
  raw: string | null,
  programId: string,
  cluster: string,
  wallet: string,
): PendingSolanaAction | null {
  if (!raw || raw.length > 4096) return null;
  try {
    const item: unknown = JSON.parse(raw);
    if (!item || typeof item !== "object") return null;
    const p = item as Partial<PendingSolanaAction>;
    if (
      p.version !== 1 ||
      p.programId !== programId ||
      p.cluster !== cluster ||
      p.wallet !== wallet ||
      typeof p.signature !== "string" ||
      !base58Bytes(p.signature, 64) ||
      !Number.isSafeInteger(p.lastValidBlockHeight) ||
      (p.lastValidBlockHeight ?? 0) <= 0 ||
      typeof p.label !== "string" ||
      !p.label.trim() ||
      p.label.length > 100 ||
      /\p{Cc}/u.test(p.label) ||
      !(
        p.pool === null ||
        (typeof p.pool === "string" && base58Bytes(p.pool, 32))
      )
    )
      return null;
    return p as PendingSolanaAction;
  } catch {
    return null;
  }
}

export function samePendingAction(
  a: PendingSolanaAction | null,
  b: PendingSolanaAction,
): boolean {
  return Boolean(
    a &&
      a.version === b.version &&
      a.programId === b.programId &&
      a.cluster === b.cluster &&
      a.wallet === b.wallet &&
      a.signature === b.signature &&
      a.lastValidBlockHeight === b.lastValidBlockHeight &&
      a.label === b.label &&
      a.pool === b.pool,
  );
}

/** Call while holding the journal's Web Lock. Never delete a newer action after a stale RPC response. */
export function clearJournalIfCurrent(
  storage: Pick<Storage, "getItem" | "removeItem">,
  key: string,
  expected: PendingSolanaAction,
): boolean {
  const current = readJournal(
    storage.getItem(key),
    expected.programId,
    expected.cluster,
    expected.wallet,
  );
  if (!samePendingAction(current, expected)) return false;
  storage.removeItem(key);
  return true;
}

/** Hold the journal Web Lock and call synchronously immediately before broadcast. */
export function persistJournalForSession(
  storage: Pick<Storage, "getItem" | "setItem">,
  key: string,
  record: PendingSolanaAction,
  isCurrent: () => boolean,
): void {
  if (!isCurrent())
    throw new Error("Wallet changed while signing. Nothing was broadcast.");
  storage.setItem(key, JSON.stringify(record));
  if (
    !samePendingAction(
      readJournal(
        storage.getItem(key),
        record.programId,
        record.cluster,
        record.wallet,
      ),
      record,
    )
  )
    throw new Error(
      "Could not persist transaction recovery. Nothing was broadcast.",
    );
  if (!isCurrent())
    throw new Error(
      "Wallet changed before broadcast. The signed transaction is retained for status checks.",
    );
}
