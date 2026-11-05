const test = require('node:test');
const assert = require('node:assert/strict');
const {
  products,
  getProduct,
  readProductPreferences,
  rememberProduct,
  setAutoEnter,
} = require('../.test-build/miniprogram/services/products.js');
const pagePath = require.resolve('../.test-build/miniprogram/pages/index/index.js');
const preferencesKey = 'cf-studio-products-v1';
const defaults = { lastProductId: '', autoEnter: true };
const select = (id = 'wl1') => ({ currentTarget: { dataset: { id } } });

function storageFixture(t, initial, overrides = {}) {
  let stored = structuredClone(initial);
  const calls = { reads: [], writes: [], redirects: [], updates: [] };
  const api = {
    getStorageSync(key) {
      calls.reads.push(key);
      assert.equal(key, preferencesKey);
      return structuredClone(stored);
    },
    setStorageSync(key, value) {
      assert.equal(key, preferencesKey);
      calls.writes.push(structuredClone(value));
      stored = structuredClone(value);
    },
    redirectTo(options) {
      calls.redirects.push(options);
    },
    ...overrides,
  };
  global.wx = api;
  t.after(() => {
    delete global.wx;
    delete global.Page;
  });
  return { api, calls, stored: () => structuredClone(stored) };
}

function pageFixture(t, initial, options = {}, overrides = {}) {
  const f = storageFixture(t, initial, overrides);
  let definition;
  global.Page = (value) => {
    definition = value;
  };
  delete require.cache[pagePath];
  require(pagePath);
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(update) {
      f.calls.updates.push(structuredClone(update));
      Object.assign(this.data, structuredClone(update));
    },
  };
  page.onLoad(options);
  page.onShow();
  t.after(() => page.onUnload());
  return { ...f, page };
}

test('the product catalog exposes only the available WL1 route', () => {
  assert.deepEqual(
    products.map((product) => product.id),
    ['wl1'],
  );
  assert.equal(getProduct('wl1').route, '/pages/wl1/index');
  for (const id of ['removed-product', '__proto__', null, undefined, {}, 0]) {
    assert.equal(getProduct(id), null);
  }
});

for (const stored of [undefined, null, '', 'wl1', 42, false, [], {}]) {
  test(`product preferences tolerate empty or malformed cache: ${JSON.stringify(stored)}`, (t) => {
    const f = storageFixture(t, stored);
    assert.deepEqual(readProductPreferences(), defaults);
    assert.deepEqual(f.calls.writes, []);
  });
}

test('preferences validate each field and discard products that no longer exist', (t) => {
  const f = storageFixture(t, { lastProductId: 'retired', autoEnter: false });
  assert.deepEqual(readProductPreferences(), { lastProductId: '', autoEnter: false });
  f.api.getStorageSync = () => ({ lastProductId: 'wl1', autoEnter: 'false' });
  assert.deepEqual(readProductPreferences(), { lastProductId: 'wl1', autoEnter: true });
  f.api.getStorageSync = () => ({ lastProductId: { id: 'wl1' }, autoEnter: false });
  assert.deepEqual(readProductPreferences(), { lastProductId: '', autoEnter: false });
});

test('reading unavailable storage falls back to manual selection without throwing', (t) => {
  storageFixture(t, undefined, {
    getStorageSync() {
      throw new Error('storage unavailable');
    },
  });
  assert.deepEqual(readProductPreferences(), defaults);
});

test('remembering the product and changing automatic entry preserve each other', (t) => {
  const f = storageFixture(t, { lastProductId: '', autoEnter: false });
  assert.equal(rememberProduct('wl1'), true);
  assert.deepEqual(f.stored(), { lastProductId: 'wl1', autoEnter: false });
  assert.equal(setAutoEnter(true), true);
  assert.deepEqual(f.stored(), { lastProductId: 'wl1', autoEnter: true });
  assert.equal(setAutoEnter(false), true);
  assert.deepEqual(readProductPreferences(), { lastProductId: 'wl1', autoEnter: false });
  const writes = f.calls.writes.length;
  assert.equal(rememberProduct('unknown'), false);
  assert.equal(f.calls.writes.length, writes);
  assert.deepEqual(f.stored(), { lastProductId: 'wl1', autoEnter: false });
});

test('storage write failures report failure and preserve the previous preference', (t) => {
  const f = storageFixture(
    t,
    { lastProductId: '', autoEnter: true },
    {
      setStorageSync() {
        throw new Error('storage full');
      },
    },
  );
  assert.equal(rememberProduct('wl1'), false);
  assert.equal(setAutoEnter(false), false);
  assert.deepEqual(f.stored(), defaults);
});

for (const stored of [undefined, { lastProductId: 'retired', autoEnter: true }]) {
  test(`first launch or an obsolete remembered product stays on the product cards: ${JSON.stringify(stored)}`, (t) => {
    const f = pageFixture(t, stored);
    assert.deepEqual(
      f.page.data.products.map((product) => product.id),
      ['wl1'],
    );
    assert.equal(f.page.data.lastProductId, '');
    assert.equal(f.page.data.openingId, '');
    assert.equal(f.calls.redirects.length, 0);
    assert.equal(f.calls.writes.length, 0);
  });
}

test('launch resumes the last product once without remembering an unfinished navigation', (t) => {
  const f = pageFixture(t, { lastProductId: 'wl1', autoEnter: true });
  assert.equal(f.page.data.lastProductId, 'wl1');
  assert.equal(f.page.data.openingId, 'wl1');
  assert.equal(f.calls.redirects.length, 1);
  assert.equal(f.calls.redirects[0].url, getProduct('wl1').route);
  f.page.onShow();
  f.page.openProduct(select());
  assert.equal(f.calls.redirects.length, 1);
  assert.equal(f.calls.writes.length, 0);
});

test('returning to choose a product suppresses automatic entry and preserves memory', (t) => {
  const initial = { lastProductId: 'wl1', autoEnter: true };
  const f = pageFixture(t, initial, { choose: '1' });
  assert.equal(f.calls.redirects.length, 0);
  assert.equal(f.page.data.lastProductId, 'wl1');
  assert.equal(f.page.data.autoEnter, true);
  assert.deepEqual(f.stored(), initial);
  f.page.openProduct(select());
  assert.equal(f.calls.redirects.length, 1);
});

test('automatic entry can be disabled while keeping the last-used card selected', (t) => {
  const f = pageFixture(t, { lastProductId: 'wl1', autoEnter: false });
  assert.equal(f.page.data.lastProductId, 'wl1');
  assert.equal(f.page.data.autoEnter, false);
  assert.equal(f.calls.redirects.length, 0);
  f.page.toggleAutoEnter({ detail: { value: true } });
  assert.equal(f.page.data.autoEnter, true);
  assert.deepEqual(f.stored(), { lastProductId: 'wl1', autoEnter: true });
  assert.equal(
    f.calls.redirects.length,
    0,
    'changing the switch must not immediately leave the page',
  );
});

test('manual selection ignores unknown cards, deduplicates taps and does not remember failed entry', (t) => {
  const f = pageFixture(t, undefined);
  f.page.openProduct(select('unknown'));
  assert.equal(f.calls.redirects.length, 0);
  f.page.openProduct(select());
  f.page.openProduct(select());
  assert.equal(f.calls.redirects.length, 1);
  assert.equal(f.page.data.openingId, 'wl1');
  assert.equal(f.calls.writes.length, 0);
  f.calls.redirects[0].fail({ errMsg: 'redirectTo:fail page not found' });
  assert.equal(f.page.data.openingId, '');
  assert.ok(f.page.data.error);
  assert.equal(f.calls.writes.length, 0);
  f.page.openProduct(select());
  assert.equal(f.calls.redirects.length, 2, 'an explicit retry is available after failure');
  assert.equal(f.page.data.error, '');
});

test('failed automatic navigation stays on the chooser across show cycles until a manual retry', (t) => {
  const f = pageFixture(t, { lastProductId: 'wl1', autoEnter: true });
  f.calls.redirects[0].fail({ errMsg: 'redirectTo:fail' });
  f.page.onHide();
  f.page.onShow();
  f.page.onShow();
  assert.equal(f.calls.redirects.length, 1);
  assert.ok(f.page.data.error);
  f.page.openProduct(select());
  assert.equal(f.calls.redirects.length, 2);
});

test('synchronous navigation failure leaves the chooser usable', (t) => {
  const f = pageFixture(
    t,
    { lastProductId: 'wl1', autoEnter: true },
    {},
    {
      redirectTo() {
        throw new Error('navigation unavailable');
      },
    },
  );
  assert.equal(f.page.data.openingId, '');
  assert.ok(f.page.data.error);
  assert.equal(f.calls.writes.length, 0);
});

test('storage read failure still allows manual navigation', (t) => {
  const f = pageFixture(
    t,
    undefined,
    {},
    {
      getStorageSync() {
        throw new Error('storage unavailable');
      },
    },
  );
  assert.equal(f.calls.redirects.length, 0);
  f.page.openProduct(select());
  assert.equal(f.calls.redirects.length, 1);
});

test('a failed automatic-entry setting shows a notice without changing the saved preference', (t) => {
  const initial = { lastProductId: 'wl1', autoEnter: true };
  const f = pageFixture(
    t,
    initial,
    { choose: '1' },
    {
      setStorageSync() {
        throw new Error('storage full');
      },
    },
  );
  f.page.toggleAutoEnter({ detail: { value: false } });
  assert.ok(f.page.data.storageNotice);
  assert.equal(f.page.data.autoEnter, true);
  assert.deepEqual(f.stored(), initial);
  assert.equal(f.calls.redirects.length, 0);
  f.page.openProduct(select());
  assert.equal(f.calls.redirects.length, 1);
});

for (const lifecycle of ['onHide', 'onUnload']) {
  test(`late navigation callbacks cannot update the page after ${lifecycle}`, (t) => {
    const f = pageFixture(t, undefined);
    f.page.openProduct(select());
    const pending = f.calls.redirects[0];
    f.page[lifecycle]();
    const data = structuredClone(f.page.data);
    const updates = f.calls.updates.length;
    pending.fail({ errMsg: 'redirectTo:fail late response' });
    if (pending.success) pending.success({ errMsg: 'redirectTo:ok' });
    if (pending.complete) pending.complete({ errMsg: 'redirectTo:fail late response' });
    assert.deepEqual(f.page.data, data);
    assert.equal(f.calls.updates.length, updates);
    assert.equal(f.calls.writes.length, 0);
  });
}

test('a stale navigation failure cannot disturb a new selection after returning from background', (t) => {
  const f = pageFixture(t, undefined);
  f.page.openProduct(select());
  const oldNavigation = f.calls.redirects[0];
  f.page.onHide();
  f.page.onShow();
  assert.equal(f.page.data.openingId, '');
  f.page.openProduct(select());
  assert.equal(f.calls.redirects.length, 2);
  const updates = f.calls.updates.length;
  oldNavigation.fail({ errMsg: 'redirectTo:fail old navigation' });
  assert.equal(f.calls.updates.length, updates);
  assert.equal(f.page.data.openingId, 'wl1');
  assert.equal(f.page.data.error, '');
  f.page.openProduct(select());
  assert.equal(f.calls.redirects.length, 2, 'the current navigation still prevents duplicate taps');
  f.calls.redirects[1].fail({ errMsg: 'redirectTo:fail current navigation' });
  assert.equal(f.page.data.openingId, '');
  assert.ok(f.page.data.error);
  assert.equal(f.calls.writes.length, 0);
});
