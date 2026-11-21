// Synthetic ~6 MB / ~10k-item EasyDrop feed; prints parse+normalize CPU time. No network.
import { normalizeEasyDrop } from '../apps/api/src/easydrop.js';
export function syntheticFeed(products = 930, sizes = 11) {
  const cats = Array.from({ length: 139 }, (_, i) => `<category id="${900000000000 + i}" >Brand${i} | Model  </category>`).join('\n');
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n<shop><catalog>${cats}</catalog><items>\n`;
  for (let p = 0; p < products; p++) for (let s = 0; s < sizes; s++) {
    const g = 10000 + p, stock = (p + s) % 3 === 0 ? 0 : 1 + (s % 5);
    out += `<item id="${7001000 + s}${g}" selling_type="r" group_id="${g}" available="${stock > 0}"><categoryId>${900000000000 + (p % 139)}</categoryId>\n<name>Brand Model ${p} 'Colour' TB-${p}</name>\n<priceuah>${1200 + (p % 40) * 100}</priceuah>\n<description>&lt;p&gt;Матеріал : Текстиль&lt;/p&gt;&lt;p&gt;Виробник : Тестляндія&lt;/p&gt;&lt;p&gt;${'Опис товару, що повторюється. '.repeat(1)}&lt;/p&gt;</description>\n<barcode>Z${p}-${s}</barcode>\n<vendorCode>Z${p}-${s}</vendorCode>\n<image>https://easydrop.one/media/uploads/images/base/00000000-0000-4000-8000-${String(p).padStart(12, '0')}.jpg</image>\n<param name="Розмір" unit="">${36 + s}</param>\n<available>${stock > 0}</available>${stock > 0 ? `\n<quantity_in_stock>${stock}</quantity_in_stock>` : ''}</item>\n`;
  }
  return out + '</items></shop>';
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const xml = syntheticFeed(), bytes = Buffer.byteLength(xml);
  const times = [];
  let result;
  for (let i = 0; i < 6; i++) { const t = performance.now(); result = normalizeEasyDrop(xml); times.push(performance.now() - t); }
  console.log(JSON.stringify({ bytes, ...result.stats, products: result.items.length, skipped: result.skipped.length, firstRunMs: +times[0].toFixed(1), warmMedianMs: +[...times.slice(1)].sort((a, b) => a - b)[2].toFixed(1) }));
}
