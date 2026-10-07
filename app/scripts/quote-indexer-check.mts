/** Local-only integration check. Run against an empty disposable database with tsconfig.json (real DB module). */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { encodeAbiParameters, encodeEventTopics, parseEventLogs, type Abi, type AbiEvent, type Address, type Hex, type Log } from "viem";
if (!process.env.QUOTE_TEST_DATABASE_URL || new URL(process.env.QUOTE_TEST_DATABASE_URL).hostname !== "127.0.0.1") throw new Error("Set QUOTE_TEST_DATABASE_URL to a disposable database on 127.0.0.1");
process.env.DATABASE_URL = process.env.QUOTE_TEST_DATABASE_URL;
const factory="0x000000000000000000000000000000000000a001", locker="0x000000000000000000000000000000000000a002", vault="0x000000000000000000000000000000000000a003", hook="0x00000000000000000000000000000000000020cc";
const legacyFactory="0x000000000000000000000000000000000000a101", legacyLocker="0x000000000000000000000000000000000000a102";
Object.assign(process.env,{ NEXT_PUBLIC_QUOTE_FACTORY:factory,NEXT_PUBLIC_QUOTE_LOCKER:locker,NEXT_PUBLIC_QUOTE_VAULT:vault,NEXT_PUBLIC_QUOTE_HOOK:hook,NEXT_PUBLIC_QUOTE_DEPLOY_BLOCK:"1",NEXT_PUBLIC_QUOTE_LAUNCH_ENABLED:"true",NEXT_PUBLIC_LAUNCH_FACTORY:legacyFactory,NEXT_PUBLIC_LAUNCH_LOCKER:legacyLocker,LAUNCH_DEPLOY_BLOCK:"1" });
const [{db},{publicClient},{QUOTE_FACTORY_ABI,QUOTE_HOOK_ABI,QUOTE_VAULT_ABI},{POOL_MANAGER_ABI,LAUNCH_FACTORY_ABI,LAUNCH_LOCKER_ABI},{applyLaunchTx,pollLaunches},{walletQuoteFees},{launchpad}] = await Promise.all([
  import("../src/lib/db"),import("../src/lib/chain"),import("../src/lib/launchpad/quote-abi"),import("../src/lib/launchpad/abi"),import("../src/lib/launchpad/indexer"),import("../src/lib/launchpad/queries"),import("../src/lib/launchpad/config")]);
const sql=db();
const client=publicClient("base");
const token="0x000000000000000000000000000000000000ffff" as Address, quote="0x0000000000000000000000000000000000000000" as Address, wallet="0x000000000000000000000000000000000000b001" as Address;
const legacyToken="0x000000000000000000000000000000000000fff1" as Address;
const pool=`0x${"1".repeat(64)}` as Hex, hash=`0x${"2".repeat(64)}` as Hex;
function event(abi: Abi,name: string,address: Address,args: Record<string,unknown>,index: number): Log {
  const e=abi.find((a)=>a.type==="event" && a.name===name) as AbiEvent;
  const fields=e.inputs.filter((i)=>!i.indexed);
  return { address,topics:encodeEventTopics({abi:[e],eventName:name,args}),data:encodeAbiParameters(fields,fields.map((i)=>args[i.name!])),blockNumber:2n,blockHash:hash,transactionHash:hash,transactionIndex:0,logIndex:index,removed:false } as Log;
}
let logs=[
 event(QUOTE_FACTORY_ABI,"QuoteLaunched",factory,{token,tokenId:1n,launcher:wallet,quote,poolId:pool,startTick:184200,creatorFeePips:10000,supply:1000000000n*10n**18n,metadataURI:""},0),
 event(POOL_MANAGER_ABI,"Swap",launchpad("base").v4.poolManager,{id:pool,sender:wallet,amount0:-99n,amount1:1000n,sqrtPriceX96:2n**96n,liquidity:1n,tick:1,fee:0},1),
 event(QUOTE_HOOK_ABI,"QuoteSwap",hook,{poolId:pool,executor:wallet,zeroForOne:true,exactInput:true,quoteFee:1n,amount0:-100n,amount1:1000n},2),
 event(QUOTE_VAULT_ABI,"Credited",vault,{tokenId:1n,account:wallet,currency:quote,amount:1n},4),
 event(QUOTE_VAULT_ABI,"Collected",vault,{tokenId:1n,token,quoteAmount:1n,tokenAmount:0n},5),
];
client.getTransactionReceipt=async()=>({status:"success",logs}) as Awaited<ReturnType<typeof client.getTransactionReceipt>>;
client.getBlock=async()=>({timestamp:123n}) as Awaited<ReturnType<typeof client.getBlock>>;
client.getTransaction=async()=>({from:wallet}) as Awaited<ReturnType<typeof client.getTransaction>>;
client.readContract=(async (p: {functionName: string})=> p.functionName==="name"?"Quote":p.functionName==="symbol"?"QT":[{payout:wallet,bps:10000}]) as typeof client.readContract;
client.getBlockNumber=async()=>4n;
client.getLogs=(async (p: {address: string | string[];fromBlock: bigint;toBlock: bigint})=>parseEventLogs({abi:[...QUOTE_FACTORY_ABI,...QUOTE_HOOK_ABI,...QUOTE_VAULT_ABI,...POOL_MANAGER_ABI,...LAUNCH_FACTORY_ABI,...LAUNCH_LOCKER_ABI],logs:logs.filter((l)=>(Array.isArray(p.address)?p.address:[p.address]).some((a)=>l.address.toLowerCase()===a.toLowerCase()) && l.blockNumber!>=p.fromBlock && l.blockNumber!<=p.toBlock)})) as typeof client.getLogs;
try {
  const schema=await readFile(new URL("../db/schema.sql",import.meta.url),"utf8");
  await sql.begin((tx)=>tx.unsafe(schema)); await sql.begin((tx)=>tx.unsafe(schema));
  assert.equal((await sql`SELECT count(*) AS n FROM bb_launches`)[0].n,0n,"use an empty test database");
  const first=await applyLaunchTx("base",hash); assert.deepEqual([first.launches,first.swaps,first.fees],[1,1,2]);
  const retry=await applyLaunchTx("base",hash); assert.deepEqual([retry.launches,retry.swaps,retry.fees],[0,0,0]);
  const [launch]=await sql`SELECT * FROM bb_launches WHERE token=${token}`;
  assert.equal(launch.suite_id,"quote-v2"); assert.equal(launch.fee_contract_address,vault); assert.equal(launch.hook_address,hook); assert.equal(launch.pool_fee_pips,0); assert.equal(launch.lp_fee,10000);
  assert.equal(launch.volume_quote,"100"); assert.equal(launch.fees_quote_accrued,"1"); assert.equal(launch.fees_quote_collected,"1");
  const [swap]=await sql`SELECT * FROM bb_launch_swaps`; assert.equal(swap.amount0,"-99"); assert.equal(swap.trader_amount0,"-100"); assert.equal(swap.quote_fee,"1");
  assert.equal((await walletQuoteFees(wallet)).get(`8453:${token}`),undefined,"credits have not been paid");
  // Both suites can own the same NFT ID; only the emitting contract identifies its launch.
  logs = [
    event(LAUNCH_FACTORY_ABI,"Launched",legacyFactory,{token:legacyToken,tokenId:1n,launcher:wallet,quote,poolId:`0x${"3".repeat(64)}`,startTick:184200,lpFee:10000,supply:1000000000n*10n**18n,metadataURI:""},7),
    event(LAUNCH_LOCKER_ABI,"Collected",legacyLocker,{tokenId:1n,token:legacyToken,quoteAmount:7n,tokenAmount:0n},8),
    event(LAUNCH_LOCKER_ABI,"Paid",legacyLocker,{tokenId:1n,account:wallet,currency:quote,amount:7n},9),
    event(LAUNCH_LOCKER_ABI,"Credited",legacyLocker,{account:wallet,currency:quote,amount:2n},10),
    event(LAUNCH_LOCKER_ABI,"Claimed",legacyLocker,{account:wallet,currency:quote,amount:2n},11),
  ];
  const legacy=await applyLaunchTx("base",hash);
  assert.deepEqual([legacy.launches,legacy.swaps,legacy.fees],[1,0,4]);
  assert.equal((await sql`SELECT fees_quote_collected FROM bb_launches WHERE token=${legacyToken}`)[0].fees_quote_collected,"7");
  assert.equal((await sql`SELECT fees_quote_collected FROM bb_launches WHERE token=${token}`)[0].fees_quote_collected,"1");
  assert.equal((await walletQuoteFees(wallet)).get(`8453:${token}`),undefined);
  assert.equal((await sql`SELECT token FROM bb_launch_fee_events WHERE kind='paid' AND fee_contract_address=${legacyLocker}`)[0].token,legacyToken);
  assert.equal((await sql`SELECT count(*) AS n FROM bb_launch_fee_events WHERE fee_contract_address IS NULL`)[0].n,0n);
  logs=[event(QUOTE_VAULT_ABI,"Claimed",vault,{tokenId:1n,account:wallet,currency:quote,amount:1n},6)];
  await applyLaunchTx("base",hash); await applyLaunchTx("base",hash);
  assert.equal((await walletQuoteFees(wallet)).get(`8453:${token}`),"1");
  // A chain cursor ahead of the new factory must not skip its backfill.
  await sql`UPDATE bb_launches SET factory_address=NULL,locker_address=NULL,fee_contract_address=NULL WHERE token=${legacyToken}`;
  await sql`INSERT INTO bb_launch_sync_cursor (chain_id,cursor_block) VALUES(8453,100) ON CONFLICT(chain_id) DO UPDATE SET cursor_block=100`;
  await pollLaunches("base");
  const [cursor]=await sql`SELECT * FROM bb_launch_suite_cursor WHERE suite_id='quote-v2'`;
  assert.equal(cursor.cursor_block,2n);
  // The chain cursor follows the slowest suite (lp-v1 inherited 100), so health lag shows the backfill.
  assert.equal((await sql`SELECT cursor_block FROM bb_launch_sync_cursor WHERE chain_id=8453`)[0].cursor_block,2n);
  const [migrated]=await sql`SELECT factory_address,locker_address,fee_contract_address FROM bb_launches WHERE token=${legacyToken}`;
  assert.deepEqual(migrated,{factory_address:legacyFactory,locker_address:legacyLocker,fee_contract_address:legacyLocker});
  console.log("quote indexer: schema replay, dedupe, trader amounts, suite isolation, credit/claim earnings and cursor migration passed");
} finally { await sql.end(); }
