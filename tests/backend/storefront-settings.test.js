// Storefront settings
import assert from 'node:assert/strict';
import { normalizeCampaign, validateCampaign } from '../../apps/api/src/storefront-settings.js';
import { ADMIN_ROUTES, ROLE_PERMISSIONS } from '../../apps/api/src/permissions.js';

assert.deepEqual(normalizeCampaign(null), { mode: 'auto', categoryId: null, excluded: [], sceneId: 'fan' });
assert.deepEqual(normalizeCampaign({ mode: 'category' }), { mode: 'auto', categoryId: null, excluded: [], sceneId: 'fan' });
assert.deepEqual(normalizeCampaign({ mode: 'off', excluded: ['shorts', 'shorts', 3] }), { mode: 'off', categoryId: null, excluded: ['shorts'], sceneId: 'fan' });
assert.deepEqual(validateCampaign({ mode: 'auto', excluded: ['shorts'] }), { mode: 'auto', categoryId: null, excluded: ['shorts'] });
assert.deepEqual(validateCampaign({ mode: 'category', categoryId: 'zip-hoodies', excluded: [] }), { mode: 'category', categoryId: 'zip-hoodies', excluded: [] });
assert.throws(() => validateCampaign({ mode: 'category' }), /categoryId/);
assert.throws(() => validateCampaign({ mode: 'party' }), /mode/);
assert.throws(() => validateCampaign({ mode: 'auto', extra: 1 }), /Unknown field/);
assert.throws(() => validateCampaign({ mode: 'auto', excluded: [''] }), /excluded/);
assert.throws(() => validateCampaign({ mode: 'category', categoryId: 'no-such-category' }, { categories: [] }), /Unknown category/);
const put = ADMIN_ROUTES.find(r => r.id === 'storefront.campaign');
assert.equal(put.permission, 'settings.manage');
assert.ok(!ROLE_PERMISSIONS.manager.includes('settings.manage'), 'managers cannot change the campaign');
assert.equal(normalizeCampaign({ mode: 'auto', sceneId: 'rail' }).sceneId, 'rail');
assert.equal(normalizeCampaign({ sceneId: 'nope' }).sceneId, 'fan');
assert.equal(normalizeCampaign({ sceneId: 'floor' }).sceneId, 'fan', 'unavailable scene falls back');
assert.equal(normalizeCampaign({ sceneId: 7 }).sceneId, 'fan');
assert.deepEqual(validateCampaign({ mode: 'auto', sceneId: 'hooks' }), { mode: 'auto', categoryId: null, excluded: [], sceneId: 'hooks' });
assert.ok(!('sceneId' in validateCampaign({ mode: 'auto' })), 'omitted sceneId stays omitted');
assert.throws(() => validateCampaign({ mode: 'auto', sceneId: 'nope' }), /scene/);
assert.throws(() => validateCampaign({ mode: 'auto', sceneId: 'floor' }), /scene/);
console.log('storefront settings ok');

import { normalizeTicker, validateTicker } from '../../apps/api/src/storefront-settings.js';
assert.deepEqual(normalizeTicker(null).items.length, 3);
assert.deepEqual(normalizeTicker({ enabled: false, items: [] }), { enabled: false, items: [] });
assert.deepEqual(validateTicker({ enabled: true, items: ['  Нові   надходження ', ''] }), { enabled: true, items: ['Нові надходження'] });
assert.throws(() => validateTicker({ enabled: true, items: [] }), /at least one/);
assert.throws(() => validateTicker({ enabled: true, items: ['x'.repeat(41)] }), /40/);
assert.throws(() => validateTicker({ enabled: true, items: Array(9).fill('a') }), /At most/);
console.log('ticker settings ok');

import { normalizeCheckout, validateCheckout, PREPAYMENT_MAX_MINOR } from '../../apps/api/src/storefront-settings.js';
assert.deepEqual(normalizeCheckout(null), { prepaymentMinor: 0 });
assert.deepEqual(normalizeCheckout({ prepaymentMinor: 20000 }), { prepaymentMinor: 20000 });
for (const bad of [-1, 1.5, '200', PREPAYMENT_MAX_MINOR + 1, null]) assert.deepEqual(normalizeCheckout({ prepaymentMinor: bad }), { prepaymentMinor: 0 });
assert.deepEqual(validateCheckout({ prepaymentMinor: 0 }), { prepaymentMinor: 0 });
assert.deepEqual(validateCheckout({ prepaymentMinor: PREPAYMENT_MAX_MINOR }), { prepaymentMinor: PREPAYMENT_MAX_MINOR });
assert.throws(() => validateCheckout({ prepaymentMinor: 25.5 }), /prepaymentMinor/);
assert.throws(() => validateCheckout({ prepaymentMinor: 100, x: 1 }), /Unknown field/);
assert.equal(ADMIN_ROUTES.find(r => r.id === 'storefront.checkout').permission, 'settings.manage');

import { normalizeUaPhone, recipientNamePart, validateRecipient, recipientFullName, RECIPIENT_PART_MAX, RECIPIENT_NAME_FIELDS } from '../../packages/catalog/recipient.js';
assert.equal(normalizeUaPhone('050 123 45 67'), '+380501234567');
assert.equal(normalizeUaPhone('+38 (067) 123-45-67'), '+380671234567');
for (const bad of ['', '12345', '+38050123456', '+3805012345678', '0501234567x', 380501234567, null]) assert.equal(normalizeUaPhone(bad), null, String(bad));
// ПІБ is three separate parts, each Cyrillic/Latin letters with ʼ ' ’, hyphen or a single space inside.
assert.deepEqual(RECIPIENT_NAME_FIELDS, ['lastName', 'firstName', 'middleName']); assert.equal(RECIPIENT_PART_MAX, 40);
assert.equal(recipientNamePart('  Шевченко '), 'Шевченко');
for (const ok of ['Мар\u02BCяна', "Мар'яна", 'Мар\u2019яна', 'Ковальчук-Ліщук', 'Де  Ла  Крус', 'Smith', 'Їжак', 'Ґудзь', 'а'.repeat(40)]) assert.ok(recipientNamePart(ok), JSON.stringify(ok));
assert.equal(recipientNamePart('Де  Ла\tКрус'), 'Де Ла Крус', 'inner space runs collapse to one space');
assert.equal(recipientNamePart('Йосип'.normalize('NFD')), 'Йосип', 'NFC applied');
for (const bad of ['', '   ', 'а'.repeat(41), 'Тарас1', '-Тарас', 'Тарас-', "'Тарас", 'Тарас\u02BC', 'Та--рас', 'Тарас\nШевченко', 'Та\u200Bрас', 'Та\u202Eрас', 'Ταρας', '王', 'Ⅷ', 'ⅯⅯ', '\u0482ван', 'Іва\u0482н', 'Тарас!', 'Тарас.', 5, null])
  assert.equal(recipientNamePart(bad), null, JSON.stringify(bad));
const full = { lastName: ' Шевченко ', firstName: 'Тарас', middleName: 'Григорович', phone: '0501234567' };
assert.deepEqual(validateRecipient(full), { ok: true, recipient: { lastName: 'Шевченко', firstName: 'Тарас', middleName: 'Григорович', phone: '+380501234567' } });
assert.deepEqual(validateRecipient({ lastName: 'Ш1', firstName: '', middleName: 'Григорович', phone: 'x' }), { ok: false, fields: ['lastName', 'firstName', 'phone'] });
assert.deepEqual(validateRecipient({ lastName: 'Шевченко', firstName: 'Тарас', phone: '0501234567' }), { ok: false, fields: ['middleName'] }, 'every part is required');
assert.deepEqual(validateRecipient({ name: 'Шевченко Тарас', phone: '0501234567' }), { ok: false, fields: ['recipient'] }, 'the single-field shape is no longer accepted');
assert.deepEqual(validateRecipient({ ...full, name: 'x' }), { ok: false, fields: ['recipient'] });
assert.equal(recipientFullName({ lastName: 'Шевченко', firstName: 'Тарас', middleName: 'Григорович' }), 'Шевченко Тарас Григорович');
assert.equal(recipientFullName({ lastName: null, firstName: null, middleName: null, name: 'Коваль Олена' }), 'Коваль Олена', 'legacy single-field rows keep their single name');
assert.equal(recipientFullName({ name: 'Legacy', lastName: 'Шевченко', firstName: 'Тарас', middleName: 'Григорович' }), 'Шевченко Тарас Григорович', 'parts win');
assert.equal(recipientFullName(null), ''); assert.equal(recipientFullName({ lastName: 'Шевченко' }), '');
console.log('checkout settings and recipient ok');
