import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteDeployment } from "./quote-config.ts";
const configured=["0x000000000000000000000000000000000000a001","0x000000000000000000000000000000000000a002","0x000000000000000000000000000000000000a003","0x00000000000000000000000000000000000020cc","100","true"];
test("requires every address, positive deployment block and exact hook flags",()=>{
  assert.equal(quoteDeployment("base",configured)?.launchEnabled,true);
  for(let i=0;i<5;i++){const invalid=[...configured];invalid[i]="";assert.equal(quoteDeployment("base",invalid),null);}
  const bad=[...configured];bad[3]="0x000000000000000000000000000000000000ffff";assert.equal(quoteDeployment("base",bad),null);
  const off=[...configured];off[5]="false";assert.equal(quoteDeployment("base",off)?.launchEnabled,false);
});
