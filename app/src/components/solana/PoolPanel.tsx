"use client";

import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  buildActivateLaunchInstruction,
  buildCancelPreparationInstruction,
  buildBuyInstruction,
  buildSellInstruction,
  buildClaimFeesInstruction,
  buildCreateAssociatedTokenInstruction,
  claimableFees,
  deriveAssociatedTokenAddress,
  fetchPoolSnapshot,
  FIXED_SUPPLY,
  minimumAfterSlippage,
  quoteBuy,
  quoteSell,
  readPoolSnapshot,
  TOKEN_PROGRAM_ID,
  type PoolSnapshot,
} from "@openlaunch/solana-sdk";
import { btn, input, label } from "@/components/ui";
import {
  explorerUrl,
  formatUnits,
  parseUnits,
  requireRent,
} from "@/lib/solana/config";
import type { SolanaPanelProps } from "./SolanaWorkspace";
import SolanaHistory from "./SolanaHistory";

/**
 * Slots a trade quote stays valid on-chain: longer than the blockhash (about 150 blocks), so the blockhash expiry the
 * client checks always comes first, and a slow wallet approval never meets a raw program "Expired" error.
 */
const TRADE_EXPIRY_SLOTS = 300n;

export default function PoolPanel({
  connection,
  config,
  address,
  actions,
  snapshot,
  onRefresh,
}: SolanaPanelProps & { snapshot: PoolSnapshot; onRefresh: () => void }) {
  const { pool } = snapshot;
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [balanceRecord, setBalance] = useState<{
    wallet: string;
    mint: string;
    sol: bigint;
    tokens: bigint;
  } | null>(null);
  const [working, setWorking] = useState(false);
  const [fresh, setFresh] = useState(snapshot);
  const [quoteError, setQuoteError] = useState("");
  const [lastRead, setLastRead] = useState(0);
  const program = useMemo(
    () => new PublicKey(config.programId),
    [config.programId],
  );
  const locked =
    actions.busy ||
    Boolean(actions.pending) ||
    !actions.restored ||
    !address ||
    working;
  const isCreator = address === pool.creator.toBase58();
  useEffect(() => {
    let alive = true;
    let reading = false;
    const load = async () => {
      if (reading) return;
      reading = true;
      try {
        // One call per poll: the pool, its custody, the wallet and its token account, all from one bank.
        const owner = address ? new PublicKey(address) : null;
        const { snapshot: result, extra } = await readPoolSnapshot(
          connection,
          program,
          snapshot.address,
          owner
            ? [
                owner,
                deriveAssociatedTokenAddress(snapshot.addresses.mint, owner),
              ]
            : [],
        );
        if (!alive) return;
        setFresh(result);
        setLastRead(Date.now());
        setQuoteError("");
        if (owner && address) {
          const [wallet, token] = extra;
          const sol = wallet?.lamports ?? 0;
          if (!Number.isSafeInteger(sol))
            throw new Error(
              "Balance precision is unsupported by this RPC client.",
            );
          if (
            token &&
            (!token.owner.equals(TOKEN_PROGRAM_ID) ||
              token.data.length !== 165 ||
              !new PublicKey(token.data.subarray(32, 64)).equals(owner) ||
              !new PublicKey(token.data.subarray(0, 32)).equals(
                result.addresses.mint,
              ))
          )
            throw new Error("Invalid trade token account.");
          if (alive)
            setBalance({
              wallet: address,
              mint: result.addresses.mint.toBase58(),
              sol: BigInt(sol),
              tokens: token?.data.readBigUInt64LE(64) ?? 0n,
            });
        } else if (alive) setBalance(null);
      } catch {
        if (alive) {
          setBalance(null);
          setQuoteError(
            "Live account refresh failed. Trading is paused here until the next successful read.",
          );
        }
      } finally {
        reading = false;
      }
    };
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 8_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [connection, program, snapshot, address]);
  let estimated: ReturnType<typeof quoteBuy> | null = null;
  let amountError = "";
  if (amount && fresh.pool.status === "active") {
    try {
      estimated =
        side === "buy"
          ? quoteBuy(fresh.pool, parseUnits(amount, 9))
          : quoteSell(fresh.pool, parseUnits(amount, 6));
    } catch (e) {
      amountError =
        e instanceof Error ? e.message : "No quote for this amount.";
    }
  }
  async function reviewTrade() {
    if (!address || working) return;
    setWorking(true);
    try {
      const trader = new PublicKey(address);
      const {
        snapshot: current,
        extra: [ata],
      } = await readPoolSnapshot(connection, program, snapshot.address, [
        deriveAssociatedTokenAddress(snapshot.addresses.mint, trader),
      ]);
      if (current.pool.status !== "active")
        throw new Error("This pool is not active.");
      const amountIn = parseUnits(amount, side === "buy" ? 9 : 6);
      const quote =
        side === "buy"
          ? quoteBuy(current.pool, amountIn)
          : quoteSell(current.pool, amountIn);
      const minimumOut = minimumAfterSlippage(quote.amountOut, 100);
      const expirySlot = BigInt(current.slot) + TRADE_EXPIRY_SLOTS;
      const args = {
        creator: current.pool.creator,
        nonce: current.pool.nonce,
        trader,
        amountIn,
        minimumOut,
        expirySlot,
      };
      const instructions =
        side === "buy"
          ? [
              buildCreateAssociatedTokenInstruction(
                trader,
                current.addresses.mint,
                trader,
              ),
              buildBuyInstruction(program, args),
            ]
          : [buildSellInstruction(program, args)];
      const extraRent =
        side === "buy" && !ata
          ? requireRent(await connection.getMinimumBalanceForRentExemption(165))
          : 0;
      await actions.prepare(
        side === "buy" ? "Buy tokens" : "Sell tokens",
        instructions,
        [
          ["Token mint", current.addresses.mint.toBase58()],
          [
            "You send",
            `${formatUnits(amountIn, side === "buy" ? 9 : 6)} ${side === "buy" ? "SOL" : pool.symbol}`,
          ],
          [
            "Estimated receive",
            `${formatUnits(quote.amountOut, side === "buy" ? 6 : 9)} ${side === "buy" ? pool.symbol : "SOL"}`,
          ],
          [
            "Minimum receive (1% slippage)",
            `${formatUnits(minimumOut, side === "buy" ? 6 : 9)} ${side === "buy" ? pool.symbol : "SOL"}`,
          ],
          ["Trading fee (included)", `${formatUnits(quote.fee, 9)} SOL`],
          [
            "Token account rent (extra, estimated)",
            `${formatUnits(BigInt(extraRent), 9)} SOL`,
          ],
          ["Expiry slot", expirySlot.toString()],
        ],
        snapshot.address.toBase58(),
        expirySlot,
      );
    } catch (e) {
      actions.setError(
        e instanceof Error ? e.message : "Could not quote this trade.",
      );
    } finally {
      setWorking(false);
    }
  }
  async function reviewLifecycle(activate: boolean) {
    if (!address || working) return;
    setWorking(true);
    try {
      const current = await fetchPoolSnapshot(
        connection,
        program,
        snapshot.address,
      );
      if (
        current.pool.status !== "prepared" ||
        current.pool.creator.toBase58() !== address
      )
        throw new Error(
          "Only the original creator can finish this preparation.",
        );
      const creator = new PublicKey(address);
      const rent = activate
        ? (
            await Promise.all(
              [82, 165, 49, 49].map(async (space) =>
                requireRent(
                  await connection.getMinimumBalanceForRentExemption(space),
                ),
              ),
            )
          ).reduce((sum, n) => sum + n, 0)
        : 0;
      await actions.prepare(
        activate ? "Activate launch" : "Cancel preparation",
        [
          activate
            ? buildActivateLaunchInstruction(program, creator, pool.nonce)
            : buildCancelPreparationInstruction(program, creator, pool.nonce),
        ],
        [
          ["Token", `${pool.name} (${pool.symbol})`],
          ["Token mint", current.addresses.mint.toBase58()],
          [
            "Effect",
            activate
              ? "Mint all supply into the pool; revoke mint authority; open trading permanently."
              : "Permanently cancel this pool address. Preparation rent is not refunded.",
          ],
          [
            "Additional account rent (estimated)",
            `${formatUnits(BigInt(rent), 9)} SOL`,
          ],
          ["Initial real SOL", "0 SOL"],
          ["Fixed trading fee", `${pool.feeBps / 100}%`],
        ],
        snapshot.address.toBase58(),
      );
    } catch (e) {
      actions.setError(
        e instanceof Error ? e.message : "Could not review this launch.",
      );
    } finally {
      setWorking(false);
    }
  }
  async function claim(index: number) {
    if (working) return;
    setWorking(true);
    try {
      const current = await fetchPoolSnapshot(
        connection,
        program,
        snapshot.address,
      );
      const recipient = current.pool.recipients[index];
      const available = claimableFees(
        current.pool.feesEarned,
        recipient.weightBps,
        recipient.paid,
      );
      if (!available)
        throw new Error("There are no fees to claim for this recipient.");
      await actions.prepare(
        "Claim fees",
        [buildClaimFeesInstruction(program, current.pool, index)],
        [
          ["Token mint", current.addresses.mint.toBase58()],
          ["Recipient (fixed)", recipient.address.toBase58()],
          ["Claimable at review", `${formatUnits(available, 9)} SOL`],
          [
            "Your role",
            "Pay the network fee. SOL is paid only to the fixed recipient.",
          ],
        ],
        snapshot.address.toBase58(),
      );
    } catch (e) {
      actions.setError(
        e instanceof Error ? e.message : "Could not review this claim.",
      );
    } finally {
      setWorking(false);
    }
  }
  const fdvLamports =
    (FIXED_SUPPLY * (fresh.pool.realSolReserves + fresh.pool.virtualSol)) /
    (fresh.pool.tokenInventory || FIXED_SUPPLY);
  const balance =
    balanceRecord?.wallet === address &&
    balanceRecord?.mint === snapshot.addresses.mint.toBase58()
      ? balanceRecord
      : null;
  return (
    <section>
      <header className="mb-6">
        <h2 className="break-words text-2xl font-semibold text-ink">
          {pool.name}{" "}
          <span className="text-lg font-normal text-muted">{pool.symbol}</span>
        </h2>
        <p className="mt-2 text-sm text-muted">
          {pool.status === "active"
            ? "Active · Token / SOL"
            : pool.status === "prepared"
              ? "Prepared · No token supply minted yet"
              : "Cancelled · This address cannot be reused"}
        </p>
        <a
          className="mt-2 inline-block max-w-full break-all font-code text-xs text-brand hover:underline"
          href={explorerUrl(
            config.cluster,
            "address",
            snapshot.address.toBase58(),
          )}
          target="_blank"
          rel="noreferrer"
        >
          {snapshot.address.toBase58()}
        </a>
      </header>
      {pool.status === "prepared" && (
        <div className="mb-8 border-y border-line py-5">
          <p className="max-w-2xl text-sm leading-relaxed text-body">
            Activation is permanent. It creates the mint and vaults, puts all
            supply in the pool, and removes mint authority. There is no freeze
            authority, migration, or liquidity withdrawal.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              className={btn.primary}
              disabled={locked || !isCreator}
              onClick={() => void reviewLifecycle(true)}
            >
              Review activation
            </button>
            <button
              className={btn.dangerSm}
              disabled={locked || !isCreator}
              onClick={() => void reviewLifecycle(false)}
            >
              Review cancellation
            </button>
          </div>
          {!isCreator && (
            <p className="mt-3 text-xs text-muted">
              Connect the creator wallet to activate or cancel.
            </p>
          )}
        </div>
      )}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.65fr)]">
        <div className="min-w-0">
          <dl className="divide-y divide-line border-y border-line">
            {[
              [
                "Real SOL reserves",
                `${formatUnits(fresh.pool.realSolReserves, 9)} SOL`,
              ],
              [
                "Spot-price FDV (not cash available)",
                `${formatUnits(fdvLamports, 9)} SOL`,
              ],
              [
                "Virtual pricing offset (not deposited)",
                `${formatUnits(pool.virtualSol, 9)} SOL`,
              ],
              [
                "Pool token inventory",
                `${formatUnits(fresh.pool.tokenInventory, 6)} ${pool.symbol}`,
              ],
              ["Original token supply", "1,000,000,000"],
              ["Fixed trading fee", `${pool.feeBps / 100}%`],
            ].map(([term, value]) => (
              <div
                key={term}
                className="flex justify-between gap-5 py-3 text-sm"
              >
                <dt className="text-muted">{term}</dt>
                <dd className="max-w-[60%] break-all text-right font-medium tabular-nums text-ink">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-muted">
            Real reserves exclude account rent and beneficiary fees. Trades use
            the curve’s accounted balances, not unsolicited donations. SOL
            available for sellers depends on real buyer deposits and prior
            trading.
          </p>
          {pool.status === "active" && (
            <SolanaHistory
              config={config}
              pool={snapshot.address.toBase58()}
              sequence={fresh.pool.sequence.toString()}
            />
          )}
        </div>
        {pool.status === "active" && (
          <form
            className="self-start rounded-2xl border border-line bg-card p-5"
            onSubmit={(e) => {
              e.preventDefault();
              void reviewTrade();
            }}
          >
            <fieldset className="mb-5">
              <legend className="sr-only">Trade direction</legend>
              <div className="flex gap-2">
                {(["buy", "sell"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={side === value ? btn.soft : btn.secondary}
                    aria-pressed={side === value}
                    onClick={() => {
                      setSide(value);
                      setAmount("");
                    }}
                  >
                    {value === "buy" ? "Buy" : "Sell"}
                  </button>
                ))}
              </div>
            </fieldset>
            <label className="block">
              <span className={label}>
                You send {side === "buy" ? "SOL" : pool.symbol}
              </span>
              <input
                className={`${input} text-xl tabular-nums`}
                required
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </label>
            <p className="mt-2 text-xs text-muted">
              {balance
                ? `${side === "buy" ? "SOL balance" : "Trade-account balance"}: ${formatUnits(side === "buy" ? balance.sol : balance.tokens, side === "buy" ? 9 : 6)}`
                : address
                  ? "Reading wallet balances…"
                  : "Connect a wallet to see balances."}
            </p>
            <div className="my-5 border-y border-line py-4">
              <span className="text-xs text-muted">Estimated receive</span>
              <p className="mt-1 break-all text-xl font-semibold tabular-nums text-ink">
                {estimated
                  ? formatUnits(estimated.amountOut, side === "buy" ? 6 : 9)
                  : "Enter an amount"}{" "}
                {estimated ? (side === "buy" ? pool.symbol : "SOL") : ""}
              </p>
              {estimated && (
                <p className="mt-2 text-xs text-muted">
                  Includes {formatUnits(estimated.fee, 9)} SOL trading fee.
                  Network fee and account rent are extra.
                </p>
              )}
            </div>
            {(quoteError || amountError) && (
              <p role="status" className="mb-4 text-sm text-down-ink">
                {quoteError || amountError}
              </p>
            )}
            <button
              className={`${btn.primary} w-full`}
              disabled={Boolean(
                locked || !estimated || quoteError || !lastRead,
              )}
            >
              {working ? "Refreshing quote…" : "Review trade"}
            </button>
            <p className="mt-3 text-xs leading-relaxed text-muted">
              1% maximum output slippage. Final review refreshes the pool and
              simulates the exact transaction. Keep SOL for fees.
            </p>
            <button
              type="button"
              className="mt-3 text-xs text-brand"
              onClick={onRefresh}
            >
              Refresh account state
            </button>
          </form>
        )}
      </div>
      {pool.recipients.length > 0 && (
        <section className="mt-8 border-t border-line pt-6">
          <h3 className="text-lg font-semibold text-ink">
            Fixed fee recipients
          </h3>
          <p className="mt-2 text-xs text-muted">
            Anyone can trigger a claim. Payment always goes to the recipient
            below, never to the caller by default.
          </p>
          <ul className="mt-3 divide-y divide-line">
            {fresh.pool.recipients.map((r, i) => (
              <li
                key={r.address.toBase58()}
                className="flex flex-wrap items-center justify-between gap-4 py-4"
              >
                <div className="min-w-0">
                  <a
                    className="break-all font-code text-xs text-body hover:text-brand"
                    href={explorerUrl(
                      config.cluster,
                      "address",
                      r.address.toBase58(),
                    )}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {r.address.toBase58()}
                  </a>
                  <p className="mt-1 text-xs text-muted">
                    {r.weightBps / 100}% share ·{" "}
                    {formatUnits(
                      claimableFees(fresh.pool.feesEarned, r.weightBps, r.paid),
                      9,
                    )}{" "}
                    SOL claimable
                  </p>
                </div>
                <button
                  className={btn.secondarySm}
                  disabled={
                    locked ||
                    pool.status !== "active" ||
                    claimableFees(
                      fresh.pool.feesEarned,
                      r.weightBps,
                      r.paid,
                    ) === 0n
                  }
                  onClick={() => void claim(i)}
                >
                  Review claim
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
