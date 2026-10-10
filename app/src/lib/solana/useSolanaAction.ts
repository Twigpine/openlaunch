"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Connection,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  prepareTransaction,
  simulatePreparedTransaction,
  validateSignedTransaction,
  submitSignedTransaction,
  rebroadcastSignedTransaction,
  reconcileTransaction,
  verifyImmutableProgram,
  type PreparedTransaction,
} from "@openlaunch/solana-sdk";
import type { SolanaConfig } from "./config";
import {
  clearJournalIfCurrent,
  journalKey,
  persistJournalForSession,
  readJournal,
  sameActionContext,
  samePendingAction,
  sameReviewScope,
  type ActionContext,
  type PendingSolanaAction,
  type ReviewScope,
} from "./journal";
import type { WalletSession } from "./wallet";

export type ActionReview = {
  label: string;
  lines: [string, string][];
  prepared: PreparedTransaction;
  payer: string;
  pool: string | null;
  networkFee: number;
  /** The program's own deadline for a trade (its expiry slot), checked with the blockhash before signing. */
  expirySlot: bigint | null;
};
/** Slots of headroom a trade review keeps before its expiry slot: about 8 seconds to approve in the wallet. */
const EXPIRY_MARGIN_SLOTS = 20n;
/** While a signature is unseen, its identical bytes are sent again at most this often. */
const REBROADCAST_MS = 8_000;
type Recovery = {
  context: ActionContext;
  pending: PendingSolanaAction | null;
  ready: boolean;
  error: string;
};
type Notice = { context: ActionContext; message: string; error: string };

export function useSolanaAction(
  config: SolanaConfig,
  connection: Connection,
  session: WalletSession | null,
  sign: (wire: Uint8Array) => Promise<Uint8Array>,
  onSettled: (pool: string | null) => void,
  reviewScope: string,
) {
  const address = session?.account.address ?? "";
  const key = journalKey(config.programId, config.cluster, address);
  const context = useMemo(() => ({ key, session }), [key, session]);
  const scope = useMemo<ReviewScope>(
    () => ({ value: reviewScope }),
    [reviewScope],
  );
  const [reviewState, setReview] = useState<{
    context: ActionContext;
    scope: ReviewScope;
    value: ActionReview;
  } | null>(null);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const gate = useRef(false);
  const checks = useRef(new Set<string>());
  // The signed bytes of this tab's latest send, kept in memory only, so a dropped packet can be sent again.
  const sent = useRef<{ signature: string; bytes: Uint8Array; at: number } | null>(null);
  const currentContext = useRef<ActionContext>(context);
  const currentScope = useRef<ReviewScope | null>(scope);
  const settled = useRef(onSettled);
  useLayoutEffect(() => {
    currentContext.current = context;
    settled.current = onSettled;
    return () => {
      currentContext.current = { key: "", session: null };
    };
  }, [context, onSettled]);
  useLayoutEffect(() => {
    currentScope.current = scope;
    return () => {
      currentScope.current = null;
    };
  }, [scope]);

  // A prior wallet's ready flag cannot survive one render of a new identity.
  // Reconnecting the same address also creates a fresh signing session.
  const recovered =
    recovery && sameActionContext(recovery.context, context) ? recovery : null;
  const restored = recovered?.ready ?? false;
  const pending = recovered?.pending ?? null;
  const review =
    restored &&
    reviewState &&
    sameActionContext(reviewState.context, context) &&
    sameReviewScope(reviewState.scope, scope)
      ? reviewState.value
      : null;
  const visibleNotice =
    notice && sameActionContext(notice.context, context) ? notice : null;
  const message = visibleNotice?.message ?? "";
  const error = recovered?.error || visibleNotice?.error || "";

  const live = useCallback(
    () =>
      sameActionContext(context, currentContext.current) &&
      Boolean(session?.isCurrent()) &&
      session?.chain ===
        (config.cluster === "devnet" ? "solana:devnet" : "solana:mainnet"),
    [context, session, config.cluster],
  );
  const reviewLive = useCallback(
    () => live() && sameReviewScope(scope, currentScope.current),
    [live, scope],
  );
  const setError = useCallback(
    (value: string) => {
      if (!sameActionContext(context, currentContext.current)) return;
      setNotice((old) => ({
        context,
        message:
          old && sameActionContext(old.context, context) ? old.message : "",
        error: value,
      }));
    },
    [context],
  );
  const setMessage = useCallback(
    (value: string) => {
      if (!sameActionContext(context, currentContext.current)) return;
      setNotice((old) => ({
        context,
        message: value,
        error: old && sameActionContext(old.context, context) ? old.error : "",
      }));
    },
    [context],
  );

  const restore = useCallback(() => {
    if (!sameActionContext(context, currentContext.current)) return;
    if (!address) {
      setRecovery({ context, pending: null, ready: true, error: "" });
      return;
    }
    try {
      const raw = localStorage.getItem(key);
      const record = readJournal(
        raw,
        config.programId,
        config.cluster,
        address,
      );
      if (raw && !record)
        throw new Error(
          "The transaction recovery record is unreadable. Inspect your wallet history before clearing site storage or signing again.",
        );
      setRecovery((old) => ({
        context,
        // Storage deletion by another tab is not proof of finality. Retain our
        // known signature until our own reconciliation reaches a terminal state.
        pending:
          record ??
          (old && sameActionContext(old.context, context) ? old.pending : null),
        ready: true,
        error: "",
      }));
    } catch (e) {
      setRecovery((old) => ({
        context,
        pending:
          old && sameActionContext(old.context, context) ? old.pending : null,
        ready: false,
        error:
          e instanceof Error
            ? e.message
            : "Browser storage is unavailable. Signing is disabled.",
      }));
    }
  }, [context, address, key, config.programId, config.cluster]);
  useEffect(() => {
    const timer = setTimeout(restore, 0);
    const storage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) restore();
    };
    window.addEventListener("storage", storage);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("storage", storage);
    };
  }, [restore, key]);

  const check = useCallback(async () => {
    if (!pending || pending.wallet !== address || !live()) return;
    const checkId = key + ":" + pending.signature;
    if (checks.current.has(checkId)) return;
    checks.current.add(checkId);
    try {
      const result = await reconcileTransaction(
        connection,
        pending.signature,
        pending.lastValidBlockHeight,
      );
      if (!live()) return;
      const bytes = sent.current;
      if (
        result.unseen &&
        bytes?.signature === pending.signature &&
        Date.now() - bytes.at >= REBROADCAST_MS
      ) {
        bytes.at = Date.now();
        void rebroadcastSignedTransaction(connection, bytes.bytes);
      }
      if (["finalized", "failed", "expired"].includes(result.status)) {
        if (sent.current?.signature === pending.signature) sent.current = null;
        if (!navigator.locks) throw new Error("Web Locks unavailable");
        await navigator.locks.request(key, { ifAvailable: true }, (lock) => {
          if (!lock || !live()) return;
          const removed = clearJournalIfCurrent(localStorage, key, pending);
          if (!removed && localStorage.getItem(key)) {
            restore();
            return;
          }
          setRecovery((old) =>
            old &&
            sameActionContext(old.context, context) &&
            samePendingAction(old.pending, pending)
              ? { ...old, pending: null, error: "" }
              : old,
          );
          setError("");
          setMessage(
            result.status === "finalized"
              ? pending.label + " finalized. Balances are being refreshed."
              : result.status === "failed"
                ? "Transaction failed on-chain. No pool action completed; network fees may still apply."
                : "The transaction expired without a recorded landing. Review a fresh transaction if you still want to proceed.",
          );
          settled.current(pending.pool);
        });
      } else
        setMessage(
          result.status === "confirmed"
            ? "Confirmed. Waiting for finality before allowing another transaction."
            : "Waiting for confirmation. Do not submit a replacement.",
        );
    } catch {
      if (live())
        setMessage(
          "Confirmation is unavailable. Your transaction may still land. Keep this signature and check again.",
        );
    } finally {
      checks.current.delete(checkId);
    }
  }, [
    pending,
    address,
    live,
    key,
    connection,
    restore,
    context,
    setError,
    setMessage,
  ]);
  useEffect(() => {
    if (!pending) return;
    const poll = () => {
      if (!document.hidden) void check();
    };
    const timer = setTimeout(poll, 0);
    const interval = setInterval(poll, 4_000);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [pending, check]);

  async function prepare(
    label: string,
    instructions: TransactionInstruction[],
    lines: [string, string][],
    pool: string | null,
    expirySlot: bigint | null = null,
  ) {
    if (
      gate.current ||
      pending ||
      !restored ||
      !sameReviewScope(scope, currentScope.current)
    )
      return;
    if (!address || !live()) {
      setError("Connect your current Solana wallet first.");
      return;
    }
    gate.current = true;
    setBusy(true);
    setError("");
    setReview(null);
    setMessage("");
    try {
      if (localStorage.getItem(key)) {
        restore();
        throw new Error(
          "Resolve the wallet's previous transaction before preparing another.",
        );
      }
      await verifyImmutableProgram(connection, new PublicKey(config.programId));
      if (!reviewLive())
        throw new Error(
          "The wallet or selected pool changed. Review the current selection again.",
        );
      const tx = await prepareTransaction(
        connection,
        new PublicKey(address),
        instructions,
      );
      if (!reviewLive())
        throw new Error(
          "The wallet or selected pool changed. Review the current selection again.",
        );
      await simulatePreparedTransaction(connection, tx);
      if (!reviewLive())
        throw new Error(
          "The wallet or selected pool changed. Review the current selection again.",
        );
      const fee = await connection.getFeeForMessage(
        tx.transaction.compileMessage(),
        "confirmed",
      );
      if (
        fee.value === null ||
        !Number.isSafeInteger(fee.value) ||
        fee.value < 0
      )
        throw new Error("Could not estimate the transaction fee. Try again.");
      if (!reviewLive())
        throw new Error(
          "The wallet or selected pool changed. Review the current selection again.",
        );
      if (localStorage.getItem(key)) {
        restore();
        throw new Error(
          "Another tab submitted a transaction. Resolve it before continuing.",
        );
      }
      setReview({
        context,
        scope,
        value: {
          label,
          lines,
          prepared: tx,
          payer: address,
          pool,
          networkFee: fee.value,
          expirySlot,
        },
      });
    } catch (e) {
      if (sameReviewScope(scope, currentScope.current))
        setError(
          e instanceof Error
            ? e.message
            : "Could not simulate this transaction.",
        );
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }

  async function confirm() {
    if (gate.current || !review || pending || !restored || !reviewLive())
      return;
    gate.current = true;
    setBusy(true);
    setError("");
    try {
      if (!navigator.locks)
        throw new Error(
          "This browser cannot safely coordinate wallet submissions across tabs. Use a browser with Web Locks support.",
        );
      await navigator.locks.request(
        key,
        { ifAvailable: true },
        async (lock) => {
          if (!lock)
            throw new Error(
              "Another tab is using this wallet. Finish that transaction first.",
            );
          if (!reviewLive())
            throw new Error(
              "The wallet or selected pool changed. Review the current selection again.",
            );
          if (localStorage.getItem(key)) {
            restore();
            throw new Error(
              "This wallet has an unresolved transaction. Check its status first.",
            );
          }
          if (review.payer !== address || !reviewLive())
            throw new Error(
              "The wallet or selected pool changed. Review again.",
            );
          // One bank gives both deadlines: the blockhash's block height and the trade's own expiry slot.
          const epoch = await connection.getEpochInfo("confirmed");
          const height =
            epoch.blockHeight ?? (await connection.getBlockHeight("confirmed"));
          if (
            height > review.prepared.lastValidBlockHeight ||
            (review.expirySlot !== null &&
              BigInt(epoch.absoluteSlot) + EXPIRY_MARGIN_SLOTS >
                review.expirySlot)
          )
            throw new Error("This review expired. Refresh it before signing.");
          if (!reviewLive())
            throw new Error(
              "The wallet or selected pool changed. Nothing was signed or broadcast.",
            );
          await simulatePreparedTransaction(connection, review.prepared);
          if (!reviewLive())
            throw new Error(
              "The wallet or selected pool changed during simulation. Nothing was signed or broadcast.",
            );
          const signedBytes = await sign(review.prepared.wireBytes);
          // No await between this guard, durable journal write and initiating
          // broadcast. Wallet events invalidate synchronously, before React renders.
          if (!reviewLive())
            throw new Error(
              "The wallet or selected pool changed while signing. Nothing was broadcast.",
            );
          const signed = validateSignedTransaction(
            review.prepared.messageBytes,
            signedBytes,
            new PublicKey(address),
          );
          const record: PendingSolanaAction = {
            version: 1,
            programId: config.programId,
            cluster: config.cluster,
            wallet: address,
            signature: signed.signature,
            lastValidBlockHeight: review.prepared.lastValidBlockHeight,
            label: review.label,
            pool: review.pool,
          };
          persistJournalForSession(localStorage, key, record, reviewLive);
          setRecovery({ context, pending: record, ready: true, error: "" });
          setReview(null);
          sent.current = {
            signature: signed.signature,
            bytes: signed.bytes,
            at: Date.now(),
          };
          const result = await submitSignedTransaction(connection, signed);
          if (result.status === "rejected") {
            // Refused before it was forwarded, so these signed bytes can never land: release the wallet (we still
            // hold its lock) and say why, instead of waiting out the blockhash as an uncertain submission.
            sent.current = null;
            clearJournalIfCurrent(localStorage, key, record);
            setRecovery((old) =>
              old &&
              sameActionContext(old.context, context) &&
              samePendingAction(old.pending, record)
                ? { ...old, pending: null, error: "" }
                : old,
            );
            throw new Error(
              `${result.error ?? "Solana RPC refused the transaction"}. Nothing was sent. Review again to retry.`,
            );
          }
          if (live())
            setMessage(
              result.status === "unknown"
                ? "Submission is uncertain. We are checking the signed transaction; do not send another."
                : "Submitted. Waiting for confirmation.",
            );
        },
      );
    } catch (e) {
      if (sameReviewScope(scope, currentScope.current))
        setError(e instanceof Error ? e.message : "Signing did not complete.");
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  return {
    review,
    pending,
    busy,
    restored,
    message,
    error,
    prepare,
    confirm,
    check,
    cancelReview: () => setReview(null),
    setError,
  };
}
