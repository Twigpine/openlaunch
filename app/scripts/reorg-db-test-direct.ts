import assert from 'node:assert/strict';
import { rollbackChain, replayValue, type ReplayKind, type ReplayPayload } from '../src/lib/launchpad/indexer-reorg-db';
import { recordPairBurn } from '../src/lib/launchpad/pairApplyServer';
import { A, B, ALICE, CREATOR, PM, DEAD, ZERO, hash } from './reorg-db-test-model';
import type { Db } from './reorg-db-test-db';
import type { ReorgCheckContext } from './reorg-db-test-suite';
type ArchiveRow = {
    kind: ReplayKind;
    payload: ReplayPayload;
    block_number: bigint;
    block_time: string;
    block_hash: string;
    tx_hash: string;
    log_index: number;
    usd: number | null;
    priced_by: string | null;
};
export async function directChecks({ check, indexedOld }: ReorgCheckContext) {
    async function rollback(db: Db) {
        await db.begin(async (t) => {
            await t `SELECT pg_advisory_xact_lock(hashtext('launch-index:base'))`;
            await rollbackChain(t as unknown as Db, 'base', 101n, 'reorg', 104n);
        });
    }
    await check('direct rollback reconstructs empty market state and retained fees and holders', async () => {
        const { db } = await indexedOld('directtotals');
        const time = new Date(1700000200 * 1000).toISOString();
        await db `UPDATE bb_launches SET holders_synced_block=102 WHERE token=${A}`;
        await db `INSERT INTO bb_token_transfers (chain_id,token,tx_hash,log_index,from_addr,to_addr,value,block_number,block_time)
      VALUES(8453,${A},${hash('retained-holder')},0,${PM},${ALICE},9,100,${time}),
            (8453,${A},${hash('retained-dead')},0,${ALICE},${DEAD},1,100,${time})`;
        await db `INSERT INTO bb_launch_fee_events (chain_id,tx_hash,log_index,kind,token_id,token,currency,quote_amount,token_amount,amount,block_number,block_time,usd)
      VALUES(8453,${hash('retained-fees')},0,'collected',1,${A},NULL,4,2,NULL,100,${time},8),
            (8453,${hash('retained-fees')},1,'burned',1,${A},${ZERO},NULL,NULL,1,100,${time},2),
            (8453,${hash('orphan-claim')},0,'claimed',NULL,NULL,${ZERO},NULL,NULL,3,102,${time},NULL),
            (8453,${hash('orphan-claim')},1,'credited',NULL,NULL,${ZERO},NULL,NULL,4,102,${time},NULL)`;
        await rollback(db);
        const [l] = await db `SELECT sqrt_price_x96,tick,start_tick,last_swap_block,last_swap_log,volume_quote::text,volume_usd,buys,sells,
      fees_quote_collected::text,fees_token_collected::text,fees_quote_burned::text,fees_collected_usd,fees_burned_usd,holders,holders_synced_block
      FROM bb_launches WHERE token=${A}`;
        assert.equal(l.sqrt_price_x96, null);
        assert.equal(l.tick, l.start_tick);
        assert.equal(BigInt(l.last_swap_block), 0n);
        assert.equal(l.last_swap_log, 0);
        assert.equal(l.volume_quote, '0');
        assert.equal(l.volume_usd, 0);
        assert.equal(l.buys, 0);
        assert.equal(l.sells, 0);
        assert.equal(l.fees_quote_collected, '4');
        assert.equal(l.fees_token_collected, '2');
        assert.equal(l.fees_quote_burned, '1');
        assert.equal(l.fees_collected_usd, 8);
        assert.equal(l.fees_burned_usd, 2);
        assert.equal(l.holders, 1);
        assert.equal(BigInt(l.holders_synced_block), 100n);
        assert.equal((await db `SELECT * FROM bb_launch_fee_events WHERE token IS NULL`).length, 0);
        const rows = await db `SELECT holder,balance::text,first_block,last_block FROM bb_token_holders WHERE token=${A} ORDER BY holder`;
        assert.equal(rows.find(x => x.holder === ALICE)?.balance, '8');
        assert.equal(rows.find(x => x.holder === DEAD)?.balance, '1');
        for (const r of rows) {
            assert.equal(BigInt(r.first_block), 100n);
            assert.equal(BigInt(r.last_block), 100n);
        }
        assert.equal((await db `SELECT * FROM bb_launches WHERE token=${B}`).length, 0);
        return { retainedHolders: rows.length, launch: l };
    });
    await check('valuation archive preserves large integer identity and rejects changed event placement or payload', async () => {
        const { db, model } = await indexedOld('journal');
        const huge = '900719925474099312345678901234567890';
        await db `UPDATE bb_launch_swaps SET amount0=${'-' + huge},amount1=${huge},sqrt_price_x96=${huge},usd=12.75 WHERE true`;
        await db `UPDATE bb_launch_fee_events SET quote_amount=${huge},token_amount=${huge},usd=3.25 WHERE kind='collected'`;
        await db `INSERT INTO bb_pair_burns (chain_id,tx_hash,log_index,application_id,sender,twig,usd,priced_by,block_number,block_time)
      VALUES(8453,${hash('journal-pair')},0,9007199254740993,${ALICE},${huge},200,'quote',102,${new Date(1700000204 * 1000).toISOString()})`;
        await rollback(db);
        const archive = await db<ArchiveRow[]> `SELECT * FROM bb_launch_replay_values ORDER BY kind,log_index`;
        const swap = archive.find(r => r.kind === 'swap');
        const fee = archive.find(r => r.kind === 'fee' && r.payload.kind === 'collected');
        const pair = archive.find(r => r.kind === 'pair');
        assert.ok(swap && fee && pair, 'all three valuation kinds were archived');
        assert.equal(swap.payload.amount0, '-' + huge);
        assert.equal(swap.payload.amount1, huge);
        assert.equal(swap.payload.sqrt_price_x96, huge);
        assert.equal(fee.payload.quote_amount, huge);
        assert.equal(pair.payload.application_id, '9007199254740993');
        assert.equal(pair.payload.twig, huge);
        for (const row of [swap, fee, pair]) {
            const invoke = (bn = row.block_number, time: string | Date = row.block_time, bh = row.block_hash, payload = row.payload) =>
                replayValue(db, 'base', row.kind, row.tx_hash, row.log_index, bn, time, bh, payload);
            assert.deepEqual(await invoke(), { usd: row.usd, priced_by: row.priced_by, ...(row.kind === 'pair' ? { valuation_pending: false } : {}) });
            assert.equal(await invoke(BigInt(row.block_number) + 1n), null);
            assert.equal(await invoke(row.block_number, new Date(new Date(row.block_time).getTime() + 2000)), null);
            assert.equal(await invoke(row.block_number, row.block_time, hash('changed block')), null);
            const key = row.kind === 'swap' ? 'amount1' : row.kind === 'fee' ? 'quote_amount' : 'twig';
            assert.equal(await invoke(row.block_number, row.block_time, row.block_hash, { ...row.payload, [key]: '1' }), null);
            if (row.kind === 'fee')
                assert.equal(await invoke(row.block_number, row.block_time, row.block_hash, { ...row.payload, quote: A }), null, 'fee valuation cannot be reused under a different quote-token context');
        }
        await db `UPDATE bb_launch_replay_values SET block_hash=NULL WHERE kind='swap'`;
        assert.equal((await replayValue(db, 'base', 'swap', swap.tx_hash, swap.log_index, 101n, swap.block_time, model.blockHash(101), swap.payload))?.usd, 12.75);
        const changed = { tx_hash: hash('journal-pair'), log_index: 0, application_id: 1, sender: ALICE, whole: '200', block_number: '104' };
        const changedTime = new Date(1700000208 * 1000), changedHash = hash('re-included-pair-block');
        await db.begin(async (t) => {
            await t `SELECT pg_advisory_xact_lock(hashtext('launch-index:base'))`;
            await recordPairBurn('base', changed, changedTime, t as unknown as Db, changedHash);
        });
        assert.equal((await db `SELECT valuation_pending FROM bb_pair_burns WHERE tx_hash=${changed.tx_hash}`)[0].valuation_pending, true);
        await db `INSERT INTO bb_launch_blocks (chain_id,block_number,block_hash) VALUES(8453,104,${changedHash})`;
        await rollback(db);
        await db.begin(async (t) => {
            await t `SELECT pg_advisory_xact_lock(hashtext('launch-index:base'))`;
            await recordPairBurn('base', changed, changedTime, t as unknown as Db, changedHash);
        });
        const [again] = await db `SELECT usd,priced_by,valuation_pending FROM bb_pair_burns WHERE tx_hash=${changed.tx_hash}`;
        assert.equal(again.usd, null);
        assert.equal(again.priced_by, null);
        assert.equal(again.valuation_pending, true, 'repeated rollback/replay cannot clear a previously unresolved historical valuation');
        return { checkedKinds: 3, largeInteger: huge, archiveRows: archive.length };
    });
    await check('rollback invalidates season snapshots and recomputes cross-chain application payment without overwriting decisions', async () => {
        const { db } = await indexedOld('dependents');
        const statuses = ['paid', 'approved', 'changes', 'rejected', 'open', 'paid'];
        for (let i = 0; i < statuses.length; i++) {
            const id = i + 1, address = '0x' + String(id).padStart(40, '0');
            await db `INSERT INTO bb_pair_applications (id,chain_id,address,applicant,code,symbol,name,decimals,price_kind,price_pool,price_quote,precheck,status,fee_usd,paid_usd,paid_at,reviews_used,reason,decided_by,created_at)
        VALUES(${id},4663,${address},${CREATOR},${'AUD-' + id},'AUD','Authored application',18,'v4',${hash('pair-pool')},${ZERO},'{}',${statuses[i]},200,250,'2026-01-01',2,'Keep decision',${CREATOR},'2026-01-01')`;
            if (i < 4)
                await db `INSERT INTO bb_pair_burns (chain_id,tx_hash,log_index,application_id,sender,twig,usd,priced_by,block_number,block_time)
        VALUES(8453,${hash('orphan-app-' + id)},0,${id},${ALICE},200,200,'live',102,'2026-01-01'),
              (4663,${hash('retained-app-' + id)},0,${id},${ALICE},50,50,'live',99,'2026-01-01')`;
            if (i === 5)
                await db `INSERT INTO bb_pair_burns (chain_id,tx_hash,log_index,application_id,sender,twig,usd,priced_by,block_number,block_time,valuation_pending)
        VALUES(8453,${hash('orphan-pending-app')},0,${id},${ALICE},1,1,'live',102,'2026-01-01',false),
              (8453,${hash('retained-pending-app')},0,${id},${ALICE},1,NULL,NULL,100,'2026-01-01',true),
              (4663,${hash('retained-funded-app')},0,${id},${ALICE},250,250,'live',99,'2026-01-01',false)`;
        }
        await db `INSERT INTO bb_seasons (id,slug,name,starts_at,ends_at,public,computed_at,computed_until,published_at,rules_version,created_at)
      VALUES(1,'old','Finished season','2025-01-01','2025-02-01',true,'2025-02-02','2025-02-01','2025-01-01',2,'2025-01-01'),
            (2,'draft','Untouched draft','2026-01-01','2026-02-01',false,NULL,NULL,NULL,1,'2026-01-01')`;
        await db `INSERT INTO bb_points (season_id,wallet,creator,scout,total,eligible,computed_at) VALUES(1,${ALICE},20,30,50,true,'2025-02-02')`;
        await rollback(db);
        const apps = await db `SELECT id,status,paid_usd,paid_at,reviews_used,reason,decided_by,payment_reorg FROM bb_pair_applications ORDER BY id`;
        for (let i = 0; i < 4; i++) {
            const a = apps[i];
            assert.equal(a.status, i === 0 ? 'open' : statuses[i]);
            assert.equal(a.paid_usd, 50);
            assert.equal(a.payment_reorg, true);
            assert.equal(a.reviews_used, 2);
            assert.equal(a.reason, 'Keep decision');
            assert.equal(a.decided_by, CREATOR);
            if (i === 0)
                assert.equal(a.paid_at, null);
            else
                assert.notEqual(a.paid_at, null);
        }
        assert.equal(apps[4].paid_usd, 250);
        assert.equal(apps[4].payment_reorg, false);
        assert.equal(apps[4].status, 'open');
        assert.equal(apps[5].paid_usd, 250);
        assert.equal(apps[5].payment_reorg, true);
        assert.equal(apps[5].status, 'paid', 'a pending historical valuation remains flagged even when other retained burns cover the fee');
        assert.equal((await db `SELECT * FROM bb_points`).length, 0);
        const seasons = await db `SELECT * FROM bb_seasons ORDER BY id`;
        assert.notEqual(seasons[0].reorg_invalidated_at, null);
        assert.equal(seasons[0].computed_at, null);
        assert.equal(seasons[0].computed_until, null);
        assert.equal(seasons[0].rules_version, 2);
        assert.equal(seasons[0].public, true);
        assert.equal(seasons[0].slug, 'old');
        assert.notEqual(seasons[0].published_at, null);
        assert.equal(seasons[1].reorg_invalidated_at, null);
        assert.equal(seasons[1].public, false);
        return { applications: apps.length, invalidatedSeasons: 1 };
    });
}
