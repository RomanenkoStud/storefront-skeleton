// Deterministic full-size synthetic upstream (about 53k points, about 9.6k cities) for CPU timing. Not real data.
import { reduceRecord } from '../../../packages/catalog/delivery.js';
import { guid, record } from './records.js';

export function fullSizeReduced({ cities = 9636, points = 52917, kyivPostomats = 7423 } = {}) {
  const out = [], push = (cityIndex, name, n, category) => { const r = reduceRecord(record({ Ref: `f${n}`, Number: String((n % 9999) + 1), CityRef: guid(`fc-${cityIndex}`), CityDescription: name, CategoryOfWarehouse: category, Description: `Пункт №${n}: вул. Тестова, ${n} (синтетичний рядок для вимірювання)` })); if (r) out.push(r); };
  for (let n = 0; n < kyivPostomats; n++) push(0, 'Київ', n, 'Postomat');
  const letters = 'абвгдежзиклмнопрстухцчшщюя';
  for (let n = kyivPostomats; n < points; n++) { const c = 1 + (n % (cities - 1)); push(c, `${letters[c % letters.length]}${c.toString(36)}-місто`, n, n % 3 ? 'Postomat' : 'Branch'); }
  return out;
}
