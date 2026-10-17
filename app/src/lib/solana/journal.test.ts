import assert from "node:assert/strict";
import test from "node:test";
import {
  clearJournalIfCurrent,
  journalKey,
  persistJournalForSession,
  readJournal,
  sameActionContext,
  samePendingAction,
  sameReviewScope,
  type PendingSolanaAction,
} from "./journal.ts";

const record: PendingSolanaAction = {
  version: 1,
  programId: "BPFLoaderUpgradeab1e11111111111111111111111",
  cluster: "devnet",
  wallet: "11111111111111111111111111111111",
  signature: "1".repeat(64),
  lastValidBlockHeight: 100,
  label: "Buy tokens",
  pool: "11111111111111111111111111111111",
};
const key = journalKey(record.programId, record.cluster, record.wallet);
const read = (value: unknown) =>
  readJournal(
    JSON.stringify(value),
    record.programId,
    record.cluster,
    record.wallet,
  );

test("journal is bound to program, cluster and case-sensitive wallet identity", () => {
  assert.deepEqual(read(record), record);
  for (const field of ["programId", "cluster", "wallet"] as const)
    assert.equal(read({ ...record, [field]: `${record[field]}x` }), null);
  assert.equal(read({ ...record, lastValidBlockHeight: 0 }), null);
  assert.equal(
    read({ ...record, lastValidBlockHeight: Number.MAX_SAFE_INTEGER + 1 }),
    null,
  );
  assert.equal(read({ ...record, label: "\nBuy" }), null);
  assert.equal(
    read({ ...record, signature: "z".repeat(88) }),
    null,
    "regex-shaped text is not necessarily 64 decoded bytes",
  );
  assert.equal(
    read({ ...record, pool: "z".repeat(44) }),
    null,
    "pool must decode to exactly 32 bytes",
  );
  assert.equal(
    readJournal(
      " ".repeat(4097),
      record.programId,
      record.cluster,
      record.wallet,
    ),
    null,
  );
  assert.equal(
    readJournal("broken", record.programId, record.cluster, record.wallet),
    null,
  );
});
test("new wallet or reconnect cannot inherit ready state from the old session", () => {
  const walletA = {};
  const walletB = {};
  assert.equal(
    sameActionContext({ key, session: walletA }, { key, session: walletA }),
    true,
  );
  assert.equal(
    sameActionContext(
      { key, session: walletA },
      { key: `${key}:another-wallet`, session: walletB },
    ),
    false,
  );
  assert.equal(
    sameActionContext({ key, session: walletA }, { key, session: walletB }),
    false,
    "same address reconnect still requires hydration",
  );
  assert.equal(
    sameActionContext({ key, session: walletA }, { key, session: null }),
    false,
  );
});
test("stale confirmation never removes a newer transaction journal", () => {
  const next = { ...record, signature: "1".repeat(63) + "2" };
  let raw: string | null = JSON.stringify(next);
  let removals = 0;
  const storage = {
    getItem: (target: string) => {
      assert.equal(target, key);
      return raw;
    },
    removeItem: (target: string) => {
      assert.equal(target, key);
      raw = null;
      removals++;
    },
  };
  assert.equal(clearJournalIfCurrent(storage, key, record), false);
  assert.equal(removals, 0);
  assert.equal(raw, JSON.stringify(next));
  assert.equal(clearJournalIfCurrent(storage, key, next), true);
  assert.equal(removals, 1);
  assert.equal(raw, null);
  assert.equal(clearJournalIfCurrent(storage, key, next), false);
});
test("same signature cannot hide changed expiry or recovery metadata", () => {
  assert.equal(samePendingAction(record, { ...record }), true);
  assert.equal(
    samePendingAction(record, { ...record, lastValidBlockHeight: 101 }),
    false,
  );
  assert.equal(samePendingAction(record, { ...record, pool: null }), false);
  assert.equal(samePendingAction(null, record), false);
});

test("post-sign wallet invalidation and failed persistence stop the broadcast boundary", () => {
  let raw: string | null = null;
  let writes = 0;
  const storage = {
    getItem: () => raw,
    setItem: (_key: string, value: string) => {
      writes++;
      raw = value;
    },
  };
  assert.throws(
    () => persistJournalForSession(storage, key, record, () => false),
    /Wallet changed/,
  );
  assert.equal(writes, 0);
  assert.throws(
    () =>
      persistJournalForSession(
        { getItem: () => null, setItem: () => undefined },
        key,
        record,
        () => true,
      ),
    /persist/,
  );
  assert.throws(
    () =>
      persistJournalForSession(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("Storage blocked");
          },
        },
        key,
        record,
        () => true,
      ),
    /Storage blocked/,
  );
  persistJournalForSession(storage, key, record, () => true);
  assert.deepEqual(
    readJournal(raw, record.programId, record.cluster, record.wallet),
    record,
  );
});

test("pool/view changes discard old preparation without hiding wallet-keyed recovery", () => {
  const oldPool = { value: "pool-A:explore:0" };
  const otherPool = { value: "pool-B:explore:0" };
  const returnToPool = { value: "pool-A:explore:0" };
  const session = {};
  assert.equal(sameReviewScope(oldPool, oldPool), true);
  assert.equal(sameReviewScope(oldPool, otherPool), false);
  assert.equal(
    sameReviewScope(oldPool, returnToPool),
    false,
    "navigating back must not revive a stale request",
  );
  assert.equal(
    sameReviewScope(oldPool, null),
    false,
    "unmounted scope cannot sign",
  );
  assert.equal(
    sameActionContext({ key, session }, { key, session }),
    true,
    "pending remains bound to wallet, not selected pool",
  );
  let writes = 0;
  assert.throws(
    () =>
      persistJournalForSession(
        {
          getItem: () => null,
          setItem: () => {
            writes++;
          },
        },
        key,
        record,
        () => sameReviewScope(oldPool, otherPool),
      ),
    /changed/,
  );
  assert.equal(writes, 0);
});
