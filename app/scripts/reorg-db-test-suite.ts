import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { TestContext } from 'node:test';
import path from 'node:path';
import postgres from 'postgres';
import { setDb, type Db } from './reorg-db-test-db';
import { setClient } from './reorg-db-test-chain';
import * as indexer from '../src/lib/launchpad/indexer';
import { withCanonicalIndex } from '../src/lib/launchpad/indexer-canonical';
import { IndexLockBusyError } from '../src/lib/launchpad/indexer-lock';
import { A, B, CREATOR, ALICE, BOB, ZERO, standardModel, hash, type ChainModel } from './reorg-db-test-model';
import { BEFORE_EXECUTION_EVENT, USER_OPERATION_EVENT, ENTRY_POINTS } from '../src/lib/launchpad/attribution';
import { directChecks } from './reorg-db-test-direct';
import { indexerAuditDbChecks } from './indexer-audit-db-checks';
type Snapshot = Record<string, unknown[]>;
export type ReorgCheckContext = {
    check: (label: string, run: () => Promise<unknown>) => Promise<void>;
    indexedOld: (label: string) => Promise<{ db: Db; model: ChainModel }>;
};
export async function runReorgDbTests(t: TestContext, endpoint: string) {
    const admin = postgres(endpoint, { max: 1, onnotice: () => { } });
    const resources: {
        name: string;
        db: Db;
    }[] = [];
    const schemaNames = new WeakMap<Db, string>();
    // Scope legacy catalog existence checks to the owned schema. All actual table
    // definitions and migrations still come from the application's schema.sql.
    const schema = readFileSync(path.join(process.cwd(), 'db/schema.sql'), 'utf8')
        .replaceAll('FROM pg_constraint WHERE', 'FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND')
        .replaceAll('WHERE t.relname =', 'WHERE c.connamespace = current_schema()::regnamespace AND t.relname =');
    // Compare durable facts and derived accounting. Recovery journals/cursor status
    // intentionally record the replay journey, so their invariants are checked separately.
    const tables = ['bb_launches', 'bb_launch_swaps', 'bb_launch_fee_events', 'bb_token_transfers', 'bb_token_holders', 'bb_boosts', 'bb_pair_burns', 'bb_launch_meta', 'bb_posts'];
    async function database(label: string) {
        const name = 'reorg_security_' + label + '_' + randomBytes(8).toString('hex');
        assert.match(name, /^reorg_security_[a-z0-9_]+_[0-9a-f]{16}$/);
        await admin.unsafe(`CREATE SCHEMA "${name}"`);
        const db = postgres(endpoint, { max: 8, connection: { search_path: name, application_name: name }, types: { bigint: postgres.BigInt }, onnotice: () => { } }) as unknown as Db;
        resources.push({ name, db });
        schemaNames.set(db, name);
        await db.unsafe(schema);
        // One application process normally keeps one DB. Test fixtures switch DBs, so
        // give each an independent generation namespace for process-local caches.
        await db `UPDATE bb_launch_sync_cursor SET reorg_generation=${BigInt(resources.length) * 1000n} WHERE true`;
        await db `INSERT INTO bb_launch_meta (chain_id,token,launcher,name,symbol,description,created_at) VALUES(8453,${B},${CREATOR},'Authored name','USER','Keep this user content','2026-01-01T00:00:00Z')`;
        await db `INSERT INTO bb_posts (chain_id,token,wallet,body,signature,created_at) VALUES(8453,${B},${CREATOR},'Keep this signed post','synthetic-test-signature','2026-01-01T00:00:00Z')`;
        return db;
    }
    function activate(db: Db, model: ChainModel) {
        setDb(db);
        setClient(model.client());
    }
    async function snapshot(db: Db): Promise<Snapshot> {
        const out: Snapshot = {};
        for (const table of tables) {
            const rows = await db.unsafe<{ value: unknown }[]>(`SELECT to_jsonb(t) AS value FROM ${table} t`);
            out[table] = rows.map(r => r.value).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        }
        return out;
    }
    function differing(a: Snapshot, b: Snapshot) {
        return tables.filter(table => JSON.stringify(a[table]) !== JSON.stringify(b[table]));
    }
    async function check(label: string, run: () => Promise<unknown>) {
        await t.test(label, async () => { await run(); });
    }
    async function compareOracle(label: string, observed: Db, model: ChainModel) {
        const actual = await snapshot(observed), oracle = await database('oracle');
        activate(oracle, model);
        let sync: indexer.LaunchSyncResult | undefined;
        for (let i = 0; i < 6; i++) {
            sync = await indexer.pollLaunches('base');
            if (sync.caught_up)
                break;
        }
        assert.equal(sync?.caught_up, true, 'clean rebuild oracle must finish');
        const expected = await snapshot(oracle), differences = differing(actual, expected);
        assert.deepEqual(differences, [], `${label} differs from clean canonical rebuild`);
        return { differences };
    }
    async function indexedOld(label: string) {
        const db = await database(label), model = standardModel();
        activate(db, model);
        await indexer.pollLaunches('base');
        return { db, model };
    }
    async function main() {
        try {
            const observed = await database('observed'), oracle = await database('oracle');
            const model = standardModel();
            activate(observed, model);
            await check('full schema and normal canonical ingestion', async () => {
                const r = await indexer.pollLaunches('base');
                const [a] = await observed `SELECT volume_quote::text,buys,fees_quote_collected::text,fees_token_collected::text,fees_quote_burned::text,fees_token_burned::text,holders FROM bb_launches WHERE token=${A}`;
                assert.equal(a.volume_quote, '5');
                assert.equal(a.buys, 1);
                assert.equal(a.fees_quote_collected, '7');
                assert.equal(a.fees_quote_burned, '2');
                assert.equal((await observed `SELECT * FROM bb_boosts`).length, 1);
                assert.equal((await observed `SELECT * FROM bb_launches WHERE token=${B}`).length, 1);
                return { sync: r, launch: a };
            });
            const original = await snapshot(observed);
            await check('canonical replay is idempotent across real SQL aggregates', async () => {
                await indexer.pollLaunches('base');
                assert.deepEqual(await snapshot(observed), original);
                return {};
            });
            model.branch = 'new';
            await check('canonical replacement matches clean rebuild across swaps fees holders orphan launches and boosts', async () => {
                activate(observed, model);
                const result = await indexer.pollLaunches('base');
                const actual = await snapshot(observed);
                activate(oracle, model);
                await indexer.pollLaunches('base');
                const expected = await snapshot(oracle);
                const differences = differing(actual, expected);
                assert.deepEqual(actual, expected);
                assert.deepEqual(actual.bb_launch_meta, expected.bb_launch_meta);
                assert.deepEqual(actual.bb_posts, expected.bb_posts);
                return { expectedMode: 'fixed-equality', differences, sync: result };
            });
            const [{ ready }] = await observed `SELECT to_regclass('bb_launch_blocks') IS NOT NULL AS ready`;
            assert.equal(ready, true, 'reconciliation migration must be present');
            await check('orphan launch records recovery without deleting user-authored metadata or posts', async () => {
                const f = await indexedOld('tombstone');
                f.model.branch = 'new';
                activate(f.db, f.model);
                await indexer.pollLaunches('base');
                const recovery = await f.db `SELECT * FROM bb_launch_recovery WHERE chain_id=8453 AND token=${B}`;
                assert.equal(recovery.length, 1);
                assert.equal((await f.db `SELECT * FROM bb_launches WHERE token=${B}`).length, 0);
                assert.equal((await f.db `SELECT description FROM bb_launch_meta WHERE token=${B}`)[0].description, 'Keep this user content');
                assert.equal((await f.db `SELECT body FROM bb_posts WHERE token=${B}`)[0].body, 'Keep this signed post');
                return { recoveryReason: recovery[0].reason, ...await compareOracle('tombstone', f.db, f.model) };
            });
            await check('reorg older than overlap reconciles through retained checkpoints', async () => {
                const db = await database('deep'), m = standardModel();
                m.head = 200;
                activate(db, m);
                await indexer.pollLaunches('base');
                const [before] = await db `SELECT cursor_block FROM bb_launch_sync_cursor WHERE chain_id=8453`;
                assert.ok(BigInt(before.cursor_block) - 101n > 50n);
                m.branch = 'new';
                await indexer.pollLaunches('base');
                return compareOracle('deep', db, m);
            });
            await check('a changed earliest checkpoint replays from deployment without retaining orphan facts', async () => {
                const f = await indexedOld('firstanchor');
                f.model.fork = 100;
                f.model.branch = 'new';
                activate(f.db, f.model);
                await indexer.pollLaunches('base');
                return compareOracle('firstanchor', f.db, f.model);
            });
            await check('same transaction re-included at changed block and log indices counts only canonical position', async () => {
                const f = await indexedOld('moved');
                f.model.events.new = [...f.model.events.new.filter(e => e.height === 100), ...f.model.events.old.filter(e => e.tx === 'old-swap').map(e => ({ ...e, height: 104, index: e.index + 3 }))];
                f.model.head = 106;
                f.model.branch = 'new';
                activate(f.db, f.model);
                await indexer.pollLaunches('base');
                const rows = await f.db `SELECT block_number,log_index FROM bb_launch_swaps WHERE tx_hash=${hash('old-swap')}`;
                assert.equal(rows.length, 1);
                assert.equal(BigInt(rows[0].block_number), 104n);
                assert.equal(rows[0].log_index, 5);
                return compareOracle('moved', f.db, f.model);
            });
            await check('successful provisional receipt is reconciled when its branch is orphaned', async () => {
                const db = await database('receipt'), m = standardModel();
                m.head = 101;
                activate(db, m);
                await indexer.applyLaunchTx('base', hash('common-launch'));
                await indexer.applyLaunchTx('base', hash('old-swap'));
                assert.equal((await db `SELECT * FROM bb_launch_swaps`).length, 1);
                m.branch = 'new';
                m.head = 104;
                await indexer.pollLaunches('base');
                return compareOracle('receipt', db, m);
            });
            await check('legacy hashless history is rebuilt rather than certified against present hashes', async () => {
                const f = await indexedOld('legacy');
                await f.db `DELETE FROM bb_launch_blocks WHERE chain_id=8453`;
                await f.db `UPDATE bb_launch_sync_cursor SET reorg_version=0,cursor_block=198,head_block=200 WHERE chain_id=8453`;
                f.model.branch = 'new';
                f.model.head = 200;
                activate(f.db, f.model);
                await indexer.pollLaunches('base');
                const [cursor] = await f.db `SELECT reorg_version,rebuilding_until FROM bb_launch_sync_cursor WHERE chain_id=8453`;
                assert.ok(cursor.reorg_version > 0);
                return { cursor, ...await compareOracle('legacy', f.db, f.model) };
            });
            await check('bounded legacy rebuild resumes across calls and never stamps stale history as complete', async () => {
                const f = await indexedOld('bounded');
                await f.db `DELETE FROM bb_launch_blocks WHERE chain_id=8453`;
                await f.db `UPDATE bb_launch_sync_cursor SET reorg_version=0,cursor_block=49998,head_block=50000 WHERE chain_id=8453`;
                f.model.branch = 'new';
                f.model.head = 50000;
                activate(f.db, f.model);
                const first = await indexer.pollLaunches('base');
                const [intermediate] = await f.db `SELECT cursor_block,rebuilding_until FROM bb_launch_sync_cursor WHERE chain_id=8453`;
                assert.equal(first.caught_up, false);
                assert.ok(intermediate.rebuilding_until !== null && BigInt(intermediate.cursor_block) < BigInt(intermediate.rebuilding_until));
                f.model.head = 50002;
                let final: indexer.LaunchSyncResult | undefined;
                for (let i = 0; i < 5; i++) {
                    final = await indexer.pollLaunches('base');
                    if (final.caught_up)
                        break;
                }
                assert.equal(final?.caught_up, true);
                const [done] = await f.db `SELECT rebuilding_until FROM bb_launch_sync_cursor WHERE chain_id=8453`;
                assert.equal(done.rebuilding_until, null);
                return { first, intermediate, final, ...await compareOracle('bounded', f.db, f.model) };
            });
            await check('injected SQL failure rolls back reconciliation and retries to canonical oracle', async () => {
                const f = await indexedOld('sqlfailure'), before = await snapshot(f.db);
                const blocks = await f.db `SELECT * FROM bb_launch_blocks ORDER BY chain_id,block_number`;
                await f.db.unsafe(`CREATE FUNCTION audit_fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback fault'; END $$; CREATE TRIGGER audit_fail_delete AFTER DELETE ON bb_launch_swaps FOR EACH ROW EXECUTE FUNCTION audit_fail_delete()`);
                f.model.branch = 'new';
                activate(f.db, f.model);
                await assert.rejects(indexer.pollLaunches('base'), /synthetic rollback fault/);
                assert.deepEqual(await snapshot(f.db), before);
                assert.deepEqual(await f.db `SELECT * FROM bb_launch_blocks ORDER BY chain_id,block_number`, blocks);
                await f.db.unsafe('DROP TRIGGER audit_fail_delete ON bb_launch_swaps; DROP FUNCTION audit_fail_delete()');
                await indexer.pollLaunches('base');
                return compareOracle('sqlfailure', f.db, f.model);
            });
            await check('RPC outage during replacement does not leave partial derived accounting', async () => {
                const f = await indexedOld('rpcfailure'), before = await snapshot(f.db);
                f.model.branch = 'new';
                f.model.failMethod = 'eth_getLogs';
                activate(f.db, f.model);
                await assert.rejects(indexer.pollLaunches('base'), /Injected local RPC failure/);
                assert.deepEqual(await snapshot(f.db), before);
                await indexer.pollLaunches('base');
                return compareOracle('rpcfailure', f.db, f.model);
            });
            await check('receipt and poller serialize across PostgreSQL connections on the shared chain lock', async () => {
                const f = await indexedOld('race');
                f.model.branch = 'new';
                activate(f.db, f.model);
                let release!: () => void, entered!: () => void;
                const blocked = new Promise<void>(r => release = r), inside = new Promise<void>(r => entered = r);
                f.model.beforeRequest = async (method) => { if (method === 'eth_getLogs') {
                    f.model.beforeRequest = null;
                    entered();
                    await blocked;
                } };
                const first = indexer.pollLaunches('base');
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([inside, first.then(() => { throw Error('poller completed without entering synthetic getLogs'); }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('poller did not reach synthetic getLogs within 10 seconds')), 10000); })]);
                }
                catch (e) {
                    release();
                    await first.catch(() => { });
                    throw e;
                }
                finally {
                    if (timer)
                        clearTimeout(timer);
                }
                const concurrent = indexer.applyLaunchTx('base', hash('new-swap'));
                void concurrent.catch(() => {}); // observed below, including the pre-fix 5s timeout
                let waiting = 0;
                try {
                    for (let i = 0; i < 20; i++) {
                        const [r] = await admin `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${schemaNames.get(f.db)!} AND wait_event='advisory'`;
                        waiting = r.n;
                        if (waiting > 0)
                            break;
                        await new Promise(r => setTimeout(r, 50));
                    }
                    // A normal RPC stall may outlive the independent 5s table-lock
                    // timeout. The chain wait budget must permit this handoff.
                    await new Promise(r => setTimeout(r, 5500));
                }
                finally {
                    release();
                }
                await Promise.all([first, concurrent]);
                assert.ok(waiting > 0, 'second PostgreSQL transaction should visibly wait on the shared chain lock');
                return { waitingWorkers: waiting, ...await compareOracle('race', f.db, f.model) };
            });
            await check('advisory timeout changes no canonical state and the same receipt can be retried', async () => {
                const f = await indexedOld('locktimeout');
                f.model.branch = 'new';
                activate(f.db, f.model);
                const before = await snapshot(f.db);
                const cursor = await f.db`SELECT * FROM bb_launch_sync_cursor ORDER BY chain_id`;
                let release!: () => void, entered!: () => void;
                const hold = new Promise<void>(resolve => { release = resolve; });
                const inside = new Promise<void>(resolve => { entered = resolve; });
                const blocker = f.db.begin(async locked => {
                    await locked`SELECT pg_advisory_xact_lock(hashtext('launch-index:base'))`;
                    entered();
                    await hold;
                });
                try {
                    await Promise.race([inside, blocker.then(() => { throw Error('blocking transaction ended before its lock'); })]);
                    await assert.rejects(indexer.applyLaunchTx('base', hash('new-swap')), IndexLockBusyError);
                    assert.deepEqual(await snapshot(f.db), before);
                    assert.deepEqual(await f.db`SELECT * FROM bb_launch_sync_cursor ORDER BY chain_id`, cursor);
                } finally {
                    release();
                    await blocker;
                }
                const retried = await indexer.applyLaunchTx('base', hash('new-swap'));
                assert.equal(retried.status, 'applied');
                await indexer.pollLaunches('base');
                return compareOracle('locktimeout', f.db, f.model);
            });
            await check('holder backfill stops after one empty chunk ahead of the poller cursor', async () => {
                const f = await indexedOld('emptybackfill');
                activate(f.db, f.model);
                await f.db`UPDATE bb_launches SET holders_synced_block=9223372036854775807 WHERE chain_id=8453`;
                await f.db`UPDATE bb_launches SET holders_synced_block=NULL,block_number=103 WHERE chain_id=8453 AND token=${B}`;
                const [cursor] = await f.db`SELECT cursor_block FROM bb_launch_sync_cursor WHERE chain_id=8453`;
                assert.equal(BigInt(cursor.cursor_block), 102n);
                f.model.calls.length = 0;
                assert.equal(await indexer.backfillHolders('base'), null);
                assert.equal(f.model.calls.filter(method => method === 'eth_blockNumber').length, 1, 'one canonical transaction, not 25 empty repeats');
                assert.equal(f.model.calls.filter(method => method === 'eth_getLogs').length, 0);
                const [pending] = await f.db`SELECT holders_synced_block FROM bb_launches WHERE chain_id=8453 AND token=${B}`;
                assert.equal(pending.holders_synced_block, null);
            });
            await check('fork arriving between range observation and commit rolls back the entire unit', async () => {
                const db = await database('midfork'), m = standardModel();
                activate(db, m);
                const before = await snapshot(db);
                m.beforeRequest = async (method) => { if (method === 'eth_getLogs') {
                    m.beforeRequest = null;
                    m.branch = 'new';
                } };
                await assert.rejects(indexer.pollLaunches('base'), /chain changed|canonical block/);
                assert.deepEqual(await snapshot(db), before);
                assert.equal((await db `SELECT * FROM bb_launch_blocks`).length, 0);
                await indexer.pollLaunches('base');
                return compareOracle('midfork', db, m);
            });
            await check('a mismatched log hash cannot commit raw events or checkpoints', async () => {
                const db = await database('badlog'), m = standardModel();
                activate(db, m);
                const before = await snapshot(db);
                const original = m.log.bind(m);
                m.log = (event, branch) => ({ ...original(event, branch), blockHash: event.eventName === 'Swap' ? hash('wrong-block') : m.blockHash(event.height, branch) });
                await assert.rejects(indexer.pollLaunches('base'), /not in the canonical block/);
                assert.deepEqual(await snapshot(db), before);
                assert.equal((await db `SELECT * FROM bb_launch_blocks`).length, 0);
            });
            await check('a stale successful receipt is rejected against the current canonical block', async () => {
                const db = await database('stalereceipt'), m = standardModel();
                activate(db, m);
                const stale = m.receipt(hash('old-swap')), original = m.receipt.bind(m);
                m.branch = 'new';
                await indexer.applyLaunchTx('base', hash('common-launch'));
                const before = await snapshot(db);
                m.receipt = tx => tx === hash('old-swap') ? stale : original(tx);
                await assert.rejects(indexer.applyLaunchTx('base', hash('old-swap')), /not in the canonical block/);
                assert.deepEqual(await snapshot(db), before);
            });
            await check('AA attribution ignores stale receipt evidence and heals from a matching canonical receipt', async () => {
                const db = await database('aareceipt'), m = standardModel();
                m.branch = 'new';
                activate(db, m);
                const original = m.receipt.bind(m), entryPoint = [...ENTRY_POINTS][0];
                let stale = true;
                m.receipt = tx => {
                    const r = original(tx);
                    if (!r || tx !== hash('new-swap'))
                        return r;
                    const sample = r.logs[0], topic = (address: string) => '0x' + address.slice(2).padStart(64, '0');
                    return { ...r, from: ALICE, to: entryPoint, blockHash: stale ? m.blockHash(101, 'old') : m.blockHash(101), logs: [
                            { ...sample, address: entryPoint, logIndex: '0x0', topics: [BEFORE_EXECUTION_EVENT], data: '0x' },
                            ...r.logs,
                            { ...sample, address: entryPoint, logIndex: '0x3', topics: [USER_OPERATION_EVENT, hash('userop'), topic(BOB), topic(ZERO)], data: '0x' },
                        ] } as typeof r;
                };
                await indexer.pollLaunches('base');
                const [pending] = await db `SELECT trader,trader_via,via_app FROM bb_launch_swaps WHERE tx_hash=${hash('new-swap')}`;
                assert.equal(pending.trader, ALICE);
                assert.equal(pending.trader_via, 'receipt_pending');
                assert.equal(pending.via_app, null);
                stale = false;
                await indexer.pollLaunches('base');
                await indexer.attributeBacklog('base');
                const [healed] = await db `SELECT trader,trader_via FROM bb_launch_swaps WHERE tx_hash=${hash('new-swap')}`;
                assert.equal(healed.trader, BOB);
                assert.equal(healed.trader_via, 'userop');
            });
            await check('capped transfer logs without receipt fallback never advance partial holder accounting', async () => {
                const db = await database('capped'), m = standardModel();
                activate(db, m);
                const before = await snapshot(db);
                const original = m.request.bind(m);
                m.request = async (method, params) => {
                    if (method === 'eth_getLogs') {
                        const addresses = (params[0] as { address: string | string[] }).address;
                        const values = Array.isArray(addresses) ? addresses : [addresses];
                        if (values.some((a: string) => a?.toLowerCase() === A))
                            throw Error('query returned more than 10000 results');
                    }
                    return original(method, params);
                };
                await assert.rejects(indexer.pollLaunches('base'), /Transfer logs.*receipts are unavailable/);
                assert.deepEqual(await snapshot(db), before);
                assert.equal((await db `SELECT * FROM bb_launch_blocks`).length, 0);
                assert.equal(BigInt((await db `SELECT cursor_block FROM bb_launch_sync_cursor WHERE chain_id=8453`)[0].cursor_block), 0n);
                m.request = original;
                await indexer.pollLaunches('base');
                return compareOracle('capped', db, m);
            });
            await check('a lagging RPC head fails closed without erasing previously indexed history', async () => {
                const f = await indexedOld('shorthead');
                const before = await snapshot(f.db);
                f.model.head = 101;
                activate(f.db, f.model);
                await assert.rejects(indexer.pollLaunches('base'), /RPC head is behind/);
                assert.deepEqual(await snapshot(f.db), before);
                assert.equal((await f.db `SELECT count(*)::int AS n FROM bb_launch_blocks`)[0].n, 3);
            });
            await check('receipt-triggered reorg retains a rebuild target until the poller restores old coverage', async () => {
                const db = await database('receiptcoverage'), m = standardModel();
                m.head = 200;
                activate(db, m);
                await indexer.pollLaunches('base');
                const [old] = await db `SELECT cursor_block FROM bb_launch_sync_cursor WHERE chain_id=8453`;
                m.branch = 'new';
                await indexer.applyLaunchTx('base', hash('new-swap'));
                const [pending] = await db `SELECT cursor_block,rebuilding_until FROM bb_launch_sync_cursor WHERE chain_id=8453`;
                assert.equal(BigInt(pending.rebuilding_until), BigInt(old.cursor_block));
                assert.ok(BigInt(pending.cursor_block) < BigInt(pending.rebuilding_until));
                await indexer.pollLaunches('base');
                assert.equal((await db `SELECT rebuilding_until FROM bb_launch_sync_cursor WHERE chain_id=8453`)[0].rebuilding_until, null);
                return compareOracle('receiptcoverage', db, m);
            });
            await check('generated sparse checkpoints locate exactly the last matching ancestor', async () => {
                let seed = 0x4f50454e;
                const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
                for (let sample = 0; sample < 24; sample++) {
                    const db = await database('sparse'), m = standardModel();
                    m.head = 260;
                    const heights = [...new Set([100, 220, ...Array.from({ length: random(9) }, () => 101 + random(119))])].sort((a, b) => a - b);
                    m.fork = sample === 0 ? 100 : sample === 1 ? 221 : 100 + random(122);
                    await db `UPDATE bb_launch_sync_cursor SET reorg_version=1,cursor_block=220,head_block=260 WHERE chain_id=8453`;
                    for (const height of heights)
                        await db `INSERT INTO bb_launch_blocks (chain_id,block_number,block_hash) VALUES(8453,${height},${m.blockHash(height, 'old')})`;
                    m.branch = 'new';
                    activate(db, m);
                    let clears = 0;
                    await withCanonicalIndex('base', 100n, () => { clears++; }, async () => { });
                    const matching = heights.filter(h => h < m.fork), ancestor = matching.at(-1) ?? 99;
                    const reorg = m.fork <= 220;
                    const [state] = await db `SELECT cursor_block,rebuilding_until FROM bb_launch_sync_cursor WHERE chain_id=8453`;
                    const audit = await db `SELECT from_block FROM bb_launch_reorgs`;
                    assert.equal(BigInt(state.cursor_block), BigInt(reorg ? ancestor : 220), `sample ${sample}: sparse boundary`);
                    assert.equal(audit.length, reorg ? 1 : 0);
                    if (reorg) {
                        assert.equal(BigInt(audit[0].from_block), BigInt(ancestor + 1));
                        assert.equal(BigInt(state.rebuilding_until), 220n);
                    }
                    assert.equal(clears, 1, 'generation transition must clear the local caches before work');
                    await withCanonicalIndex('base', 100n, () => { clears++; }, async () => { });
                    assert.equal(clears, 1, 'unchanged generation keeps normal retry throttling and caches');
                }
            });
            await check('failed canonical work clears process caches and retries from persisted generation', async () => {
                const { db, model } = await indexedOld('cachefailure');
                activate(db, model);
                let clears = 0;
                await assert.rejects(withCanonicalIndex('base', 100n, () => { clears++; }, async () => { throw Error('synthetic after-read failure'); }), /synthetic after-read failure/);
                assert.equal(clears, 1, 'failure clears data populated by the failed transaction');
                await withCanonicalIndex('base', 100n, () => { clears++; }, async () => { });
                assert.equal(clears, 2, 'retry recognizes the forgotten local generation and clears again');
            });
            await indexerAuditDbChecks({ check, database, activate, indexedOld, compareOracle });
            await directChecks({ check, indexedOld });
        }
        finally {
            setDb(null);
            for (const r of resources) {
                await r.db.end({ timeout: 5 });
                assert.match(r.name, /^reorg_security_[a-z0-9_]+_[0-9a-f]{16}$/);
                await admin.unsafe(`DROP SCHEMA "${r.name}" CASCADE`);
            }
            await admin.end({ timeout: 5 });
        }
    }
    await main();
}
