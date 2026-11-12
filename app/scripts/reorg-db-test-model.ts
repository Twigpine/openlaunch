import { createHash } from 'node:crypto';
import { createPublicClient, custom, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, toHex, type Abi, type AbiEvent, type Hex } from 'viem';
import { base } from 'viem/chains';
import { LAUNCH_FACTORY_ABI, LAUNCH_LOCKER_ABI, POOL_MANAGER_ABI, ERC20_MIN_ABI, ERC20_TRANSFER_EVENT } from '../src/lib/launchpad/abi';
import { launchpad } from '../src/lib/launchpad/config';
import { TWIG_ADDRESS } from '../src/lib/launchpad/twig';
import { boostAmount } from '../src/lib/launchpad/boost';
export const F = process.env.NEXT_PUBLIC_LAUNCH_FACTORY!;
export const L = process.env.NEXT_PUBLIC_LAUNCH_LOCKER!;
export const PM = launchpad('base').v4.poolManager.toLowerCase();
export const A = '0x2222222222222222222222222222222222222222';
export const B = '0x6666666666666666666666666666666666666666';
export const CREATOR = '0x3333333333333333333333333333333333333333';
export const ALICE = '0x7777777777777777777777777777777777777777';
export const BOB = '0x8888888888888888888888888888888888888888';
export const ZERO = '0x0000000000000000000000000000000000000000';
export const DEAD = '0x000000000000000000000000000000000000dead';
export const hash = (label: string) => `0x${createHash('sha256').update(label).digest('hex')}` as Hex;
export const POOL = hash('pool-a');
export const POOL_B = hash('pool-b');
type EventArgs = Record<string, string | bigint | number | boolean>;
type LogFilter = {
    fromBlock?: Hex;
    toBlock?: Hex;
    address?: string | string[];
    topics?: readonly (Hex | readonly Hex[] | null)[];
};
export type EventInput = {
    address: string;
    abi: Abi;
    eventName: string;
    args: EventArgs;
    height: number;
    tx: string;
    index: number;
    from?: string;
    to?: string;
};
export function launched(height = 100, token = A, tx = 'common-launch', id = 1n): EventInput {
    return { address: F, abi: LAUNCH_FACTORY_ABI, eventName: 'Launched', height, tx, index: 0, from: CREATOR, to: F,
        args: { token, tokenId: id, launcher: CREATOR, quote: ZERO, poolId: token === A ? POOL : POOL_B, startTick: 0, lpFee: 10000, supply: 1000000n, metadataURI: 'ipfs://audit' } };
}
export function transfer(height: number, token: string, from: string, to: string, value: bigint, tx: string, index: number): EventInput {
    return { address: token, abi: [ERC20_TRANSFER_EVENT], eventName: 'Transfer', height, tx, index, from, to: token, args: { from, to, value } };
}
export function swap(height: number, amount: bigint, tx: string, token = A): EventInput {
    return { address: PM, abi: POOL_MANAGER_ABI, eventName: 'Swap', height, tx, index: 2, from: ALICE, to: PM,
        args: { id: token === A ? POOL : POOL_B, sender: ALICE, amount0: -amount, amount1: amount * 10n, sqrtPriceX96: 100n + amount, liquidity: 1000n, tick: Number(amount), fee: 10000 } };
}
export function fee(height: number, eventName: 'Collected' | 'Burned' | 'Paid' | 'Credited' | 'Claimed', args: EventArgs, index: number): EventInput {
    return { address: L, abi: LAUNCH_LOCKER_ABI, eventName, height, tx: `old-fees`, index, from: ALICE, to: L, args };
}
export function boost(height: number, tx = 'old-boost'): EventInput {
    return transfer(height, TWIG_ADDRESS, ALICE, DEAD, boostAmount(100000n, 1n), tx, 0);
}
export class ChainModel {
    branch = 'old';
    fork = 101;
    head = 104;
    finalized = 100;
    events: Record<string, EventInput[]> = {};
    calls: string[] = [];
    failMethod: string | null = null;
    beforeRequest: ((method: string, params: readonly unknown[]) => Promise<void>) | null = null;
    blockHash(height: number, branch = this.branch) { return hash(height < this.fork ? `common-block-${height}` : `${branch}-block-${height}`); }
    block(height: number, branch = this.branch) { return { number: toHex(height), hash: this.blockHash(height, branch), parentHash: this.blockHash(height - 1, branch), timestamp: toHex(1700000000 + height * 2), transactions: [], gasLimit: '0x1000000', gasUsed: '0x0', baseFeePerGas: '0x1', difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x1', nonce: '0x0000000000000000', miner: ZERO, receiptsRoot: hash('receipts'), stateRoot: hash('state'), transactionsRoot: hash('transactions'), logsBloom: `0x${'00'.repeat(256)}`, sha3Uncles: hash('uncles'), uncles: [] }; }
    log(e: EventInput, branch = this.branch) {
        const event = e.abi.find((item): item is AbiEvent => item.type === 'event' && item.name === e.eventName);
        if (!event) throw new Error(`Unknown fixture event ${e.eventName}`);
        const inputs = event.inputs.filter(input => !input.indexed);
        return {
            address: e.address,
            topics: encodeEventTopics({ abi: e.abi, eventName: e.eventName, args: e.args }),
            data: encodeAbiParameters(inputs, inputs.map(input => e.args[input.name!])),
            blockNumber: toHex(e.height),
            blockHash: this.blockHash(e.height, branch),
            transactionHash: hash(e.tx),
            transactionIndex: '0x0',
            logIndex: toHex(e.index),
            removed: false,
        };
    }
    current() { return this.events[this.branch] ?? []; }
    receipt(tx: string) {
        const events = this.current().filter(e => hash(e.tx).toLowerCase() === tx.toLowerCase());
        if (!events.length)
            return null;
        const e = events[0];
        return { transactionHash: hash(e.tx), status: '0x1', blockHash: this.blockHash(e.height), blockNumber: toHex(e.height), transactionIndex: '0x0', from: e.from ?? ALICE, to: e.to ?? e.address, cumulativeGasUsed: '0x1', gasUsed: '0x1', logsBloom: `0x${'00'.repeat(256)}`, logs: events.map(x => this.log(x)), type: '0x2', effectiveGasPrice: '0x1', contractAddress: null };
    }
    async request(method: string, params: readonly unknown[]) {
        this.calls.push(method);
        if (this.beforeRequest)
            await this.beforeRequest(method, params);
        if (this.failMethod === method) {
            this.failMethod = null;
            throw Error('Injected local RPC failure');
        }
        if (method === 'eth_chainId')
            return '0x2105';
        if (method === 'eth_blockNumber')
            return toHex(this.head);
        if (method === 'eth_getBlockByNumber') {
            const tag = params[0] as string;
            const n = tag === 'latest' ? this.head : tag === 'safe' || tag === 'finalized' ? this.finalized : Number(BigInt(tag));
            return n > this.head ? null : this.block(n);
        }
        if (method === 'eth_getBlockByHash') {
            for (let n = 99; n <= this.head; n++)
                if (this.blockHash(n) === params[0])
                    return this.block(n);
            return null;
        }
        if (method === 'eth_getTransactionReceipt')
            return this.receipt(params[0] as string);
        if (method === 'eth_getTransactionByHash') {
            const r = this.receipt(params[0] as string);
            return r ? { hash: r.transactionHash, from: r.from, to: r.to, blockHash: r.blockHash, blockNumber: r.blockNumber, transactionIndex: '0x0', input: '0x', value: '0x0', nonce: '0x0', gas: '0x5208', gasPrice: '0x1', type: '0x2', chainId: '0x2105', v: '0x1', r: hash('r'), s: hash('s') } : null;
        }
        if (method === 'eth_getLogs') {
            const f = params[0] as LogFilter;
            const lo = f.fromBlock ? Number(BigInt(f.fromBlock)) : 0;
            const hi = f.toBlock ? Number(BigInt(f.toBlock)) : this.head;
            const addresses = f.address ? (Array.isArray(f.address) ? f.address : [f.address]).map((s: string) => s.toLowerCase()) : null;
            return this.current().filter(e => e.height >= lo && e.height <= hi).map(e => this.log(e)).filter(log =>
                (!addresses || addresses.includes(log.address.toLowerCase())) &&
                (!f.topics || f.topics.every((want, i) => want == null ||
                    (typeof want === 'string' ? [want] : want).some(topic => {
                        const observed = log.topics[i];
                        return typeof observed === 'string' && topic.toLowerCase() === observed.toLowerCase();
                    }))));
        }
        if (method === 'eth_call') {
            const data = (params[0] as { data: string }).data;
            if (data === '0x06fdde03')
                return encodeFunctionResult({ abi: ERC20_MIN_ABI, functionName: 'name', result: 'Audit Token' });
            if (data === '0x95d89b41')
                return encodeFunctionResult({ abi: ERC20_MIN_ABI, functionName: 'symbol', result: 'AUD' });
            return encodeFunctionResult({ abi: LAUNCH_LOCKER_ABI, functionName: 'recipientsOf', result: [] });
        }
        throw Error('Unexpected synthetic RPC ' + method);
    }
    client() {
        return createPublicClient({
            chain: base,
            cacheTime: 0,
            transport: custom({ request: ({ method, params }) => this.request(method, params ?? []) }, { retryCount: 0 }),
        });
    }
}
export function standardModel() {
    const m = new ChainModel();
    const common = [launched(), transfer(100, A, ZERO, PM, 1000000n, 'common-launch', 1)];
    m.events.old = [...common, transfer(101, A, PM, ALICE, 50n, 'old-swap', 1), swap(101, 5n, 'old-swap'),
        fee(102, 'Collected', { tokenId: 1n, token: A, quoteAmount: 7n, tokenAmount: 3n }, 0),
        fee(102, 'Burned', { tokenId: 1n, currency: ZERO, amount: 2n }, 1),
        fee(102, 'Burned', { tokenId: 1n, currency: A, amount: 1n }, 2),
        fee(102, 'Paid', { tokenId: 1n, account: ALICE, currency: ZERO, amount: 5n }, 3), boost(102),
        launched(102, B, 'orphan-launch', 2n), transfer(102, B, ZERO, PM, 1000000n, 'orphan-launch', 1)];
    m.events.new = [...common, transfer(101, A, PM, BOB, 20n, 'new-swap', 1), swap(101, 2n, 'new-swap')];
    return m;
}
