#!/usr/bin/env node
// Local utility: turn a product photo into a clean "stock" flat-lay on white with the lead's Codex
// (ChatGPT plan) image generation, upload it to R2 media storage and add it to the product's photos.
//
//   node tools/stockify.mjs <productId|supplierNumber> [...] [--env prod|staging] [--primary] [--photo N] [--dry-run]
//
// Defaults: --env prod, photo 1, the new image is appended to the photo list (--primary puts it first).
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (read from .dev.vars) and a logged-in `codex` CLI.
// Exit code 75 means the Codex plan limit was reached: rerun later with the printed remaining ids.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const ENVS = {
  prod: { db: 'storefront-skeleton', bucket: 'storefront-skeleton-media' },
  staging: { db: 'storefront-skeleton-staging', bucket: 'storefront-skeleton-media-staging' },
};
const LIMIT_EXIT = 75;

// Arrangement hints only. The viewpoint always follows the source photo: the 2026-11-20 audit found that forcing a
// front view or a side profile made the model invent sides it never saw (back prints moved to the chest, toe boxes guessed).
const PROMPTS = {
  pants: 'trousers laid out straight and symmetric, waistband horizontal at the top',
  footwear: 'shoes standing upright on their soles, both fully in frame with the second shoe slightly behind the first, laces laced exactly as in the photo (no added bows or loose lace ends), sole the same height and shape as in the photo',
  tops: 'garment laid out flat and symmetric, sleeves neatly alongside the body, collar or hood straight and centred',
  default: 'item laid out flat or standing upright, neatly arranged',
};
const CATEGORY_GROUPS = {
  pants: ['pants', 'jeans', 'cargo', 'joggers', 'shorts', 'pants-other'],
  footwear: ['footwear', 'sneakers', 'canvas-shoes', 'slippers', 'loafers', 'boots'],
  tops: ['hoodies-sweatshirts', 'zip-hoodies', 'tshirts', 't-shirts', 'shirts', 'polo', 'sweaters', 'jackets', 'outerwear', 'longsleeves', 'tops'],
};
const KEYWORDS = [
  ['pants', /штан|брюк|джинс|шорт|карго|jogger|pants|jeans|trousers|shorts/i],
  ['footwear', /кросів|кросс|кед|взутт|черевик|капц|лофер|sneaker|shoe|boot/i],
  ['tops', /худі|світшот|світер|футболк|сороч|кофт|куртк|жилет|лонгслів|поло|вітрівк|ветровк|кардиган|овершот|пуховик|hoodie|sweat|shirt|jacket|sweater|polo|windbreaker|cardigan|overshirt/i],
];

function promptFor(group, title) {
  const product = title ? `the product "${title}"` : 'the product';
  return [
    'Use your image generation tool. Recreate ' + product + ' from the attached photo as a professional e-commerce stock product photo on a pure white background (#FFFFFF), portrait 3:4.',
    'This is a photo of one specific real item for sale, not a design brief: copy it, do not redesign it.',
    // Viewpoint: never show a side that is not visible in the photo.
    'Keep the same side of the item facing the camera as in the photo and a similar viewing angle, only straightened and centred. If the photo shows the back, show the back; if it shows shoes from the side or at an angle, show them from that same side and angle. Never rotate the item to reveal a side, front, toe box, sole or detail that is not visible in the photo, and never mirror it.',
    `Arrangement: ${PROMPTS[group]}.`,
    // Product only: people, worn accessories and props go.
    'Show only the product itself and the same number of pieces as in the photo. Remove the person, hands, mannequin, hanger, boxes, magazines, plants and anything else that is not part of the product. Clothing or shoes that a model is wearing together with the product are NOT part of it and must not appear.',
    // Material: keep the real finish. Smoothing used to turn crinkled/metallic nylon into a different fabric.
    'Keep the material exactly as it is: the same fabric finish, sheen and surface texture (crinkled, metallic, glossy, ribbed, knitted, quilted, suede or mesh stay so). Only tidy away creases caused by folding or handling; do not flatten, smooth or matte the fabric itself.',
    'Keep exact colours, all seams, panels, pockets, flaps, drawstrings, zips, buttons, laces, soles, trims, labels, patches, prints, logos and embroidery at the same size, colour and position. Do not add, remove, enlarge or move any of them.',
    // Text: garbled lettering was the other common failure.
    'Reproduce every piece of visible text letter for letter. If a word cannot be reproduced exactly, keep it as small and soft as it appears in the photo rather than inventing, merging or misspelling letters.',
    'Before saving, compare your image with the attached photo and regenerate if the visible side, colours, material, text, logos or pockets differ.',
    'Soft even studio lighting with a very subtle natural shadow, product centred and filling most of the frame, nothing else in the frame. Save the generated image as output.png in the current directory, then reply with the saved path only.',
  ].join(' ');
}

function loadDevVars() {
  // Worktrees have no .dev.vars; fall back to the main checkout (parent of the shared .git dir).
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).stdout?.trim();
  const file = [new URL('../.dev.vars', import.meta.url), join(process.cwd(), '.dev.vars'), common && join(common, '..', '.dev.vars')]
    .find((f) => f && existsSync(f));
  if (!file) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function parseArgs(argv) {
  const opts = { env: 'prod', primary: false, photo: 1, dryRun: false, ids: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') opts.env = argv[++i];
    else if (a === '--primary') opts.primary = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--photo') opts.photo = Number(argv[++i]);
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('-')) throw new Error(`Unknown option ${a}`);
    else opts.ids.push(a);
  }
  if (!ENVS[opts.env]) throw new Error('--env must be prod or staging');
  if (!Number.isInteger(opts.photo) || opts.photo < 1) throw new Error('--photo must be a positive number');
  return opts;
}

async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, ...(init.headers || {}) },
  });
  return res;
}

async function cfJson(path, init) {
  const res = await cf(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) throw new Error(`Cloudflare API ${path}: ${res.status} ${JSON.stringify(body.errors || body).slice(0, 300)}`);
  return body.result;
}

const dbIds = {};
async function dbId(name) {
  if (dbIds[name]) return dbIds[name];
  const list = await cfJson(`/d1/database?name=${encodeURIComponent(name)}&per_page=50`);
  const db = list.find((d) => d.name === name);
  if (!db) throw new Error(`D1 database ${name} not found`);
  return (dbIds[name] = db.uuid);
}

async function sql(dbName, query, params = []) {
  const result = await cfJson(`/d1/database/${await dbId(dbName)}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: query, params }),
  });
  return result[0];
}

function groupFor(source, overrides) {
  const cat = overrides.categoryId || '';
  for (const [group, ids] of Object.entries(CATEGORY_GROUPS)) if (ids.includes(cat)) return group;
  const text = `${overrides.title || ''} ${source.title || ''} ${source.category || ''}`;
  for (const [group, re] of KEYWORDS) if (re.test(text)) return group;
  return 'default';
}

async function downloadPhoto(url, bucket) {
  if (url.startsWith('/media/')) {
    const key = url.slice('/media/'.length);
    const res = await cf(`/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`);
    if (!res.ok) throw new Error(`Cannot read ${url} from R2 (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (!/^https:\/\//.test(url)) throw new Error(`Unsupported photo URL ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Cannot download ${url} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

function imageType(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => buf[i] === v)) return { ext: 'png', type: 'image/png' };
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return null;
}

function newestGenerated(sinceMs) {
  const root = join(homedir(), '.codex', 'generated_images');
  if (!existsSync(root)) return null;
  let best = null;
  for (const dir of readdirSync(root)) {
    const d = join(root, dir);
    if (!statSync(d).isDirectory()) continue;
    for (const f of readdirSync(d)) {
      const p = join(d, f), m = statSync(p).mtimeMs;
      if (m >= sinceMs && (!best || m > best.m)) best = { p, m };
    }
  }
  return best?.p || null;
}

class LimitError extends Error {}

function runCodex(inputBuf, inputType, group, title) {
  const dir = mkdtempSync(join(tmpdir(), 'stockify-'));
  try {
    writeFileSync(join(dir, `input.${inputType.ext}`), inputBuf);
    const started = Date.now();
    const r = spawnSync('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-i', `input.${inputType.ext}`, '-'], {
      cwd: dir, input: promptFor(group, title), encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
    });
    const log = `${r.stdout || ''}\n${r.stderr || ''}`;
    if (/usage limit|rate limit|limit reached|quota|try again (in|at)|too many requests/i.test(log) && r.status !== 0) {
      throw new LimitError((log.match(/.*(usage limit|rate limit|try again).*/i) || ['Codex plan limit reached'])[0].trim());
    }
    if (r.error) throw new Error(`codex failed to run: ${r.error.message}`);
    const out = join(dir, 'output.png');
    const file = existsSync(out) ? out : newestGenerated(started);
    if (!file) throw new Error(`Codex produced no image (exit ${r.status}). Last output:\n${log.slice(-1500)}`);
    const buf = readFileSync(file);
    if (!imageType(buf)) throw new Error('Codex output is not a JPEG/PNG/WebP image');
    return buf;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function stockify(id, opts) {
  const requested = id;
  const { db, bucket } = ENVS[opts.env];
  // Accept the internal product id or the supplier product number shown in the editor (external_id).
  const rows = (await sql(db, 'SELECT id, source_json, overrides_json, deleted_at FROM products WHERE id = ? OR external_id = ?', [id, id])).results;
  const live = rows.filter((r) => !r.deleted_at);
  if (!rows.length) throw new Error(`Product ${id} not found in ${opts.env}`);
  if (live.length > 1) throw new Error(`${id} matches ${live.length} products (${live.map((r) => r.id).join(', ')}); pass the internal id`);
  const row = live[0] || rows[0];
  id = row.id;
  if (row.deleted_at) throw new Error(`Product ${id} is in Trash`);
  const source = JSON.parse(row.source_json), overrides = JSON.parse(row.overrides_json || '{}');
  const photos = Array.isArray(overrides.photos) && overrides.photos.length ? overrides.photos : (source.photos || []);
  const sourceUrl = photos[opts.photo - 1];
  if (!sourceUrl) throw new Error(`Product ${id} has no photo #${opts.photo} (it has ${photos.length})`);
  const group = groupFor(source, overrides);
  console.log(`• ${requested}${requested === id ? '' : ` (${id})`} "${overrides.title || source.title}" — ${group} prompt, from ${sourceUrl}`);

  const input = await downloadPhoto(sourceUrl, bucket);
  const inputType = imageType(input);
  if (!inputType) throw new Error(`Photo ${sourceUrl} is not a JPEG/PNG/WebP image`);
  const output = runCodex(input, inputType, group, overrides.title || source.title);
  const outType = imageType(output);
  const key = `${randomUUID()}.${outType.ext}`, url = `/media/${key}`;

  if (opts.dryRun) {
    const local = join(process.cwd(), `stockify-${id}.${outType.ext}`);
    writeFileSync(local, output);
    console.log(`  dry run: saved ${local}, nothing uploaded`);
    return;
  }
  const put = await cf(`/r2/buckets/${bucket}/objects/${key}`, { method: 'PUT', headers: { 'Content-Type': outType.type }, body: output });
  if (!put.ok) throw new Error(`R2 upload failed (${put.status}): ${(await put.text()).slice(0, 300)}`);

  const nextPhotos = opts.primary ? [url, ...photos] : [...photos, url];
  const next = JSON.stringify({ ...overrides, photos: nextPhotos });
  const now = new Date().toISOString();
  // Optimistic: only write if nobody changed the product meanwhile.
  const upd = await sql(db, 'UPDATE products SET overrides_json = ?, updated_at = ? WHERE id = ? AND overrides_json = ?', [next, now, id, row.overrides_json]);
  if (!upd.meta?.changes) throw new Error(`Product ${id} changed while generating; uploaded ${url} but did not attach it. Rerun to retry.`);
  await sql(db, 'INSERT INTO audit_events (id, actor, action, resource_id, created_at) VALUES (?, ?, ?, ?, ?)',
    [randomUUID(), 'stockify-cli', 'media.stockify', `${id}:${key}`, now]);
  console.log(`  ✓ uploaded ${url} and ${opts.primary ? 'set it as the first photo' : 'appended it to the photos'} (${nextPhotos.length} photos)`);
}

async function main() {
  loadDevVars();
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.ids.length) {
    console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 9).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(opts.help ? 0 : 1);
  }
  if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is not set (.dev.vars)');
  if (!/^[0-9a-f]{32}$/i.test(process.env.CLOUDFLARE_ACCOUNT_ID || '')) throw new Error('CLOUDFLARE_ACCOUNT_ID is not set (.dev.vars)');
  let failed = 0;
  for (let i = 0; i < opts.ids.length; i++) {
    try {
      await stockify(opts.ids[i], opts);
    } catch (e) {
      if (e instanceof LimitError) {
        console.error(`\nCodex plan limit reached: ${e.message}\nRemaining ids (rerun later):\n${opts.ids.slice(i).join(' ')}`);
        process.exit(LIMIT_EXIT);
      }
      failed++;
      console.error(`  ✗ ${opts.ids[i]}: ${e.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
