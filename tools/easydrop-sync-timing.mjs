// CPU timing of a full EasyDrop sync (parse + normalize + atomic import) on the synthetic feed, via the
// scheduled() path. In-memory SQLite stands in for D1 (so D1 write latency is not measured); no network.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../apps/api/src/index.js';
import { syntheticFeed } from './easydrop-timing.mjs';

const sqlite = new DatabaseSync(':memory:');
const dir = new URL('../migrations/', import.meta.url);
for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(f, dir), 'utf8'));
const wrap = (sql, b = []) => ({ sql, bindings: b, bind: (...v) => wrap(sql, v), first: async () => sqlite.prepare(sql).get(...b) ?? null, all: async () => ({ results: sqlite.prepare(sql).all(...b) }), run: async () => sqlite.prepare(sql).run(...b) });
const DB = { prepare: sql => wrap(sql), async batch(s) { sqlite.exec('BEGIN'); try { const r = s.map(x => sqlite.prepare(x.sql).run(...x.bindings)); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } } };
sqlite.prepare("INSERT INTO suppliers(id,name,url,enabled,created_at,provider,feed_key,feed_pid) VALUES('s1','T','easydrop:s1',1,'2026-01-01T00:00:00Z','easydrop','123','456')").run();
const bytes = new TextEncoder().encode(syntheticFeed());
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(bytes, { headers: { 'Content-Type': 'application/xml' } });
const cpu0 = process.cpuUsage(), t0 = performance.now();
const tasks = [];
await worker.scheduled({}, { DB }, { waitUntil: p => tasks.push(p) });
await Promise.all(tasks);
const cpu = process.cpuUsage(cpu0);
globalThis.fetch = realFetch;
const run = sqlite.prepare('SELECT status,imported,error FROM sync_runs ORDER BY created_at DESC LIMIT 1').get();
console.log(JSON.stringify({ feedBytes: bytes.length, wallMs: +(performance.now() - t0).toFixed(0), cpuMs: +((cpu.user + cpu.system) / 1000).toFixed(0), run }));
