import { test } from "node:test";
import assert from "node:assert/strict";
import { pairQuoteSwaps, type QuoteSwapLog } from "./quote-swaps.ts";
const pool = "0xpool", hook = "0xhook";
const pools = new Map([[pool,hook]]);
const feeLog = (tx: string,index: number,amount0: bigint,amount1: bigint,quoteFee: bigint): QuoteSwapLog => ({ address: hook,transactionHash:tx,logIndex:index,args:{poolId:pool,amount0,amount1,quoteFee} });
test("pairs multiple buys/sells in one receipt, retaining core and trader amounts",()=>{
  const core=[{transactionHash:"tx",logIndex:2,args:{id:pool,amount0:-99n,amount1:10n}},{transactionHash:"tx",logIndex:5,args:{id:pool,amount0:50n,amount1:-5n}}];
  const fees=[feeLog("tx",3,-100n,10n,1n),feeLog("tx",6,49n,-5n,1n)];
  const paired=pairQuoteSwaps(core,fees,pools);
  assert.equal(paired.get("tx:2")?.args.amount0,-100n); assert.equal(paired.get("tx:5")?.args.amount0,49n);
});
test("rejects missing, forged or inconsistent hook events so the cursor retries",()=>{
  const core=[{transactionHash:"tx",logIndex:2,args:{id:pool,amount0:-99n,amount1:10n}}];
  assert.throws(()=>pairQuoteSwaps(core,[],pools));
  assert.throws(()=>pairQuoteSwaps(core,[{...feeLog("tx",3,-100n,10n,1n),address:"other"}],pools));
  assert.throws(()=>pairQuoteSwaps(core,[feeLog("tx",3,-100n,11n,1n)],pools));
  assert.throws(()=>pairQuoteSwaps(core,[feeLog("other",3,-100n,10n,1n)],pools));
});
test("legacy pools keep core accounting and require no hook event",()=>{
  assert.equal(pairQuoteSwaps([{transactionHash:"tx",logIndex:2,args:{id:"legacy",amount0:-100n,amount1:10n}}],[],pools).size,0);
});
