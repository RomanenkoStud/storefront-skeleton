// dashboard formatting and reminder logic.
import assert from 'node:assert/strict';
import { duration, bytes, compact, renewalState, niceScale, parseAmount, share, meterTone, percent, shortDay, longDay } from '../../apps/web/src/dashboard/dashboard-logic.js';
import { ADMIN_TOOLS, toolFromPath, toolPath } from '../../apps/web/src/admin-routes.js';

assert.equal(duration(0), '0 с');
assert.equal(duration(75), '1 хв 15 с');
assert.equal(duration(120), '2 хв');
assert.equal(duration(3700), '1 год 1 хв');
assert.equal(duration(NaN), '—');
assert.equal(bytes(999), '999 Б');
assert.equal(bytes(1500000), '1,50 МБ');
assert.equal(bytes(10e9), '10,0 ГБ');
assert.equal(bytes(null), '—');
assert.equal(compact(12500000), '12,5 млн');
assert.equal(compact(25e9), '25 млрд');
assert.equal(percent(0.256), '26%');
assert.equal(shortDay('2026-11-20'), '20.11');
assert.equal(longDay('2026-11-20'), '20.11.2026');

assert.deepEqual(renewalState(null, '2026-11-20'), { tone: 'warning', label: 'Дату не вказано', daysLeft: null });
assert.equal(renewalState('2026-11-18', '2026-11-20').label, 'Прострочено на 2 дн.');
assert.equal(renewalState('2026-11-20', '2026-11-20').tone, 'critical');
assert.equal(renewalState('2026-12-01', '2026-11-20').tone, 'critical');
assert.equal(renewalState('2026-12-15', '2026-11-20').tone, 'warning');
assert.equal(renewalState('2027-03-14', '2026-11-20').tone, 'ok');

assert.deepEqual(niceScale(0), { max: 1, ticks: [0, 1] });
assert.deepEqual(niceScale(7), { max: 8, ticks: [0, 2, 4, 6, 8] });
assert.equal(niceScale(123456).max >= 123456, true);

assert.equal(parseAmount(''), null);
assert.equal(parseAmount('1 200,50'), 120050);
assert.equal(parseAmount('450'), 45000);
assert.ok(Number.isNaN(parseAmount('-5')) && Number.isNaN(parseAmount('1,234')) && Number.isNaN(parseAmount('abc')));

assert.equal(share(5, 10), 0.5);
assert.equal(share(20, 10), 1);
assert.equal(share(null, 10), null);
assert.deepEqual([0.1, 0.75, 0.95, null].map(meterTone), ['ok', 'warning', 'critical', 'unknown']);

assert.ok(ADMIN_TOOLS.some(t => t.id === 'dashboard') && ADMIN_TOOLS.some(t => t.id === 'infra'));
assert.equal(toolFromPath('/admin/dashboard'), 'dashboard');
assert.equal(toolFromPath('/staff/infra'), 'infra');
assert.equal(toolPath('/admin', 'infra'), '/admin/infra');
console.log('dashboard logic ok');
