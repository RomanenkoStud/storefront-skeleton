// Regenerates every synthetic image the skeleton ships: the landing rack/rail cut-outs (apps/web/public/rail),
// the editorial backdrops (apps/web/public/editorial), the demo product photos (fixtures/demo-photos) and,
// through tools/brand-assets.mjs, the Lorem Store logo set (apps/web/public/brand).
// All art is flat colour shapes built from SVG paths (no fonts, no network), so output is deterministic for a
// given `sharp` version. Usage: node tools/placeholder-assets.mjs [--skip-brand]
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { suggestClassification } from '../packages/catalog/taxonomy.js';

const ROOT = new URL('../', import.meta.url);
const at = p => new URL(p, ROOT);
const RAIL = JSON.parse(await readFile(at('apps/web/src/rail-media.json'), 'utf8'));

// Neutral garment tones and a darker detail tone per garment.
const TONES = ['#8b9086', '#b8b0a0', '#5f6661', '#c9c3b5', '#43494a', '#9a8f7e', '#727b74', '#d6d2c6'];
const shade = hex => '#' + hex.slice(1).match(/../g).map(c => Math.round(parseInt(c, 16) * 0.72).toString(16).padStart(2, '0')).join('');

// ---- silhouettes in a 100 x 100 unit box. Clothes hang from a hanger hook at the top centre.
const HANGER = `<path d="M50 0.8Q54 0.8 54 3.6Q54 5.6 50 7.2V9.5M50 9.5L22 15.5H78Z" fill="none" stroke="#2c302d" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
const top = (sleeve) => sleeve === 'short'
  ? 'M31 14L42 12Q50 19 58 12L69 14L93 31L84 43L74 37V98H26V37L16 43L7 31Z'
  : 'M31 14L42 12Q50 19 58 12L69 14Q84 19 88 38L97 92L85 94L76 46V98H24V46L15 94L3 92L12 38Q16 19 31 14Z';
const BODY = {
  tshirt: d => [top('short'), `M42 12Q50 19 58 12`],
  sweatshirt: d => [top('long'), 'M24 92H76', 'M42 12Q50 19 58 12'],
  hoodie: d => [top('long'), 'M37 15Q50 -2 63 15Q50 24 37 15Z', 'M36 62H64V80H36Z'],
  zip: d => [top('long'), 'M37 15Q50 -2 63 15Q50 24 37 15Z', 'M50 20V98'],
  turtleneck: d => [top('long'), 'M41 6H59V16H41Z'],
  cardigan: d => [top('long'), 'M50 18V98', 'M42 12L50 40L58 12'],
  sweater: d => [top('long'), 'M24 90H76', 'M15 90L3 88'],
  shirt: d => [top('long'), 'M50 16V98', 'M42 12L50 20L58 12'],
  jacket: d => [top('long'), 'M50 16V98', 'M30 60H44M56 60H70'],
  windbreaker: d => [top('long'), 'M37 15Q50 -2 63 15Q50 24 37 15Z', 'M50 20V98', 'M24 50L76 50'],
  puffer: d => [top('long'), 'M24 34H76M24 50H76M24 66H76M24 82H76', 'M50 16V98'],
  coat: d => ['M31 12L42 10Q50 17 58 10L69 12Q84 17 87 36L96 90L84 92L77 46V99H23V46L16 92L4 90L13 36Q16 17 31 12Z', 'M42 10L50 44L58 10', 'M50 44V99'],
  tracksuit: d => [top('long'), 'M50 20V98', 'M12 38L3 92M88 38L97 92'],
  pants: d => ['M27 10H73L81 99H57L50 38L43 99H19Z', 'M27 16H73'],
  jeans: d => ['M27 10H73L80 99H57L50 38L43 99H20Z', 'M27 16H73', 'M33 16Q36 26 44 26M67 16Q64 26 56 26'],
  cargo: d => ['M26 10H74L82 99H57L50 38L43 99H18Z', 'M26 16H74', 'M22 54H34V70H22ZM66 54H78V70H66Z'],
  joggers: d => ['M28 10H72L78 92L80 99H58L56 92L50 38L44 92L42 99H20L22 92Z', 'M28 16H72', 'M22 92H42M58 92H78'],
  shorts: d => ['M22 12H78L88 84L55 89L50 50L45 89L12 84Z', 'M22 19H78'],
};
const SHOE = {
  sneakers: ['M3 70Q4 42 26 40L44 30Q58 25 68 38Q90 46 97 60V78H3Z', 'M3 78H97V90H3Z', 'M40 40L48 54M50 36L58 50'],
  'canvas-shoes': ['M3 66Q4 44 24 42L46 32Q60 28 70 40Q90 46 97 60V78H3Z', 'M3 78H97V90H3Z', 'M74 44Q92 50 97 60'],
  boots: ['M14 4H50V48Q72 52 92 62Q98 66 97 76V82H6V60Q6 40 14 4Z', 'M6 82H97V94H6Z', 'M14 14H50'],
  loafers: ['M3 72Q4 52 24 50L50 44Q72 44 84 54Q97 60 97 70V80H3Z', 'M3 80H97V90H3Z', 'M46 52H66'],
  slippers: ['M3 80H97V92H3Z', 'M18 80Q20 46 50 42Q80 46 82 80Z', 'M30 60H70'],
};
const ACC = {
  bags: ['M18 34H82L88 96H12Z', 'M34 34Q34 6 50 6Q66 6 66 34', 'M18 46H82'],
  'hats-caps': ['M14 66Q14 22 50 22Q86 22 86 66Z', 'M50 66H98Q96 76 80 76H50Z', 'M50 22V66'],
  belts: ['M2 42H98V58H2Z', 'M20 36H40V64H20Z', 'M26 42H34V58H26Z'],
  'socks-underwear': ['M30 6H58V60L84 72Q94 78 88 90Q84 96 72 92L36 78Q28 74 30 64Z', 'M30 14H58', 'M64 66L80 72'],
  jewellery: ['M50 14A36 36 0 1 0 50.1 14Z', 'M50 26A24 24 0 1 1 49.9 26Z'],
};
const KIND = {
  hoodies: 'hoodie', 'zip-hoodies': 'zip', sweatshirts: 'sweatshirt', cardigans: 'cardigan', sweaters: 'sweater', turtlenecks: 'turtleneck',
  'tshirts-polos': 'tshirt', shirts: 'shirt', jackets: 'jacket', 'puffer-jackets': 'puffer', windbreakers: 'windbreaker', 'coats-vests': 'coat',
  jeans: 'jeans', cargo: 'cargo', joggers: 'joggers', shorts: 'shorts', 'pants-other': 'pants', tracksuits: 'tracksuit', 'summer-suits': 'tshirt',
};

// Returns the inner SVG for one silhouette in the 100x100 box: first path filled, the rest drawn as detail lines.
function shapes(categoryId, tone) {
  const paths = SHOE[categoryId] ?? ACC[categoryId] ?? BODY[KIND[categoryId] ?? 'sweatshirt']();
  const line = shade(tone);
  const [main, ...rest] = paths;
  const hanging = !SHOE[categoryId] && !ACC[categoryId];
  return { hanging, body: `<path d="${main}" fill="${tone}"/>` + rest.map(d => /Z$/.test(d)
    ? `<path d="${d}" fill="${line}"/>`
    : `<path d="${d}" fill="none" stroke="${line}" stroke-width="1.6" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`).join('') };
}

const svg = (w, h, inner, bg) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ''}${inner}</svg>`;
// Stretch the unit box to w x h (rail cut-outs: front, angle and side views are the same shape at different widths).
const stretched = (w, h, categoryId, tone, hanger = true) => {
  const { hanging, body } = shapes(categoryId, tone);
  return `<g transform="scale(${w / 100} ${h / 100})">${hanging && hanger ? HANGER : ''}<g${hanging ? ' transform="translate(0 6) scale(1 .94)"' : ''}>${body}</g></g>`;
};
// Fit the unit box uniformly inside a box at (x, y, s).
const placed = (x, y, s, categoryId, tone, sy = 1) => {
  const { hanging, body } = shapes(categoryId, tone);
  return `<g transform="translate(${x} ${y}) scale(${s / 100} ${s * sy / 100})">${hanging ? HANGER : ''}<g${hanging ? ' transform="translate(0 6) scale(1 .94)"' : ''}>${body}</g></g>`;
};
async function write(path, svgText, format, opts = {}) {
  const url = at(path);
  await mkdir(new URL('.', url), { recursive: true });
  let img = sharp(Buffer.from(svgText), { density: 72 });
  img = format === 'webp' ? img.webp({ quality: 80, alphaQuality: 90, effort: 6, ...opts }) : format === 'jpeg' ? img.flatten({ background: '#ffffff' }).jpeg({ quality: 78, mozjpeg: true }) : img.png({ compressionLevel: 9 });
  const buf = await img.toBuffer();
  await writeFile(url, buf);
  return buf.length;
}

// ---- rail: rack plus one cut-out per view, at the dimensions rail-media.json declares.
{
  const { w, h, bar, post, shelf } = RAIL.rack, pw = Math.round(w * post), barY = Math.round(h * bar), shelfY = Math.round(h * shelf), pipe = '#1f2421';
  const rack = `<rect x="0" y="${barY - 9}" width="${w}" height="18" rx="9" fill="${pipe}"/>`
    + `<rect x="${pw * 0.25}" y="${barY}" width="${pw * 0.5}" height="${h - barY}" fill="${pipe}"/><rect x="${w - pw * 0.75}" y="${barY}" width="${pw * 0.5}" height="${h - barY}" fill="${pipe}"/>`
    + `<rect x="${pw * 0.25}" y="${shelfY}" width="${w - pw * 0.5}" height="16" fill="#5a5f58"/>`
    + `<rect x="0" y="${h - 22}" width="${pw * 1.2}" height="22" rx="4" fill="${pipe}"/><rect x="${w - pw * 1.2}" y="${h - 22}" width="${pw * 1.2}" height="22" rx="4" fill="${pipe}"/>`;
  console.log('rail/rack.webp', await write(`apps/web/public${RAIL.rack.src}`, svg(w, h, rack), 'webp'));
  for (const [i, piece] of RAIL.clothes.entries()) for (const view of ['front', 'angle', 'side']) {
    const v = piece[view]; if (!v) continue;
    const tone = TONES[i % TONES.length];
    console.log(v.src, await write(`apps/web/public${v.src}`, svg(v.w, v.h, stretched(v.w, v.h, piece.categoryId, view === 'side' ? shade(tone) : tone)), 'webp'));
  }
  for (const [i, shoe] of RAIL.shoes.entries())
    console.log(shoe.src, await write(`apps/web/public${shoe.src}`, svg(shoe.w, shoe.h, stretched(shoe.w, shoe.h, shoe.categoryId, TONES[(i + 3) % TONES.length])), 'webp'));
}

// ---- editorial backdrops: flat wall and floor, a few hanging pieces. No alpha.
{
  const wall = (w, h) => svg(w, h, `<rect y="${h * 0.78}" width="${w}" height="${h * 0.22}" fill="#b9b4a8"/><rect x="${w * 0.52}" y="${h * 0.08}" width="${w * 0.44}" height="8" fill="#2c302d"/>`
    + placed(w * 0.54, h * 0.08, h * 0.5, 'hoodies', '#7d847b') + placed(w * 0.66, h * 0.08, h * 0.5, 'coats-vests', '#9a8f7e') + placed(w * 0.78, h * 0.08, h * 0.5, 'jackets', '#5f6661')
    + placed(w * 0.6, h * 0.66, h * 0.2, 'sneakers', '#43494a') + placed(w * 0.78, h * 0.62, h * 0.24, 'boots', '#8b6f55'), '#d9d4c7');
  const floor = (w, h) => svg(w, h, `<rect y="${h * 0.62}" width="${w}" height="${h * 0.38}" fill="#a8a294"/>`
    + placed(w * 0.56, h * 0.5, h * 0.22, 'sneakers', '#3f4542') + placed(w * 0.74, h * 0.48, h * 0.24, 'canvas-shoes', '#c9c3b5') + placed(w * 0.62, h * 0.28, h * 0.26, 'bags', '#6f6252'), '#cfc9bb');
  const night = (w, h) => svg(w, h, `<rect y="${h * 0.8}" width="${w}" height="${h * 0.2}" fill="#3a3530"/><rect x="${w * 0.1}" y="${h * 0.1}" width="${w * 0.8}" height="10" fill="#1f2421"/>`
    + placed(w * 0.08, h * 0.1, w * 0.56, 'shirts', '#6f7a52') + placed(w * 0.36, h * 0.14, w * 0.56, 'hoodies', '#8b9086')
    + placed(w * 0.1, h * 0.74, w * 0.3, 'sneakers', '#d6d2c6') + placed(w * 0.6, h * 0.7, w * 0.26, 'hats-caps', '#43494a'), '#8a6a4c');
  for (const [name, art] of [['campaign-wall', wall], ['campaign-floor', floor]]) {
    console.log(name, await write(`apps/web/public/editorial/${name}.webp`, art(1600, 900), 'webp'));
    console.log(name, await write(`apps/web/public/editorial/${name}-800.webp`, art(800, 450), 'webp'));
  }
  console.log('city-layers.jpg', await write('apps/web/public/editorial/city-layers.jpg', night(1024, 1536), 'jpeg'));
}

// ---- demo product photos: one file per /media/<key>.webp in fixtures/mydrop-demo.json, on a plain studio background.
{
  const dir = 'fixtures/demo-photos/';
  await mkdir(at(dir), { recursive: true });
  const fixture = JSON.parse(await readFile(at('fixtures/mydrop-demo.json'), 'utf8'));
  const wanted = new Set();
  for (const [i, item] of fixture.items.entries()) {
    const { categoryId } = suggestClassification(item);
    for (const [n, url] of item.photos.entries()) {
      const key = url.replace(/^\/media\//, ''); wanted.add(key);
      const tone = TONES[i % TONES.length], bg = n === 0 ? '#ecebe5' : '#e2e4dc';
      const art = n === 0 ? placed(110, 160, 580, categoryId, tone) : placed(-60, 40, 920, categoryId, tone);
      await write(dir + key, svg(800, 1000, art, bg), 'webp', { quality: 70 });
    }
  }
  for (const file of await readdir(at(dir))) if (!wanted.has(file)) await rm(at(dir + file));
  console.log('demo photos', wanted.size);
}

if (!process.argv.includes('--skip-brand')) await import('./brand-assets.mjs');
