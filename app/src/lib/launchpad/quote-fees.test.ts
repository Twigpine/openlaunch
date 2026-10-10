import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, decodeFunctionData, zeroAddress } from "viem";
import { QUOTE_FACTORY_ABI, QUOTE_VAULT_ABI } from "./quote-abi.ts";
import { poolKeyForLaunch, feeContractForLaunch, lockerForLaunch, isQuoteFeeLaunch } from "./suites.ts";
import { earnedSides } from "./creator.ts";
import { validateMeta } from "./metaShared.ts";
const token="0x000000000000000000000000000000000000ffff", hook="0x00000000000000000000000000000000000020cc", vault="0x000000000000000000000000000000000000aaaa";
test("quote launches use stored zero LP fee and hook; legacy keeps its LP rate",()=>{
  const base={quote:zeroAddress,token,lp_fee:10000};
  assert.equal(poolKeyForLaunch(base).fee,10000); assert.equal(poolKeyForLaunch(base).hooks,zeroAddress);
  const key=poolKeyForLaunch({...base,pool_fee_pips:0,hook_address:hook}); assert.equal(key.fee,0); assert.equal(key.hooks,hook);
  assert.equal(feeContractForLaunch({chain:"base",suite_id:"quote-v2",fee_contract_address:vault}),vault);
  assert.equal(isQuoteFeeLaunch({suite_id:"quote-v2"}),true);
});
test("quote factory launch selector matches the tuple layout with a creator fee",()=>{
  const data=encodeFunctionData({abi:QUOTE_FACTORY_ABI,functionName:"launch",args:[{name:"Quote",symbol:"QT",metadataURI:"",quote:zeroAddress,supply:0n,startTick:184200,creatorFeePips:30000,salt:`0x${"a".repeat(64)}`,recipients:[]}]});
  const decoded=decodeFunctionData({abi:QUOTE_FACTORY_ABI,data}); assert.equal(decoded.functionName,"launch");
  if(decoded.functionName==="launch") assert.equal(decoded.args[0].creatorFeePips,30000);
});
test("vault claims are per launch, with a uint256 token ID",()=>{
  const data=encodeFunctionData({abi:QUOTE_VAULT_ABI,functionName:"claim",args:[123n]});
  assert.deepEqual(decodeFunctionData({abi:QUOTE_VAULT_ABI,data}).args,[123n]);
});
test("metadata accepts a known suite and rejects arbitrary deployments",()=>{
  const meta={chain:"base" as const,launcher:token,salt:`0x${"a".repeat(64)}` as const,name:"Quote",symbol:"QT"};
  assert.equal(validateMeta({...meta,suite_id:"quote-v2"}).ok,true);
  assert.equal(validateMeta({...meta,suite_id:"unknown" as "quote-v2"}).ok,false);
});
test("wallet quote earnings use indexed payments, including partial burns and credits",()=>{
  const totals={fees_quote_collected:"100",fees_quote_burned:"40",fees_token_collected:"0",fees_token_burned:"0",wallet_fees_quote_paid:"60"};
  assert.deepEqual(earnedSides(totals,6000),{quote:60n,token:0n});
  assert.deepEqual(earnedSides({...totals,wallet_fees_quote_paid:"0"},6000),{quote:0n,token:0n});
});

test("quote pool identity fails closed when its hook or actual pool fee is missing",()=>{
  assert.throws(()=>poolKeyForLaunch({suite_id:"quote-v2",quote:zeroAddress,token,lp_fee:10000}));
  assert.throws(()=>poolKeyForLaunch({suite_id:"quote-v2",quote:zeroAddress,token,lp_fee:10000,pool_fee_pips:0,hook_address:vault}));
  assert.throws(()=>poolKeyForLaunch({suite_id:"unknown",quote:zeroAddress,token,lp_fee:10000}));
  assert.equal(feeContractForLaunch({chain:"base",suite_id:"quote-v2"}),null);
  assert.equal(feeContractForLaunch({chain:"base",suite_id:"lp-v1",fee_contract_address:zeroAddress}),null);
  assert.equal(feeContractForLaunch({chain:"base",suite_id:"unknown"}),null);
});

test("the launch form derives the first-buy pool key from the suite, with no RPC read", () => {
  // The same fields LaunchForm passes right after the launch receipt.
  const form = { quote: zeroAddress, token, lp_fee: 10000 };
  assert.deepEqual(poolKeyForLaunch({ ...form, suite_id: "quote-v2", pool_fee_pips: 0, hook_address: hook }), { currency0: zeroAddress, currency1: token, fee: 0, tickSpacing: 200, hooks: hook });
  assert.deepEqual(poolKeyForLaunch({ ...form, suite_id: "lp-v1", pool_fee_pips: 10000, hook_address: zeroAddress }), { currency0: zeroAddress, currency1: token, fee: 10000, tickSpacing: 200, hooks: zeroAddress });
});

test("a launch's locker is the one its own suite deployed", () => {
  const locker = "0x000000000000000000000000000000000000bbbb";
  assert.equal(lockerForLaunch({ chain: "base", suite_id: "quote-v2", locker_address: locker }), locker);
  // A quote-only launch never falls back to the original deployment's locker.
  assert.equal(lockerForLaunch({ chain: "base", suite_id: "quote-v2" }), null);
  assert.equal(lockerForLaunch({ chain: "base", suite_id: "lp-v1", locker_address: zeroAddress }), null);
  assert.equal(lockerForLaunch({ chain: "base", suite_id: "unknown" }), null);
});
