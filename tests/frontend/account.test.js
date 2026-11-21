import test from 'node:test';
import assert from 'node:assert/strict';
import { callbackMessage, cleanedUrl, parseRetryAfter, startErrorMessage, safeAuthorizationUrl, customerHandle, providerLabels } from '../../apps/web/src/account/account-helpers.js';

test('callback status maps to Ukrainian messages', () => {
  assert.equal(callbackMessage('?status=signed-in').type, 'success');
  for (const reason of ['invalid', 'expired', 'denied']) {
    const m = callbackMessage(`?status=error&reason=${reason}`);
    assert.equal(m.type, 'error');
    assert.match(m.text, /[а-яі]/i);
  }
  assert.notEqual(callbackMessage('?status=error&reason=invalid').text, callbackMessage('?status=error&reason=denied').text);
  assert.equal(callbackMessage('?status=error&reason=__proto__').type, 'error');
  assert.equal(callbackMessage('?status=error').type, 'error');
  assert.equal(callbackMessage(''), null);
  assert.equal(callbackMessage('?status=linked'), null);
});

test('cleanedUrl drops only status and reason', () => {
  assert.equal(cleanedUrl('/account', '?status=error&reason=expired'), '/account');
  assert.equal(cleanedUrl('/account', '?status=signed-in&x=1', '#a'), '/account?x=1#a');
});

test('Retry-After parsing and start errors', () => {
  assert.equal(parseRetryAfter('30'), 30);
  assert.equal(parseRetryAfter('1.2'), 2);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('junk'), null);
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', Date.parse('2026-01-01T00:00:00Z')), 60);
  assert.match(startErrorMessage(503), /тимчасово недоступний/);
  assert.match(startErrorMessage(429, '45'), /45/);
  assert.match(startErrorMessage(429), /Забагато/);
  assert.match(startErrorMessage(0), /зв’язку/);
  assert.match(startErrorMessage(500), /Не вдалося/);
});

test('authorization URL must be Google (or loopback on loopback pages)', () => {
  const g = 'https://accounts.google.com/o/oauth2/v2/auth?a=1';
  assert.equal(safeAuthorizationUrl(g, 'shop.example'), g);
  assert.equal(safeAuthorizationUrl('https://evil.example/', 'shop.example'), null);
  assert.equal(safeAuthorizationUrl('https://accounts.google.com:8443/x', 'shop.example'), null);
  assert.equal(safeAuthorizationUrl('javascript:alert(1)'), null);
  assert.equal(safeAuthorizationUrl(undefined), null);
  assert.equal(safeAuthorizationUrl('http://127.0.0.1:1/x', 'shop.example'), null);
  assert.ok(safeAuthorizationUrl('http://127.0.0.1:1/x', '127.0.0.1'));
});

test('customer display helpers', () => {
  assert.equal(customerHandle({ signInEmail: 'a@b.c', displayName: 'A' }), 'a@b.c');
  assert.equal(customerHandle({ signInEmail: null, displayName: 'A' }), 'A');
  assert.equal(customerHandle({}), 'Кабінет');
  assert.deepEqual(providerLabels(['google', 'x']), ['Google', 'x']);
});

import { deliveryView, deliveryErrorMessage, noteForSave, cartDeliveryText, pointText, ORIGIN_LABELS, LEGACY_PROMPT, NOTE_MAX, NOTE_RULE_MESSAGE } from '../../apps/web/src/account/account-helpers.js';

const pref = { type: 'postomat', cityName: 'Київ', cityRef: 'c', warehouseNumber: '12', warehouseRef: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', warehouseName: 'Поштомат №12', note: null, source: 'np-api', origin: 'cabinet' };

test('delivery view: favourite origins and promotion', () => {
  const cab = deliveryView(pref);
  assert.equal(cab.kind, 'favourite');
  assert.equal(cab.originLabel, 'Улюблений');
  assert.equal(cab.canPromote, false);
  assert.match(cab.text, /Поштомат, Київ: Поштомат №12/);
  const auto = deliveryView({ ...pref, origin: 'checkout' });
  assert.equal(auto.originLabel, ORIGIN_LABELS.checkout);
  assert.equal(auto.canPromote, true);
  assert.equal(deliveryView(null).kind, 'none');
});

test('delivery view: legacy preferences are read-only with the prompt', () => {
  const withRef = deliveryView({ ...pref, source: 'manual', origin: null, warehouseName: null });
  const noRef = deliveryView({ type: 'branch', cityName: 'Львів', cityRef: null, warehouseNumber: '5', warehouseRef: null, warehouseName: null, note: 'дзвоніть', source: 'manual', origin: null });
  for (const v of [withRef, noRef]) { assert.equal(v.kind, 'legacy'); assert.equal(v.prompt, LEGACY_PROMPT); assert.equal(v.canPromote, undefined); }
  assert.equal(noRef.text, 'Відділення, Львів: №5');
  assert.equal(noRef.note, 'дзвоніть');
  // an np-api row without a Ref is not selectable either
  assert.equal(deliveryView({ ...pref, warehouseRef: null }).kind, 'legacy');
});

test('delivery errors use fixed texts', () => {
  const t = [400, 429, 503, 0, 500].map(deliveryErrorMessage);
  assert.equal(new Set(t).size, 5);
  assert.match(t[0], /зі списку/); assert.match(t[1], /Забагато/); assert.match(t[2], /Довідник Нової пошти/);
});

test('note: trimmed, blank is null, 200 characters max', () => {
  assert.deepEqual(noteForSave('  привіт  '), { note: 'привіт' });
  assert.deepEqual(noteForSave('   '), { note: null });
  assert.deepEqual(noteForSave(undefined), { note: null });
  assert.equal(noteForSave('я'.repeat(NOTE_MAX)).note.length, NOTE_MAX);
  assert.ok(noteForSave('я'.repeat(NOTE_MAX + 1)).error);
  assert.equal(noteForSave('😀'.repeat(NOTE_MAX)).error, undefined);
  assert.equal(noteForSave('a\nb').note, 'a\nb');
  for (const bad of ['a\nb\nc', 'a\tb', '👨\u200d👩', '\u200bx', '😀\u0000', '   \u200b ']) assert.equal(noteForSave(bad).error, NOTE_RULE_MESSAGE, JSON.stringify(bad));
});

test('cart delivery text', () => {
  assert.equal(cartDeliveryText(null), 'Пункт доставки не обрано');
  assert.match(cartDeliveryText({ type: 'branch', cityName: 'Одеса', warehouseNumber: '3', warehouseName: 'Відділення №3' }), /Відділення, Одеса: Відділення №3/);
  assert.equal(pointText(null), '');
});
