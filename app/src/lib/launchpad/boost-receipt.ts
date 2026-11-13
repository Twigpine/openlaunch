import { decodeEventLog, toEventSelector, type TransactionReceipt } from "viem";
import { ERC20_TRANSFER_EVENT } from "./abi";
import { BOOST_TOKEN, boostFromTransfer } from "./boost";

const TRANSFER_TOPIC = toEventSelector(ERC20_TRANSFER_EVENT);

/** Receipt facts use the indexer's boost rules, including locker exclusion. Never infer a replacement's amount. */
export function boostReceiptAmount(receipt: Pick<TransactionReceipt, "transactionHash" | "logs">, tag: bigint, locker: string | null): bigint | null {
  let amount = 0n;
  const seen = new Set<number>();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== BOOST_TOKEN || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.removed || log.transactionHash?.toLowerCase() !== receipt.transactionHash.toLowerCase()
      || log.logIndex === null || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || log.blockNumber === null || seen.has(log.logIndex)) {
      throw new Error("The replacement burn could not be verified. Check its transaction before sending again.");
    }
    seen.add(log.logIndex);
    const { args } = decodeEventLog({ abi: [ERC20_TRANSFER_EVENT], data: log.data, topics: log.topics, strict: true });
    const row = boostFromTransfer({ address: log.address, ...args, txHash: receipt.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber }, locker ? [locker] : []);
    if (row?.tag === tag.toString()) amount += args.value;
  }
  return amount > 0n ? amount : null;
}
