// Regenerates the Lorem Store placeholder brand set in apps/web/public/brand: the SVG wordmarks (B1 stacked, S1 compact),
// the LS monogram (N1 outline, N1 small filled tile, favicon), site.webmanifest and every raster (favicons, touch/install
// icons, og.png). Letterforms are stroked paths on a fixed grid, so no font, network or source artwork is needed.
// Usage: node tools/brand-assets.mjs [--out <dir>] [--sheet]
//   --out <dir>  write everything there instead (flat, same names)
//   --sheet      also write brand-sheet.png, an overview of every variant, to the output directory
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const outArg = process.argv.indexOf('--out');
const PUB = new URL('../apps/web/public/brand/', import.meta.url);
const OUT = outArg > 0 ? pathToFileURL(resolve(process.argv[outArg + 1]) + '/') : PUB;
const GRAPHITE = '#1b201d', CREAM = '#f1f3ea', LIME = '#d7f16c', MOSS = '#51614d';
const NAME = 'Lorem Store';

// Glyphs on a 6 x 10 grid (x right, y down); absolute M/L/H/V/Z commands only.
const GLYPHS = {
  L: ['M0 0V10H6'], O: ['M0 0H6V10H0Z'], R: ['M0 10V0H6V5H0', 'M3 5L6 10'], E: ['M6 0H0V10H6', 'M0 5H4.5'],
  M: ['M0 10V0L3 6L6 0V10'], S: ['M6 0H0V5H6V10H0'], T: ['M0 0H6', 'M3 0V10'],
};
const f = n => +n.toFixed(2);
// One word as path data, letters `cap` tall with `gap` between them, top-left at (x, y).
function word(text, x, y, cap, gap) {
  const k = cap / 10, w = 6 * k;
  return [...text].map((ch, i) => GLYPHS[ch].map(p => p.replace(/([MLHVZ])([^MLHVZ]*)/g, (_, cmd, args) => {
    const n = args.trim().split(/\s+/).filter(Boolean).map(Number), ox = x + i * (w + gap);
    if (cmd === 'H') return `H${f(ox + n[0] * k)}`;
    if (cmd === 'V') return `V${f(y + n[0] * k)}`;
    if (cmd === 'Z') return 'Z';
    return `${cmd}${f(ox + n[0] * k)} ${f(y + n[1] * k)}`;
  })).join('')).join('');
}
const widthOf = (text, cap, gap) => text.length * 0.6 * cap + (text.length - 1) * gap;
const stroke = (d, color, sw) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="square" stroke-linejoin="miter" stroke-miterlimit="3"/>`;
const doc = (viewBox, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-labelledby="t"><title id="t">${NAME}</title>${body}</svg>\n`;

// B1: stacked LOREM / STORE over two thin rules and a centre diamond. viewBox kept from the slot contract (about 2:1).
function b1(color) {
  const cap = 52, gap = 14, w = widthOf('LOREM', cap, gap);
  return doc('-147.26 -4 294.52 150', stroke(word('LOREM', -w / 2, 4, cap, gap) + word('STORE', -w / 2, 70, cap, gap), color, 7)
    + `<path d="M-145.26 130.2H-12V132.8H-145.26ZM12 130.2H145.26V132.8H12Z" fill="${color}"/><path d="M0 125.5L6 131.5L0 137.5L-6 131.5Z" fill="${color}"/>`);
}
// S1: compact cut for widths below 120 px: heavier strokes and a solid accent bar.
function s1(color, accent) {
  const cap = 54, gap = 17, w = widthOf('LOREM', cap, gap);
  return doc('-146 -2 292 160', stroke(word('LOREM', -w / 2, 8, cap, gap) + word('STORE', -w / 2, 74, cap, gap), color, 10)
    + `<path d="M-144 140H-20V148H-144ZM20 140H144V148H20Z" fill="${accent}"/>`);
}
// N1: outline LS monogram between two rules (48 px and up).
function n1(color) {
  const cap = 34, gap = 5, x = 50 - widthOf('LS', cap, gap) / 2;
  return doc('0 0 100 100', `<path d="M9 49H${f(x - 4)}V51H9Z" fill="${color}"/><path d="M${f(104 - x)} 49H91V51H${f(104 - x)}Z" fill="${color}"/>`
    + stroke(word('LS', x, 33, cap, gap), color, 3));
}
// N1 small: solid tile, lime rules, heavy LS (16 and 32 px, favicon).
function n1Small() {
  const cap = 46, gap = 6, x = 50 - widthOf('LS', cap, gap) / 2;
  return doc('0 0 100 100', `<rect width="100" height="100" fill="${GRAPHITE}"/><path d="M4 43.75H${f(x - 6)}V56.25H4Z" fill="${LIME}"/><path d="M${f(106 - x)} 43.75H96V56.25H${f(106 - x)}Z" fill="${LIME}"/>`
    + stroke(word('LS', x, 27, cap, gap), CREAM, 8));
}

const files = {
  'logo-b1-light.svg': b1(GRAPHITE), 'logo-b1-dark.svg': b1(CREAM),
  'logo-s1-light.svg': s1(GRAPHITE, MOSS), 'logo-s1-dark.svg': s1(CREAM, LIME),
  'mark-n1.svg': n1(GRAPHITE), 'mark-n1-dark.svg': n1(CREAM),
  'mark-n1-small.svg': n1Small(), 'favicon.svg': n1Small(),
};
const manifest = {
  name: NAME, short_name: NAME, description: 'Демонстраційна вітрина Lorem Store.', lang: 'uk', start_url: '/', scope: '/', display: 'browser',
  theme_color: GRAPHITE, background_color: GRAPHITE,
  icons: [
    { src: '/brand/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
    { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/brand/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

await mkdir(OUT, { recursive: true });
const out = async (name, buf) => { await writeFile(new URL(name, OUT), buf); console.log(name, buf.length); };
for (const [name, text] of Object.entries(files)) await out(name, Buffer.from(text));
await out('site.webmanifest', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));

const inner = svg => svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title[^>]*>.*?<\/title>/, '');
const viewBox = svg => svg.match(/viewBox="([^"]+)"/)[1];
const nest = (svg, x, y, w, h) => `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${viewBox(svg)}">${inner(svg)}</svg>`;
const png = (svg, size) => sharp(Buffer.from(svg), { density: 72 * size / 100 * 4 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
// Solid tile: graphite background, N1 dark monogram scaled about the centre.
const tile = scale => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${GRAPHITE}"/><g transform="translate(50 50) scale(${scale}) translate(-50 -50)">${inner(files['mark-n1-dark.svg'])}</g></svg>`;

await out('favicon-16.png', await png(files['mark-n1-small.svg'], 16));
await out('favicon-32.png', await png(files['mark-n1-small.svg'], 32));
await out('apple-touch-icon.png', await sharp(await png(tile(1), 180)).flatten({ background: GRAPHITE }).png({ compressionLevel: 9 }).toBuffer());
await out('icon-192.png', await png(tile(1), 192));
await out('icon-512.png', await png(tile(1), 512));
await out('icon-512-maskable.png', await png(tile(0.66), 512)); // content inside the central 80% safe circle
const og = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="${GRAPHITE}"/>${nest(files['logo-b1-dark.svg'], 360, 150, 480, 245)}<rect x="360" y="470" width="480" height="8" fill="${LIME}"/></svg>`;
await out('og.png', await sharp(Buffer.from(og), { density: 72 }).resize(1200, 630).png({ compressionLevel: 9, palette: true, colors: 16 }).toBuffer());

if (process.argv.includes('--sheet')) {
  const panel = (x, y, bg) => `<rect x="${x}" y="${y}" width="680" height="300" fill="${bg}"/>`;
  const sheet = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1400 960"><rect width="1400" height="960" fill="#e4e6dd"/>
${panel(20, 20, CREAM)}${nest(files['logo-b1-light.svg'], 200, 60, 320, 163)}${panel(700, 20, GRAPHITE)}${nest(files['logo-b1-dark.svg'], 880, 60, 320, 163)}
${panel(20, 330, CREAM)}${nest(files['logo-s1-light.svg'], 260, 400, 120, 66)}${nest(files['logo-s1-light.svg'], 440, 410, 84, 46)}${panel(700, 330, GRAPHITE)}${nest(files['logo-s1-dark.svg'], 940, 400, 120, 66)}${nest(files['logo-s1-dark.svg'], 1120, 410, 84, 46)}
${panel(20, 640, CREAM)}${nest(files['mark-n1.svg'], 60, 680, 200, 200)}${nest(files['mark-n1.svg'], 300, 730, 96, 96)}${nest(files['mark-n1-small.svg'], 460, 730, 100, 100)}${panel(700, 640, GRAPHITE)}${nest(files['mark-n1-dark.svg'], 740, 680, 200, 200)}${nest(files['mark-n1-dark.svg'], 980, 730, 96, 96)}
</svg>`;
  await out('brand-sheet.png', await sharp(Buffer.from(sheet), { density: 72 }).resize(1400, 960).png({ compressionLevel: 9 }).toBuffer());
}
