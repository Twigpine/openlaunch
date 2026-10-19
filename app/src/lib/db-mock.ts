// Mock @/lib/db for tests. Exports maybeDb() returning a fake postgres tagged-template
// function whose behavior is driven by a global mock state set by the test.
import type { Db } from "./db.ts";

type NonceRow = {
  nonce: string;
  used_at: string | null;
  wallet: string;
  token: string;
  chain_id: number;
  expires_at: string;
};

type MockState = {
  nonceRows: Record<string, NonceRow>;
  launcherRows: Record<string, { launcher: string; name: string; symbol: string }>;
  metaInserted: boolean;
  metaInsertShouldThrow: boolean;
  verifyShouldThrow: boolean;
  verifyResult: boolean;
  // When set, publicClient (chain-mock) returns a real viem client with an
  // unreachable transport, so the RPC-outage path is exercised through viem
  // itself rather than a hand-rolled stub.
  transportOutage: boolean;
  // What getLaunchTotals' one aggregation over bb_launches returns: a row per (chain, quote).
  launchTotalsRows: { chain_id: number; quote: string; launches: bigint; trades: bigint; volume: string; burned: string; creators: string }[];
  // What the B20 node (chain-mock's b20Client) answers to totalSupply(), per address; "fail" = that call fails, null = the node is down.
  b20Supply: Record<string, bigint | "fail"> | null;
  b20SupplyReads: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __editMock: MockState | undefined;
}

export function resetMock() {
  globalThis.__editMock = {
    nonceRows: {},
    launcherRows: {},
    metaInserted: false,
    metaInsertShouldThrow: false,
    verifyShouldThrow: false,
    verifyResult: true,
    transportOutage: false,
    launchTotalsRows: [],
    b20Supply: null,
    b20SupplyReads: 0,
  };
}

export function getMock(): MockState {
  if (!globalThis.__editMock) resetMock();
  return globalThis.__editMock!;
}

// Deep-snapshot the mutable parts of mock state so begin() can restore on rollback.
function snapshot(m: MockState) {
  return {
    nonceRows: Object.fromEntries(
      Object.entries(m.nonceRows).map(([k, v]) => [k, { ...v }]),
    ),
    metaInserted: m.metaInserted,
  };
}

function restore(m: MockState, snap: { nonceRows: Record<string, NonceRow>; metaInserted: boolean }) {
  m.nonceRows = snap.nonceRows;
  m.metaInserted = snap.metaInserted;
}

// A fake db tagged-template function. It inspects the SQL text to decide what to return.
function fakeDb(strings: TemplateStringsArray, ...values: unknown[]): Promise<any[]> {
  const sql = strings.join("?");
  const m = getMock();

  // UPDATE bb_edit_nonces SET used_at = now() ... RETURNING nonce
  // Checks all predicates from applySignedEdit: nonce, chain_id, token,
  // wallet, used_at IS NULL, expires_at > now(), and the exact signed expiry.
  if (sql.includes("UPDATE bb_edit_nonces") && sql.includes("used_at")) {
    const nonce = String(values[0]);
    const cid = Number(values[1]);
    const token = String(values[2]).toLowerCase();
    const wallet = String(values[3]).toLowerCase();
    const signedExpiry = String(values[4]);
    const row = m.nonceRows[nonce];
    if (!row) return Promise.resolve([] as any[]);
    if (row.used_at !== null) return Promise.resolve([] as any[]);
    if (row.chain_id !== cid) return Promise.resolve([] as any[]);
    if (row.token !== token) return Promise.resolve([] as any[]);
    if (row.wallet !== wallet) return Promise.resolve([] as any[]);
    if (row.expires_at !== signedExpiry) return Promise.resolve([] as any[]);
    // expires_at > now(): check the stored expiry is in the future
    if (new Date(row.expires_at).getTime() <= Date.now()) return Promise.resolve([] as any[]);
    row.used_at = new Date().toISOString();
    return Promise.resolve([{ nonce }] as any[]);
  }

  // platform totals (getLaunchTotals)
  if (sql.includes("FROM bb_launches GROUP BY chain_id, quote")) {
    return Promise.resolve(m.launchTotalsRows as any[]);
  }

  // launcher lookup (issueNonce and applySignedEdit)
  if (sql.includes("FROM bb_launches") && sql.includes("launcher")) {
    const token = String(values[1]);
    const row = m.launcherRows[token];
    if (!row) return Promise.resolve([] as any[]);
    if (sql.includes("name, symbol")) return Promise.resolve([row] as any[]);
    return Promise.resolve([{ launcher: row.launcher }] as any[]);
  }

  // metadata write
  if (sql.includes("bb_launch_meta")) {
    if (m.metaInsertShouldThrow) throw new Error("mock metadata write failed");
    m.metaInserted = true;
    return Promise.resolve([] as any[]);
  }

  // nonce insert (issueNonce)
  if (sql.includes("bb_edit_nonces") && sql.includes("VALUES")) {
    return Promise.resolve([] as any[]);
  }

  // expired nonce cleanup
  if (sql.includes("DELETE") && sql.includes("bb_edit_nonces")) {
    return Promise.resolve([] as any[]);
  }

  return Promise.resolve([] as any[]);
}

// begin() snapshots mock state before the transaction callback and restores
// it on rejection, so a failed metadata write rolls back the nonce consume
// (including reverting used_at), matching the real db.begin() semantics.
(fakeDb as any).begin = async (fn: (tx: any) => Promise<any>) => {
  const m = getMock();
  const snap = snapshot(m);
  try {
    return await fn(fakeDb);
  } catch (e) {
    restore(m, snap);
    throw e;
  }
};

export function maybeDb(): any | null {
  return fakeDb as any;
}

export function dbConfigured(): boolean {
  return true;
}

export function db(): any {
  return fakeDb as any;
}

export type { Db };
