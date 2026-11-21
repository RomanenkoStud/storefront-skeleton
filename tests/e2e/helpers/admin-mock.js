// Shared, stateful, deterministic mock of the private manager API for browser specs.
// Generalized from manual-products.spec.js. Only the SPA shell comes from the task-local worker; every
// /api/auth/session, /api/staff/session, /api/admin/**, /api/staff/admin/**, /api/taxonomy and /api/products
// response is fulfilled here, so no real inventory or publication is touched and screenshots are stable.
//
//   const state = await mockAdmin(page, { staff: true, permissions: [...] });
//   await freezeBrowser(page);                // fonts blocked, Date fixed (use before page.goto)
//   await page.goto('/admin/catalog');
//
// Routes registered later win in Playwright, so a spec may override a single endpoint after mockAdmin().
import { CATEGORY_TREE, defaultRecognitionSettings } from '../../../packages/catalog/taxonomy.js';

export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==', 'base64');
export const OWNER_PERMISSIONS = [
  'catalog.read', 'products.edit', 'products.price', 'products.publish', 'products.trash', 'media.upload', 'media.read',
  'taxonomy.edit', 'taxonomy.delete', 'recognition.draft', 'recognition.apply', 'recognition.activate',
  'suppliers.sync', 'suppliers.manage', 'suppliers.manual', 'products.create', 'settings.manage',
  'orders.read', 'orders.operate', 'staff.read', 'staff.manage', 'audit.read',
];
export const MANAGER_PERMISSIONS = OWNER_PERMISSIONS.filter(p => !['staff.read', 'staff.manage', 'suppliers.manage', 'settings.manage', 'taxonomy.delete'].includes(p));
/** Fixed instant for page.clock and for every timestamp in the fixtures. */
export const FIXED_NOW = '2026-06-15T09:00:00.000Z';
const at = minutes => new Date(Date.parse(FIXED_NOW) - minutes * 60000).toISOString();

const flatten = (tree, parentId = null, out = []) => {
  tree.forEach((node, position) => { out.push({ id: node.id, label: node.label, parentId, position }); if (node.children) flatten(node.children, node.id, out); });
  return out;
};
export const taxonomyFixture = () => ({ revision: 1, nodes: flatten(CATEGORY_TREE), redirects: {} });

export const suppliersFixture = () => [
  { id: 's-md', name: 'Lorem Supply', provider: 'mydrop', url: 'https://mydrop.com.ua/demo_shop', enabled: true, feed: null, connectionId: '12', productCount: 4, publishedCount: 2, lastSyncAt: at(90), lastSuccessAt: at(90), lastSyncStatus: 'synced', lastSyncError: null },
  { id: 's-ed', name: 'Easy Feed', provider: 'easydrop', url: 'https://easydrop.one/feed/fixture', enabled: true, feed: { configured: true, keyLast4: '4821', updatedAt: at(3000) }, productCount: 1, publishedCount: 0, lastSyncAt: at(2000), lastSuccessAt: at(5000), lastSyncStatus: 'failed', lastSyncError: 'Фід тимчасово недоступний' },
  { id: 's-manual', name: 'Власний склад', provider: 'manual', url: 'manual:s-manual', enabled: true, feed: null, productCount: 1, publishedCount: 0, lastSyncAt: null, lastSyncStatus: null, lastSyncError: null },
];
export const adminProduct = (over = {}) => ({
  id: 'p-1', supplierId: 's-md', externalId: 'ext-1',
  source: { title: 'Футболка Lorem', description: 'Бавовна', category: 'Футболки', costMinor: 50000, variants: [{ size: 'M', stock: 2 }], photos: [] },
  overrides: {}, title: 'Футболка Lorem', description: 'Бавовна', category: 'Футболки', categoryId: 'unclassified', categoryPath: ['Без категорії'],
  brand: 'Lorem', slug: 'futbolka-lorem', priceMinor: 60000, currency: 'UAH', photos: ['/media/00000000-0000-4000-8000-000000000001.png'],
  variants: [{ size: 'M', stock: 2 }, { size: 'L', stock: 0 }], published: false, priceOverridden: false, ...over,
});
export const productsFixture = () => [
  adminProduct(),
  adminProduct({ id: 'p-2', externalId: 'ext-2', tags: ['Потрібне нове фото', 'promoted'], title: 'Худі Adipisci Originals з довгою назвою для перевірки переносу рядків у картці', brand: 'Adipisci', slug: 'hudi-adipisci', priceMinor: 189900, published: true, variants: [{ size: 'S', stock: 3 }, { size: 'M', stock: 1 }] }),
  adminProduct({ id: 'p-3', externalId: 'ext-3', title: 'Кросівки Nova Linea', brand: null, slug: 'krosivky', supplierId: 's-ed', priceMinor: 349900, published: true, priceOverridden: true, variants: [{ size: '42', stock: 5 }] }),
  adminProduct({ id: 'p-4', externalId: 'manual-1', title: 'Куртка власна', brand: null, slug: 'kurtka', supplierId: 's-manual', priceMinor: 259900, source: { title: 'Куртка власна', description: '', category: '', costMinor: 150000, variants: [{ size: 'L', stock: 1 }], photos: [] }, variants: [{ size: 'L', stock: 1 }] }),
];
export const syncRunsFixture = () => [
  { id: 'r-1', supplierId: 's-md', status: 'success', imported: 4, error: null, createdAt: at(90) },
  { id: 'r-2', supplierId: 's-ed', status: 'failed', imported: 0, error: 'Фід тимчасово недоступний, повторіть спробу пізніше', createdAt: at(2000) },
];
const dupProduct = (id, supplierId, supplierName, title, over = {}) => ({ id, supplierId, supplierName, supplierEnabled: true, title, sourceTitle: title, photo: '/media/00000000-0000-4000-8000-000000000001.png', brand: 'Lorem', category: 'Футболки', costMinor: 50000, priceMinor: 60000, stock: 3, sizes: [{ size: 'M', stock: 3 }], published: true, deletedAt: null, ...over });
export const duplicatesFixture = () => ({
  totals: { candidates: 1, groups: 1, rejections: 1 },
  products: {
    d1: dupProduct('d1', 's-md', 'Lorem Supply', 'Футболка Lorem Aero-knit'), d2: dupProduct('d2', 's-ed', 'Easy Feed', 'Lorem Aero-knit футболка', { sourceTitle: 'Lorem Aero-knit Tee', costMinor: 48000 }),
    d3: dupProduct('d3', 's-md', 'Lorem Supply', 'Шорти Aenean', { brand: 'Aenean' }), d4: dupProduct('d4', 's-ed', 'Easy Feed', 'Шорти Aenean', { brand: 'Aenean' }),
  },
  candidates: [{ key: 'k1', confidence: 'high', productIds: ['d1', 'd2'], groupProductIds: [], pairs: [{ reasons: [{ kind: 'photo' }, { kind: 'title', score: 0.92 }, { kind: 'brand', value: 'Lorem' }] }] }],
  groups: [{ id: 'g1', productIds: ['d3', 'd4'], createdAt: at(4000), updatedAt: at(4000), actor: 'qa@example.test', storefront: { visible: true, primaryId: 'd3', slug: 'shorty-aenean', priceMinor: 60000, sizes: [{ size: 'M', stock: 3 }] } }],
  rejections: [{ id: 'x1', productIds: ['d1', 'd3'], createdAt: at(5000), actor: 'qa@example.test' }],
});
export const recognitionFixture = () => {
  const settings = defaultRecognitionSettings();
  return {
    activeVersion: 'seed-v1',
    versions: [{ id: 'seed-v1', status: 'active', actor: 'system', createdAt: at(10000), settings }],
    applications: [{ productId: 'p-1', title: 'Футболка Lorem', versionId: 'seed-v1', actor: 'qa@example.test', appliedAt: at(300), evidence: { category: 'Футболки / поло', brand: 'Lorem', reasons: ['Назва містить «футболка»', 'Бренд у назві'] } }],
    defaults: settings,
  };
};
export const staffFixture = () => [
  { id: 'u-1', email: 'owner@example.test', invitedEmail: null, displayName: 'Власник', role: 'owner', status: 'active', activeSessions: 1, invitationExpiresAt: null },
  { id: 'u-2', email: 'manager@example.test', invitedEmail: null, displayName: 'Менеджер Олена', role: 'manager', status: 'active', activeSessions: 2, invitationExpiresAt: null },
  { id: 'u-3', email: null, invitedEmail: 'new@example.test', displayName: 'Запрошений', role: 'manager', status: 'invited', activeSessions: 0, invitationExpiresAt: at(-3000) },
];
export const auditFixture = () => [
  { id: 'a-1', createdAt: at(60), actor: 'owner@example.test', actorRole: 'owner', action: 'product.price.override', resourceId: 'p-3', details: { before: 330000, after: 349900 } },
  { id: 'a-2', createdAt: at(600), actor: 'manager@example.test', actorRole: 'manager', action: 'product.price.reset', resourceId: 'p-2', details: null },
];
const TRANSITIONS = { submitted: ['verified', 'cancelled'], verified: ['sent_to_suppliers', 'cancelled'], sent_to_suppliers: ['completed'], completed: [], cancelled: [] };
const cartLine = (over = {}) => ({ productId: 'p-1', title: 'Футболка Lorem', size: 'M', quantity: 2, unitCostMinor: 50000, unitPriceMinor: 60000, externalProductId: 'ext-1', variantIds: ['v-1'], supplierId: 's-md', supplierName: 'Lorem Supply', ...over });
export const cartsFixture = () => [
  { code: 'SS-7K2M-9QXD', status: 'submitted', createdAt: at(120), itemCount: 3, totalMinor: 189900, bound: true, allowedTransitions: TRANSITIONS.submitted, managerNote: '', statusActor: null, statusChangedAt: null, recipient: { lastName: 'Коваль', firstName: 'Олена', middleName: 'Петрівна', name: 'Коваль Олена Петрівна', phone: '+380501234567' }, delivery: { type: 'branch', cityName: 'Київ', warehouseNumber: '10', warehouseName: 'Відділення №10: вул. Хрещатик, 1' }, personalDataErasedAt: null, lines: [cartLine(), cartLine({ productId: 'p-3', title: 'Кросівки Nova Linea', size: '42', quantity: 1, unitCostMinor: null, unitPriceMinor: 69900, externalProductId: 'ext-3', variantIds: ['v-9', 'v-10'], supplierId: 's-ed', supplierName: 'Easy Feed' })] },
  { code: 'SS-3FGH-2JKM', status: 'verified', createdAt: at(1500), itemCount: 1, totalMinor: 60000, bound: false, allowedTransitions: TRANSITIONS.verified, managerNote: 'Перевірено', statusActor: 'owner@example.test', statusChangedAt: at(1400), recipient: null, delivery: null, personalDataErasedAt: null, lines: [cartLine({ quantity: 1 })] },
];

/**
 * Installs the mock. Options: staff (use /staff session + /staff/admin prefix), permissions, role, identity,
 * and per-collection overrides (suppliers, products, trashedProducts, runs, ...). Returns mutable state with
 * `calls` (every non-GET request: {method, path, body}) and the live collections.
 */
export async function mockAdmin(page, opts = {}) {
  const {
    staff = false, permissions = OWNER_PERMISSIONS, role = permissions.includes('staff.read') ? 'owner' : 'manager',
    email = 'qa@example.test', displayName = 'QA Менеджер',
  } = opts;
  const state = {
    calls: [], n: 0,
    suppliers: opts.suppliers ?? suppliersFixture(), products: opts.products ?? productsFixture(), trashedProducts: opts.trashedProducts ?? [],
    trashedSuppliers: opts.trashedSuppliers ?? [], runs: opts.runs ?? syncRunsFixture(), duplicates: opts.duplicates ?? duplicatesFixture(),
    recognition: opts.recognition ?? recognitionFixture(), staffMembers: opts.staffMembers ?? staffFixture(), audit: opts.audit ?? auditFixture(),
    carts: opts.carts ?? cartsFixture(), uploadFailures: opts.failUploads ?? 0,
    storefront: opts.storefront ?? { campaign: { mode: 'auto', categoryId: null, excluded: [] }, updatedAt: at(900), actor: 'owner@example.test', ticker: { enabled: true, items: ['Безкоштовна доставка від 2000 ₴', 'Нові надходження щотижня'] }, tickerUpdatedAt: at(900), tickerActor: 'owner@example.test', checkout: { prepaymentMinor: 20000 }, checkoutUpdatedAt: at(900), checkoutActor: 'owner@example.test' },
  };
  const identity = { email, displayName, role, permissions };
  const sessionPath = staff ? '**/api/staff/session' : '**/api/auth/session';
  await page.route(sessionPath, route => route.fulfill({ json: staff ? { authenticated: true, staff: { id: 'u-2', ...identity } } : { authenticated: true, ...identity } }));
  await page.route('**/api/taxonomy', route => route.fulfill({ json: taxonomyFixture() }));
  await page.route('**/api/products', route => route.fulfill({ json: { items: [] } }));
  await page.route(/\/media\/[^/]+\.png(\?.*)?$/, route => route.fulfill({ contentType: 'image/png', body: PNG }));
  await page.route('**/api/staff/{logout,sessions/revoke-all}', route => { state.calls.push({ method: 'POST', path: new URL(route.request().url()).pathname, body: null }); return route.fulfill({ json: { ok: true } }); });
  await page.route(/\/api\/(?:staff\/)?admin\/.*/, async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const path = url.pathname.replace(/^\/api\/(?:staff\/)?admin/, '');
    const multipart = request.headers()['content-type']?.startsWith('multipart');
    const body = request.postData() && !multipart ? JSON.parse(request.postData()) : null;
    if (method !== 'GET') state.calls.push({ method, path, body });
    const json = (data, status = 200) => route.fulfill({ status, json: data });
    const trash = !!url.searchParams.get('deleted');
    if (method === 'GET') {
      if (path === '/products') return json({ items: trash ? state.trashedProducts : state.products });
      if (path === '/suppliers') return json({ items: trash ? state.trashedSuppliers : state.suppliers, autoSync: { intervalMinutes: 60 } });
      if (path === '/sync-runs') return json({ items: state.runs });
      if (path === '/duplicates') return json(state.duplicates);
      if (path === '/recognition') return json(state.recognition);
      if (path === '/staff') return json({ items: state.staffMembers });
      if (path === '/audit') return json({ items: state.audit, next: null });
      if (path === '/storefront') return json(state.storefront);
      if (path === '/carts') return json({ carts: state.carts.map(({ lines, ...c }) => c), total: state.carts.length });
      const cart = /^\/carts\/([^/]+)$/.exec(path);
      if (cart) { const found = state.carts.find(c => c.code === decodeURIComponent(cart[1])); return found ? json({ cart: found }) : json({ error: 'not_found' }, 404); }
      return json({ items: [] });
    }
    if (method === 'POST' && path === '/suppliers/manual') { const s = { id: `s-new-${++state.n}`, name: body.name, provider: 'manual', url: `manual:s-new-${state.n}`, enabled: true, feed: null, productCount: 0, publishedCount: 0 }; state.suppliers.push(s); return json(s, 201); }
    if (method === 'POST' && path === '/products') { const p = adminProduct({ id: 'p-new', supplierId: body.supplierId, title: body.title, source: { title: body.title, description: body.description || '', category: '', costMinor: body.costMinor ?? body.priceMinor, variants: body.variants, photos: [] }, priceMinor: body.priceMinor, variants: body.variants }); state.products.push(p); return json(p, 201); }
    if (method === 'POST' && /^\/products\/[^/]+\/photos$/.test(path)) { if (state.uploadFailures > 0) { state.uploadFailures--; return json({ error: 'Сховище фото недоступне', code: 'storage-unavailable' }, 503); } return json({ url: `/media/00000000-0000-4000-8000-${String(++state.n).padStart(12, '0')}.png` }, 201); }
    if (method === 'POST' && path === '/products/bulk-tags') {
      const key = t => t.toLowerCase(), drop = new Set((body.remove ?? []).map(key));
      let updated = 0;
      state.products = state.products.map(p => {
        if (!body.ids.includes(p.id)) return p;
        const kept = (p.tags ?? []).filter(t => !drop.has(key(t))), have = new Set(kept.map(key));
        const tags = [...kept, ...(body.add ?? []).filter(t => !have.has(key(t)))];
        if (JSON.stringify(tags) !== JSON.stringify(p.tags ?? [])) updated++;
        return { ...p, tags };
      });
      return json({ updated, matched: body.ids.length });
    }
    const source = /^\/products\/([^/]+)\/source$/.exec(path);
    if (method === 'PATCH' && source) { const p = state.products.find(x => x.id === source[1]); const next = { ...p, title: body.title ?? p.title, source: { ...p.source, ...body }, photos: body.photos ?? p.photos }; state.products = state.products.map(x => (x.id === p.id ? next : x)); return json(next); }
    const patch = /^\/products\/([^/]+)$/.exec(path);
    if (method === 'PATCH' && patch) { const p = state.products.find(x => x.id === patch[1]) ?? state.products[0]; const next = { ...p, ...body }; state.products = state.products.map(x => (x.id === p.id ? next : x)); return json(next); }
    const status = /^\/carts\/([^/]+)\/status$/.exec(path);
    if (method === 'POST' && status) { const c = state.carts.find(x => x.code === decodeURIComponent(status[1])); Object.assign(c, { status: body.status, allowedTransitions: TRANSITIONS[body.status] ?? [], statusActor: email, statusChangedAt: FIXED_NOW }); return json({ cart: c }); }
    return json({ error: `unmocked ${method} ${path}` }, 404);
  });
  return state;
}

/**
 * Determinism for screenshots: Google Fonts blocked (fallback fonts are stable), Date fixed via page.clock,
 * animations/transitions/caret disabled by the screenshot options in the specs. Call before page.goto.
 */
export async function freezeBrowser(page) {
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.abort());
  await page.clock.setFixedTime(new Date(FIXED_NOW));
}
