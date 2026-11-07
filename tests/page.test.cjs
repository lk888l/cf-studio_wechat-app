const test = require('node:test');
const assert = require('node:assert/strict');
const pagePath = require.resolve('../.test-build/miniprogram/pages/wl1/index.js');
const { enterBackground } = require('../.test-build/miniprogram/services/lifecycle.js');

async function flush() {
  for (let index = 0; index < 80; index++) await Promise.resolve();
}
const touch = (identifier, clientX = 100, clientY = 36) => ({ identifier, clientX, clientY });
const legTouch = (identifier, clientX = 544, clientY = 56) => touch(identifier, clientX, clientY);
const touchEvent = (changedTouches, touches = changedTouches) => ({ changedTouches, touches });
const datasetEvent = (dataset) => ({ currentTarget: { dataset } });
const frameText = (value) => Buffer.from(value).toString('ascii');
const isNeutral = (frame) => /^R 0 0 0 \d+\.\d$/.test(frame);

function fixture(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 });
  const handlers = new Map();
  const calls = {
    writes: [],
    connections: [],
    closes: [],
    redirects: [],
    selectorCallbacks: [],
    renders: [],
    renderCallbacks: [],
    scans: 0,
  };
  const calibrationReplies = {
    'uid\n': 'uid: 0123456789ABCDEF10203040\n',
    'anglebias\n': 'anglebias base=12.6000 effective=10.1234\n',
    'rollbias\n': 'rollbias base=-2.5000 raw=2.5000 effective=0.0000\n',
    ...overrides.calibrationReplies,
  };
  const success = (options) => options.success({ errMsg: 'ok' });
  const api = {
    openBluetoothAdapter: success,
    closeBluetoothAdapter: success,
    startBluetoothDevicesDiscovery(options) {
      calls.scans++;
      success(options);
    },
    stopBluetoothDevicesDiscovery: success,
    getBluetoothDevices(options) {
      options.success({ devices: [] });
    },
    createBLEConnection(options) {
      calls.connections.push(options.deviceId);
      success(options);
    },
    closeBLEConnection(options) {
      calls.closes.push(options.deviceId);
      success(options);
    },
    getBLEDeviceServices(options) {
      options.success({ services: [{ uuid: 'UART' }] });
    },
    getBLEDeviceCharacteristics(options) {
      options.success({
        characteristics: [
          { uuid: 'TX', properties: { write: true, notify: false, indicate: false, read: false } },
          { uuid: 'RX', properties: { write: false, notify: true, indicate: false, read: false } },
        ],
      });
    },
    notifyBLECharacteristicValueChange: success,
    writeBLECharacteristicValue(options) {
      const text = frameText(options.value);
      calls.writes.push({ text, at: Date.now(), options });
      success(options);
      const reply = calibrationReplies[text];
      if (reply)
        queueMicrotask(() => {
          for (const handler of handlers.get('BLECharacteristicValueChange'))
            handler({
              deviceId: options.deviceId,
              serviceId: options.serviceId,
              characteristicId: options.characteristicId === 'FFE2' ? 'FFE1' : 'RX',
              value: Uint8Array.from(Buffer.from(reply)).buffer,
            });
        });
    },
    setClipboardData: success,
    showModal: (options) => options.success({ confirm: false, cancel: true }),
    getStorageSync: () => '',
    setStorageSync: () => undefined,
    redirectTo(options) {
      calls.redirects.push(options);
      options.success?.({ errMsg: 'redirectTo:ok' });
    },
    ...overrides,
  };
  for (const name of [
    'BluetoothDeviceFound',
    'BluetoothAdapterStateChange',
    'BLEConnectionStateChange',
    'BLECharacteristicValueChange',
  ]) {
    handlers.set(name, new Set());
    api[`on${name}`] = (handler) => handlers.get(name).add(handler);
    api[`off${name}`] = (handler) => handlers.get(name).delete(handler);
  }
  global.wx = api;
  let definition;
  global.Page = (options) => {
    definition = options;
  };
  delete require.cache[pagePath];
  require(pagePath);
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    subscriptions: [],
    setData(update, callback) {
      calls.renders.push(structuredClone(update));
      for (const [key, value] of Object.entries(structuredClone(update))) {
        const segments = key.replace(/\[(\d+)\]/g, '.$1').split('.');
        let target = this.data;
        for (const segment of segments.slice(0, -1)) target = target[segment];
        target[segments.at(-1)] = value;
      }
      if (callback) {
        if (this.deferRender) calls.renderCallbacks.push(callback);
        else callback();
      }
    },
    createSelectorQuery() {
      let callback;
      let selector;
      return {
        select(value) {
          selector = value;
          return this;
        },
        boundingClientRect(value) {
          callback = value;
          return this;
        },
        exec() {
          const deliver = () =>
            callback({
              left: selector === '#leg-joystick' ? 400 : 0,
              top: 0,
              width: 200,
              height: 200,
            });
          calls.selectorCallbacks.push(deliver);
          if (!page.deferSelector) deliver();
        },
      };
    },
  };
  page.onLoad();
  page.onShow();
  const f = {
    page,
    api,
    calls,
    handlers,
    emit(name, value) {
      for (const handler of handlers.get(name)) handler(value);
    },
    async advance(milliseconds = 25) {
      await flush();
      t.mock.timers.tick(milliseconds);
      await flush();
    },
    async demo() {
      page.toggleDemo();
      await flush();
      assert.equal(page.data.demo, true);
    },
    async connected() {
      page.connectDevice(datasetEvent({ id: 'robot' }));
      await flush();
      assert.equal(page.data.ble.status, 'selecting');
      page.selectEndpoint(datasetEvent({ index: 0 }));
      await flush();
      assert.equal(page.data.ready, true);
      for (let index = 0; index < 3; index++) await f.advance(30);
      if (page.data.ble.endpoint.notifyId) assert.equal(page.data.deviceInfo.busy, '');
      calls.writes.length = 0;
    },
    async move(identifier = 7) {
      page.toggleArmed();
      await flush();
      assert.equal(page.data.armed, true);
      page.onJoystickStart(touchEvent([touch(identifier)]));
      await f.advance(100);
      assert.ok(page.controller.snapshot().control.speed > 0);
    },
  };
  t.after(async () => {
    if (!page.destroyed) page.onUnload();
    for (let index = 0; index < 12; index++) await f.advance(1000);
    delete global.wx;
    delete global.Page;
  });
  return f;
}

test('WL1 scan pins the displayed name prefix and connects the same row after more broadcasts', async (t) => {
  const f = fixture(t);
  assert.equal(f.page.data.targetBluetoothName, 'D30LE_*');
  f.page.startScan();
  await flush();
  f.emit('BluetoothDeviceFound', {
    devices: [
      { deviceId: 'sensor', name: 'Nearby sensor', RSSI: -5 },
      { deviceId: 'car-a', localName: 'D30LE_A', RSSI: -90 },
    ],
  });
  assert.deepEqual(
    f.page.data.ble.devices.map((device) => device.deviceId),
    ['car-a', 'sensor'],
  );
  assert.equal(f.page.data.ble.devices[0].preferred, true);
  const selectedId = f.page.data.ble.devices[0].deviceId;
  f.emit('BluetoothDeviceFound', {
    devices: [
      { deviceId: 'car-b', name: 'D30LE_B', RSSI: -1 },
      { deviceId: 'car-a', RSSI: -100 },
      { deviceId: 'sensor', RSSI: -2 },
    ],
  });
  assert.deepEqual(
    f.page.data.ble.devices.map((device) => device.deviceId),
    ['car-a', 'car-b', 'sensor'],
  );
  assert.equal(f.page.data.ble.devices[0].deviceId, selectedId);
  f.page.connectDevice(datasetEvent({ id: selectedId }));
  await flush();
  assert.deepEqual(f.calls.connections, [selectedId]);
  assert.equal(f.page.data.ble.deviceName, 'D30LE_A');
  assert.equal(f.page.data.ble.status, 'selecting');
  f.emit('BluetoothDeviceFound', {
    devices: [{ deviceId: 'late-car', name: 'D30LE_LATE', RSSI: -1 }],
  });
  assert.equal(f.page.data.ble.devices.length, 3);
});

test('ZX-D30 connection is ready for control without manual endpoint selection', async (t) => {
  const f = fixture(t, {
    getBLEDeviceServices(options) {
      options.success({ services: [{ uuid: 'FFE0' }] });
    },
    getBLEDeviceCharacteristics(options) {
      options.success({
        characteristics: [
          { uuid: 'FFE1', properties: { write: true, notify: true } },
          { uuid: 'FFE2', properties: { write: true } },
        ],
      });
    },
  });
  f.page.connectDevice(datasetEvent({ id: 'robot' }));
  await flush();
  assert.equal(f.page.data.ble.status, 'ready');
  assert.equal(f.page.data.ble.endpoint.writeId, 'FFE2');
  assert.equal(f.page.data.ready, true);
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.armed, false);
  await f.move();
  assert.ok(f.calls.writes.length > 0);
  assert.ok(f.calls.writes.every((write) => write.options.characteristicId === 'FFE2'));
  assert.ok(
    f.calls.writes
      .filter((write) => write.text.startsWith('R '))
      .every((write) => !write.text.endsWith('\n')),
  );
});

const tuningInput = (id, value) => ({ currentTarget: { dataset: { id } }, detail: { value } });

function receiveParameters(f, text) {
  f.emit('BLECharacteristicValueChange', {
    deviceId: 'robot',
    serviceId: 'UART',
    characteristicId: 'RX',
    value: Uint8Array.from(Buffer.from(text)).buffer,
  });
}

// Exercise the actual WXS -> page -> controller path, including delayed view
// config delivery. The knob is observable without a setData render callback.
function stickView(f) {
  const module = { exports: {} };
  require('node:vm').runInNewContext(
    require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../miniprogram/pages/wl1/joystick.wxs'),
      'utf8',
    ),
    { module, Math },
  );
  const wxs = module.exports;
  const styles = {};
  const states = { motion: {}, pose: {} };
  const instances = Object.fromEntries(
    Object.keys(states).map((side) => [side, { getState: () => states[side] }]),
  );
  const owner = {
    selectComponent: (id) => ({ setStyle: (style) => (styles[id] = style) }),
    callMethod: (name, data) => f.page[name](structuredClone(data)),
  };
  const view = {
    styles,
    sync() {
      for (const side of ['motion', 'pose']) {
        wxs.configure(
          {
            side,
            rect: f.page.data[side === 'motion' ? 'motionRect' : 'poseRect'],
            enabled: f.page.data.armed && f.page.data.ready,
            epoch: f.page.data[side === 'motion' ? 'motionViewEpoch' : 'poseViewEpoch'],
          },
          null,
          owner,
          instances[side],
        );
      }
    },
    emit(side, phase, changedTouches, touches = changedTouches) {
      wxs[phase](
        { instance: instances[side], type: `touch${phase}`, changedTouches, touches },
        owner,
      );
    },
  };
  view.sync();
  return view;
}

test('WXS dual-stick dragging paints locally while instrument updates stay bounded', async (t) => {
  const f = fixture(t);
  await f.demo();
  f.page.onReady();
  f.page.toggleArmed();
  const view = stickView(f);
  view.emit('motion', 'start', [touch(1, 100, 100)]);
  view.emit('pose', 'start', [legTouch(2, 500, 100)]);
  f.calls.renders.length = 0;
  const selectorCount = f.calls.selectorCallbacks.length;
  for (let index = 0; index < 200; index++) {
    const y = 40 + (index % 50);
    view.emit('motion', 'move', [touch(1, 100, y)]);
    view.emit('pose', 'move', [legTouch(2, 530, y)]);
    await f.advance(5);
  }
  assert.ok(f.calls.renders.length <= 10, `${f.calls.renders.length} instrument renders in 1 s`);
  assert.ok(f.calls.renders.every((patch) => !('knobX' in patch) && !('legKnobX' in patch)));
  assert.ok(f.calls.renders.every((patch) => !('logs' in patch)));
  assert.equal(f.calls.selectorCallbacks.length, selectorCount);
  assert.match(view.styles['#motion-knob'].transform, /-11px/);
  assert.notEqual(f.page.controller.snapshot().control.speed, 0);
  await f.advance(100);
  assert.deepEqual(f.page.data.control, f.page.controller.snapshot().control);
  assert.equal(f.calls.writes.length, 0, 'SIM still never writes BLE');
});

test('slow render callbacks coalesce readings without delaying motion or release', async (t) => {
  const f = fixture(t);
  await f.demo();
  f.page.onReady();
  f.page.toggleArmed();
  const view = stickView(f);
  view.emit('motion', 'start', [touch(1, 100, 100)]);
  await f.advance(100);
  f.page.deferRender = true;
  view.emit('motion', 'move', [touch(1, 100, 36)]);
  await f.advance(100);
  const renderCount = f.calls.renders.length;
  view.emit('motion', 'move', [touch(1, 100, 164)]);
  await f.advance(300);
  assert.equal(f.calls.renders.length, renderCount);
  assert.equal(f.page.controller.snapshot().control.speed, -100);
  assert.equal(f.page.data.control.speed, 100, 'only the instrument is waiting for rendering');
  assert.equal(view.styles['#motion-knob'].transform, 'translate3d(0px, 64px, 0)');
  view.emit('motion', 'end', [touch(1, 100, 164)], []);
  assert.equal(f.page.controller.snapshot().control.speed, 0);
  assert.equal(view.styles['#motion-knob'].transform, 'translate3d(0px, 0px, 0)');
  f.page.deferRender = false;
  for (const callback of f.calls.renderCallbacks.splice(0)) callback();
  await f.advance(100);
  assert.equal(f.page.data.control.speed, 0, 'old queued motion cannot redraw after release');
});

test('rapid WXS re-grabs work before view config updates, but stopped gestures stay invalid', async (t) => {
  const f = fixture(t);
  await f.demo();
  f.page.onReady();
  f.page.toggleArmed();
  const view = stickView(f);
  for (let index = 0; index < 3; index++) {
    view.emit('motion', 'start', [touch(1)]);
    view.emit('pose', 'start', [legTouch(2)]);
    assert.equal(f.page.controller.snapshot().motionHolding, true);
    assert.equal(f.page.controller.snapshot().poseHolding, true);
    view.emit('motion', 'end', [touch(1)], [legTouch(2)]);
    view.emit('pose', 'end', [legTouch(2)], []);
    assert.equal(f.page.controller.snapshot().control.speed, 0);
    assert.equal(f.page.controller.snapshot().control.roll, 0);
  }
  f.page.stopMotion();
  await flush();
  f.page.toggleArmed();
  view.emit('motion', 'start', [touch(1)]); // Old rendered epoch, delivered late.
  assert.equal(f.page.controller.snapshot().motionHolding, false);
  assert.equal(f.page.controller.snapshot().control.speed, 0);
  view.sync();
  view.emit('motion', 'start', [touch(1)]);
  assert.equal(f.page.controller.snapshot().control.speed, 100);
});

test('layout queries retain the newest touch and cached bounds survive re-grabs', async (t) => {
  const f = fixture(t);
  await f.demo();
  f.page.toggleArmed();
  f.page.deferSelector = true;
  f.page.onJoystickStart(touchEvent([touch(1, 100, 100)]));
  f.page.onJoystickMove(touchEvent([touch(1, 100, 164)]));
  f.calls.selectorCallbacks[0]();
  assert.equal(f.page.controller.snapshot().control.speed, -100);
  f.page.onJoystickEnd(touchEvent([touch(1)], []));
  f.page.onJoystickStart(touchEvent([touch(2)]));
  assert.equal(f.calls.selectorCallbacks.length, 1);
  assert.equal(f.page.controller.snapshot().control.speed, 100);
  f.page.onResize();
  assert.equal(f.page.controller.snapshot().control.speed, 0);
  assert.equal(f.page.joystickRect, null);
});

test('logs stay in memory offscreen, refresh on entry and copy the latest buffered record', async (t) => {
  let clipboard = '';
  const f = fixture(t, { setClipboardData: (options) => (clipboard = options.data) });
  f.calls.renders.length = 0;
  for (let index = 0; index < 100; index++) f.page.addLog('RX', `record ${index}`);
  await f.advance(500);
  assert.equal(f.page.logEntries.length, 60);
  assert.ok(f.calls.renders.every((patch) => !('logs' in patch)));
  f.page.switchTab(datasetEvent({ tab: 'console' }));
  assert.equal(f.page.data.logs[0].text, 'record 99');
  f.page.addLog('RX', 'latest record');
  f.page.copyLogs();
  assert.match(clipboard, /latest record/);
  f.page.clearLogs();
  await f.advance(100);
  assert.deepEqual(f.page.data.logs, []);
  assert.deepEqual(f.page.logEntries, []);
});

test('queued readings cannot restore motion after page hide or unload', async (t) => {
  const f = fixture(t);
  await f.demo();
  f.page.onReady();
  f.page.toggleArmed();
  const view = stickView(f);
  view.emit('motion', 'start', [touch(1)]);
  assert.ok(f.page.pendingView);
  f.page.onHide();
  assert.equal(f.page.data.control.speed, 0);
  await f.advance(500);
  assert.equal(f.page.data.control.speed, 0);
  f.page.onUnload();
  const count = f.calls.renders.length;
  await f.advance(500);
  assert.equal(f.calls.renders.length, count);
});

test('a render interrupted by backgrounding cannot stall the next foreground session', async (t) => {
  const f = fixture(t);
  await f.demo();
  f.page.onReady();
  f.page.toggleArmed();
  const view = stickView(f);
  view.emit('motion', 'start', [touch(1)]);
  f.page.deferRender = true;
  await f.advance(100);
  assert.ok(f.page.viewInFlight > 0);
  f.page.onHide();
  await f.advance(500);
  assert.equal(f.page.viewInFlight, 0);
  f.page.deferRender = false;
  f.page.onShow();
  f.page.toggleArmed();
  view.sync();
  view.emit('motion', 'start', [touch(2, 100, 164)]);
  await f.advance(100);
  assert.equal(f.page.data.control.speed, -100);
  for (const callback of f.calls.renderCallbacks.splice(0)) callback();
  assert.equal(f.page.viewInFlight, 0, 'old callbacks cannot change the new render count');
});
const disarmedParameters = 'params: flash_valid=true unsaved=true armed=false enabled=false\n';
async function connectedMain(f) {
  await f.connected();
  assert.equal(f.page.data.parameterAvailable, true);
}

test('connection handshake fills both midpoint editors from this car and can read again', async (t) => {
  const f = fixture(t, {
    calibrationReplies: {
      'uid\n': 'uid: AABBCCDD0011223344556677\n',
      'anglebias\n': 'anglebias base=9.5371 effective=7.2134\n',
      'rollbias\n': 'rollbias base=-2.5312 raw=2.5000 effective=-0.0312\n',
    },
  });
  await f.connected();
  assert.equal(f.page.data.deviceInfo.uid, 'AABBCCDD0011223344556677');
  assert.equal(f.page.findTuningParameter('angle-bias').draft, '9.5371');
  assert.equal(f.page.findTuningParameter('roll-bias').draft, '-2.5312');
  assert.equal(f.page.findTuningParameter('angle-bias').status, '已从本车读取 · 未修改');
  assert.equal(f.page.data.deviceInfo.angleBias.effective, 7.2134);
  assert.equal(f.page.data.deviceInfo.rollBias.raw, 2.5);
  assert.deepEqual(f.calls.writes, []);
  f.page.onTuningInput(tuningInput('roll-bias', '-2.4312'));
  f.page.sendTuningParameter(datasetEvent({ id: 'roll-bias' }));
  await f.advance();
  assert.equal(f.calls.writes.at(-1).text, 'rollbias -2.4312');
  assert.equal(f.page.data.deviceInfo.rollBias, null);
  f.page.refreshDeviceInfo();
  for (let index = 0; index < 3; index++) await f.advance(30);
  assert.equal(f.page.findTuningParameter('roll-bias').draft, '-2.5312');
});

test('without return notifications the editors require a read or manual value', async (t) => {
  const f = fixture(t, {
    notifyBLECharacteristicValueChange: (options) => options.fail({ errCode: 10007 }),
  });
  await f.connected();
  assert.equal(f.page.data.deviceInfo.uid, '');
  assert.equal(f.page.findTuningParameter('angle-bias').draft, '');
  assert.equal(f.page.findTuningParameter('roll-bias').draft, '');
  assert.match(f.page.data.deviceInfo.message, /无法读取/);
  f.page.onTuningInput(tuningInput('angle-bias', '10.5'));
  f.page.sendTuningParameter(datasetEvent({ id: 'angle-bias' }));
  await f.advance();
  assert.equal(f.calls.writes.at(-1).text, 'anglebias 10.5');
});
test('page save immediately writes save without opening a panel, querying or confirming', async (t) => {
  const f = fixture(t);
  await connectedMain(f);
  f.api.showModal = () => assert.fail('save must not show a confirmation');
  const before = f.calls.writes.length;
  // Dispatch the real primary button binding, so a modal-only entry cannot regress.
  const template = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../miniprogram/pages/wl1/index.wxml'),
    'utf8',
  );
  const button = template.match(/<button\s+class="parameter-entry"[\s\S]*?<\/button>/)[0];
  const handler = button.match(/bindtap="([^"]+)"/)[1];
  f.page[handler]();
  f.page.saveParameters();
  f.page.toggleArmed();
  f.page.sendTuningParameter(datasetEvent({ id: 'velocity-i' }));
  assert.equal(f.page.data.armed, false);
  await f.advance();
  assert.equal(f.page.data.parameterPanelOpen, false);
  assert.deepEqual(
    f.calls.writes.slice(before).map((write) => write.text),
    ['save\n'],
  );
  assert.equal(f.calls.writes.at(-1).text, 'save\n');
  assert.equal(f.page.data.parameters.success, false);
  receiveParameters(f, 'OK\nnRF: send success\nsave: unchanged (no flash write)\r');
  assert.equal(f.page.data.parameters.busy, 'save');
  receiveParameters(f, '\n');
  await flush();
  assert.equal(f.page.data.parameters.success, true);
  assert.equal(f.page.data.parameters.status, null);
  assert.equal(f.page.data.parameters.message, '参数未变化，已经保存');
  assert.equal(f.calls.writes.filter((write) => write.text === 'save\n').length, 1);
  assert.ok(!f.calls.writes.some((write) => /control |recycle|velocitypid/.test(write.text)));
});

for (const changedOneParameter of [false, true]) {
  test(`page directly saves car parameters after sending ${changedOneParameter ? 'only one item' : 'no items'}`, async (t) => {
    const f = fixture(t);
    await connectedMain(f);
    if (changedOneParameter) {
      const beforeTuning = f.calls.writes.length;
      f.page.onTuningInput(tuningInput('velocity-i', '0.009'));
      f.page.sendTuningParameter(datasetEvent({ id: 'velocity-i' }));
      await f.advance();
      assert.equal(
        f.calls.writes
          .slice(beforeTuning)
          .map((write) => write.text)
          .join(''),
        'velocitypid -i 0.009',
      );
      // An unfinished draft must not block saving values already on the car.
      f.page.onTuningInput(tuningInput('angle-bias', '-'));
    }
    assert.equal(f.page.findTuningParameter('roll-i').status, '固件参考值 · 未发送');
    assert.equal(f.page.data.parameters.status, null);
    const before = f.calls.writes.length;
    f.page.saveParameters();
    await f.advance();
    assert.deepEqual(
      f.calls.writes.slice(before).map((write) => write.text),
      ['save\n'],
    );
    receiveParameters(f, changedOneParameter ? 'save: ok\n' : 'save: unchanged\n');
    await flush();
    assert.equal(f.page.data.parameters.success, true);
    assert.equal(f.page.data.parameters.status, null);
  });
}

for (const result of ['ok (all motion parameters)', 'unchanged (no flash write)']) {
  test(`runtime save ${result} keeps both joysticks and periodic BLE motion active`, async (t) => {
    const f = fixture(t);
    await connectedMain(f);
    await f.move();
    f.page.onLegJoystickStart(touchEvent([legTouch(8)]));
    const target = { ...f.page.controller.snapshot().control };
    const pointer = f.page.touchId;
    const legPointer = f.page.legTouchId;
    f.page.queryParameters();
    await f.advance();
    receiveParameters(f, 'params: unsaved=true armed=true enabled=true\n');
    await flush();
    const before = f.calls.writes.length;
    f.page.saveParameters();
    await f.advance();
    assert.deepEqual(
      f.calls.writes.slice(before).map((write) => write.text),
      ['save\n'],
    );
    assert.equal(f.page.data.parameterPanelOpen, false);
    assert.equal(f.page.data.armed, true);
    assert.equal(f.page.touchId, pointer);
    assert.equal(f.page.legTouchId, legPointer);
    assert.deepEqual(f.page.controller.snapshot().control, target);
    const afterSave = f.calls.writes.length;
    for (let index = 0; index < 5; index++) await f.advance(100);
    assert.ok(
      f.calls.writes.length >= afterSave + 5,
      'motion keeps refreshing while save is pending',
    );
    assert.ok(f.calls.writes.slice(afterSave).every((write) => write.text.startsWith('R ')));
    assert.equal(f.page.data.parameters.busy, 'save');
    f.page.onJoystickMove(touchEvent([touch(7, 100, 164)]));
    f.page.onLegJoystickMove(touchEvent([legTouch(8, 436, 100)]));
    await f.advance(100);
    const updatedTarget = { ...f.page.controller.snapshot().control };
    assert.ok(updatedTarget.speed < 0);
    assert.ok(updatedTarget.roll < 0);
    receiveParameters(f, `save: ${result}\r`);
    assert.equal(f.page.data.parameters.busy, 'save');
    receiveParameters(f, '\n');
    await flush();
    assert.equal(f.page.data.parameters.success, true);
    assert.equal(f.page.data.parameters.busy, '');
    assert.equal(f.page.data.armed, true);
    assert.equal(f.page.touchId, pointer);
    assert.equal(f.page.legTouchId, legPointer);
    assert.deepEqual(f.page.controller.snapshot().control, updatedTarget);
    assert.deepEqual(
      f.calls.writes
        .slice(before)
        .filter((write) => !write.text.startsWith('R '))
        .map((write) => write.text),
      ['save\n'],
    );
    const afterResult = f.calls.writes.length;
    await f.advance(100);
    assert.ok(f.calls.writes.length > afterResult, 'motion keeps refreshing after save succeeds');
  });
}

test('page closes firmware control only after support confirmation and checks params after off ACK', async (t) => {
  let modal;
  const f = fixture(t, {
    showModal: (options) => {
      modal = options;
    },
  });
  await connectedMain(f);
  f.page.toggleArmed();
  await f.advance();
  const off = f.page.disableFirmwareControl();
  assert.match(modal.content, /扶稳车体/);
  assert.ok(!f.calls.writes.some((write) => write.text === 'control off\n'));
  modal.success({ confirm: true });
  await f.advance();
  await f.advance();
  assert.equal(f.page.data.armed, false);
  assert.equal(f.calls.writes.at(-1).text, 'control off\n');
  receiveParameters(f, 'control: off requested; wait for params armed=false before save\n');
  await f.advance();
  assert.equal(f.page.data.parameters.status, null);
  assert.equal(f.calls.writes.at(-1).text, 'params\n');
  receiveParameters(f, disarmedParameters);
  await off;
  assert.equal(f.page.data.parameters.status.armed, false);
  assert.match(f.page.data.parameters.message, /已确认车端控制关闭/);
  assert.ok(!f.calls.writes.some((write) => write.text === 'save\n'));
  f.page.enableFirmwareControl();
  await f.advance();
  assert.equal(f.calls.writes.at(-1).text, 'control on\n');
  receiveParameters(f, 'control: on; waiting for normal startup conditions\n');
  await f.advance();
  receiveParameters(f, 'params: unsaved=true armed=false enabled=true\n');
  await flush();
  assert.equal(f.page.data.armed, false);
  assert.match(f.page.data.parameters.message, /正常稳定启动流程/);
});

test('cancelled support confirmation sends no firmware command', async (t) => {
  const f = fixture(t);
  await connectedMain(f);
  const before = f.calls.writes.length;
  await f.page.disableFirmwareControl();
  assert.equal(f.calls.writes.length, before);
  assert.equal(f.page.data.parameterPreparing, false);
});

test('save timeout and late BLE reply never report page success', async (t) => {
  const f = fixture(t);
  await connectedMain(f);
  f.page.saveParameters();
  await f.advance();
  await f.advance(5000);
  assert.equal(f.page.data.parameters.message, '未收到保存结果');
  assert.equal(f.page.data.parameters.busy, '');
  receiveParameters(f, 'save: ok\n');
  await flush();
  assert.equal(f.page.data.parameters.success, false);
});

for (const action of ['disconnect', 'background']) {
  test(`page ${action} cancels waiting for save and rejects its late result`, async (t) => {
    const f = fixture(t);
    await connectedMain(f);
    f.page.saveParameters();
    await f.advance();
    if (action === 'disconnect') f.page.disconnectDevice();
    if (action === 'background') f.page.onHide();
    for (let index = 0; index < 4; index++) await f.advance();
    receiveParameters(f, 'save: ok\n');
    await flush();
    assert.equal(f.page.data.parameters.success, false);
    assert.equal(f.page.data.parameters.status, null);
    assert.equal(f.calls.writes.filter((write) => write.text === 'save\n').length, 1);
  });
}

test('main save has no notification gate; missing replies time out and SIM stays isolated', async (t) => {
  const f = fixture(t, {
    notifyBLECharacteristicValueChange: (options) => options.fail({ errCode: 10007 }),
  });
  await f.connected();
  assert.equal(f.page.data.parameterAvailable, true);
  f.page.saveParameters();
  await f.advance();
  assert.deepEqual(
    f.calls.writes.map((write) => write.text),
    ['save\n'],
  );
  await f.advance(5000);
  assert.equal(f.page.data.parameters.message, '未收到保存结果');
  assert.equal(f.page.data.parameters.success, false);
  await f.demo();
  assert.equal(f.page.data.parameterAvailable, false);
  f.page.saveParameters();
  f.page.queryParameters();
  await f.page.disableFirmwareControl();
  f.page.enableFirmwareControl();
  const afterDemo = f.calls.writes.length;
  await f.advance(1000);
  assert.equal(f.calls.writes.length, afterDemo);
  assert.equal(f.page.data.parameters.success, false);
});

test('center panel defaults to instruments and persists only its mode and parameter group', async (t) => {
  const saved = [];
  const f = fixture(t, { setStorageSync: (key, value) => saved.push({ key, value }) });
  assert.equal(f.page.data.panelModeIndex, 0);
  f.page.onPanelModeChange({ detail: { value: true } });
  assert.equal(f.page.data.panelModeIndex, 1);
  f.page.onTuningGroupChange({ detail: { value: '2' } });
  f.page.onTuningInput(tuningInput('velocity-p', '0.06'));
  assert.deepEqual(saved.at(-1), { key: 'wl1-control-panel-v1', value: { mode: 1, group: 2 } });
  f.page.onPanelModeChange({ detail: { value: false } });
  assert.equal(f.page.data.panelModeIndex, 0);
  f.page.onPanelModeChange({ detail: { value: true } });
  assert.equal(f.page.findTuningParameter('velocity-p').draft, '0.06');
  assert.deepEqual(f.calls.writes, []);
});

test('stored panel preferences restore without sending reference parameters', async (t) => {
  const f = fixture(t, { getStorageSync: () => ({ mode: 1, group: 4 }) });
  assert.equal(f.page.data.panelModeIndex, 1);
  assert.equal(f.page.data.tuningGroupIndex, 4);
  assert.equal(f.page.findTuningParameter('roll-i').status, '固件参考值 · 未发送');
  await f.connected();
  assert.deepEqual(f.calls.writes, []);
});

test('tuning slider and input stay synchronized and send only on tap while demo remains isolated', async (t) => {
  const f = fixture(t);
  await f.demo();
  await f.move();
  const { speed, turn } = f.page.controller.snapshot().control;
  f.page.onTuningInput(tuningInput('velocity-i', '0.008'));
  assert.equal(f.page.findTuningParameter('velocity-i').sliderValue, 8);
  f.page.onTuningSliderChange(tuningInput('velocity-i', 9));
  assert.equal(f.page.findTuningParameter('velocity-i').draft, '0.009');
  assert.ok(!f.page.logEntries.some((log) => log.text.startsWith('velocitypid')));
  f.page.sendTuningParameter(datasetEvent({ id: 'velocity-i' }));
  await flush();
  assert.ok(
    f.page.logEntries.some((log) => log.direction === 'SIM' && log.text === 'velocitypid -i 0.009'),
  );
  assert.equal(f.page.findTuningParameter('velocity-i').status, '模拟发送 · 未写入设备');
  assert.equal(f.page.data.armed, true);
  assert.equal(f.page.controller.snapshot().control.speed, speed);
  assert.equal(f.page.controller.snapshot().control.turn, turn);
  assert.deepEqual(f.calls.writes, []);
});

test('slider endpoints, negative values and decimal steps map to precise sendable values', async (t) => {
  const f = fixture(t);
  await f.connected();
  const bias = () => f.page.findTuningParameter('angle-bias');
  assert.equal(bias().sliderMaximum, 400);
  assert.equal(bias().sliderValue, 326);
  f.page.onTuningSliderChange(tuningInput('angle-bias', 0));
  assert.equal(bias().draft, '-20.0000');
  f.page.onTuningSliderChange(tuningInput('angle-bias', 400));
  assert.equal(bias().draft, '20.0000');
  f.page.onTuningSliderChange(tuningInput('angle-bias', 146));
  assert.equal(bias().draft, '-5.4000');
  f.page.onTuningSliderChange(tuningInput('velocity-i', 9999));
  assert.equal(f.page.findTuningParameter('velocity-i').draft, '9.999');
  for (const value of [-1, 401, 3.2, NaN])
    f.page.onTuningSliderChange(tuningInput('angle-bias', value));
  assert.equal(bias().draft, '-5.4000');
  assert.deepEqual(f.calls.writes, []);
  f.page.sendTuningParameter(datasetEvent({ id: 'angle-bias' }));
  await f.advance();
  assert.deepEqual(
    f.calls.writes.map((write) => write.text),
    ['anglebias -5.4'],
  );
});

test('input preserves partial edits without resetting the slider and recovers after invalid text', async (t) => {
  const f = fixture(t);
  await f.demo();
  const bias = () => f.page.findTuningParameter('angle-bias');
  const sliderValue = bias().sliderValue;
  for (const draft of ['', '-', '.', '21', '0.00001']) {
    f.page.onTuningInput(tuningInput('angle-bias', draft));
    assert.equal(bias().draft, draft);
    assert.equal(bias().sliderValue, sliderValue);
  }
  f.page.sendTuningParameter(datasetEvent({ id: 'angle-bias' }));
  await flush();
  assert.match(f.page.data.tuningMessage, /小数/);
  f.page.onTuningInput(tuningInput('angle-bias', '-0.4'));
  assert.equal(bias().sliderValue, 196);
  assert.equal(f.page.data.tuningMessage, '');
  f.page.onTuningSliderChange(tuningInput('angle-bias', 201));
  assert.equal(bias().draft, '0.1000');
  assert.deepEqual(f.calls.writes, []);
});

test('slider cannot modify unsupported parameters or an active send, and other drafts remain editable', async (t) => {
  let pendingWrite;
  const f = fixture(t);
  await f.connected();
  f.api.writeBLECharacteristicValue = (options) => {
    pendingWrite = options;
  };
  f.page.sendTuningParameter(datasetEvent({ id: 'velocity-i' }));
  await flush();
  assert.equal(f.page.data.tuningBusy, 'velocity-i');
  f.page.onTuningSliderChange(tuningInput('velocity-i', 10));
  f.page.onTuningInput(tuningInput('velocity-i', '0.011'));
  f.page.onTuningSliderChange(tuningInput('roll-p', 1001));
  f.page.onTuningInput(tuningInput('angle-bias', '-1.2'));
  assert.equal(f.page.findTuningParameter('velocity-i').draft, '0.008');
  assert.equal(f.page.findTuningParameter('roll-p').draft, '0.0');
  assert.equal(f.page.findTuningParameter('angle-bias').sliderValue, 188);
  pendingWrite.success({ errMsg: 'ok' });
  await flush();
  assert.equal(f.page.data.tuningBusy, '');
});

test('page sends one real tuning command, reports only sent and resets drafts when disconnected', async (t) => {
  const f = fixture(t);
  await f.connected();
  f.page.onTuningInput(tuningInput('angle-bias', '13.1'));
  f.page.sendTuningParameter(datasetEvent({ id: 'angle-bias' }));
  f.page.sendTuningParameter(datasetEvent({ id: 'angle-bias' }));
  await f.advance();
  assert.deepEqual(
    f.calls.writes.map((write) => write.text),
    ['anglebias 13.1'],
  );
  assert.equal(f.page.findTuningParameter('angle-bias').status, '已发送 · 未确认执行');
  f.emit('BLEConnectionStateChange', { deviceId: 'robot', connected: false });
  assert.equal(f.page.findTuningParameter('angle-bias').draft, '12.6000');
  assert.equal(f.page.findTuningParameter('angle-bias').status, '固件参考值 · 未发送');
});

test('invalid tuning and unsupported main gains never reach BLE', async (t) => {
  const f = fixture(t);
  await f.connected();
  f.page.onTuningInput(tuningInput('angle-bias', '21'));
  f.page.sendTuningParameter(datasetEvent({ id: 'angle-bias' }));
  await flush();
  assert.match(f.page.data.tuningMessage, /范围/);
  f.page.sendTuningParameter(datasetEvent({ id: 'roll-p' }));
  f.page.sendTuningParameter(datasetEvent({ id: 'angle-p' }));
  assert.deepEqual(f.calls.writes, []);
});

test('main tuning stays fixed across demo and connection changes', async (t) => {
  const f = fixture(t);
  await f.demo();
  assert.equal(f.page.findTuningParameter('angle-bias').draft, '12.6000');
  assert.ok(f.page.findTuningParameter('angle-p').unavailable);
  f.page.onTuningInput(tuningInput('angle-bias', '13.1'));
  f.page.sendTuningParameter(datasetEvent({ id: 'angle-bias' }));
  await flush();
  assert.ok(f.page.logEntries.some((log) => log.text === 'anglebias 13.1'));
  assert.deepEqual(f.calls.writes, []);
  f.page.toggleDemo();
  await flush();
  await f.connected();
  assert.equal(f.page.findTuningParameter('angle-bias').draft, '12.6000');
  assert.ok(f.page.findTuningParameter('angle-p').unavailable);
  f.page.sendTuningParameter(datasetEvent({ id: 'angle-bias' }));
  await f.advance();
  assert.equal(f.calls.writes.at(-1).text, 'anglebias 12.6');
});

test('page demo mode exercises real controls without connecting, scanning or writing BLE', async (t) => {
  const f = fixture(t);
  await f.demo();
  f.page.startScan();
  f.page.connectDevice(datasetEvent({ id: 'robot' }));
  await f.move();
  f.page.onHeightChange({ detail: { value: 600 } });
  f.page.onRollChange({ detail: { value: 12 } });
  await f.advance(100);
  f.page.onJoystickEnd(touchEvent([touch(7)], []));
  await flush();
  f.page.stopMotion();
  await flush();
  assert.equal(f.page.data.armed, false);
  assert.ok(f.page.data.sentCount > 0);
  assert.ok(f.page.logEntries.some((log) => log.direction === 'SIM'));
  assert.deepEqual(f.calls.writes, []);
  assert.deepEqual(f.calls.connections, []);
  assert.equal(f.calls.scans, 0);
});

test('page releases the owning touch and sends neutral while preserving leg height', async (t) => {
  const f = fixture(t);
  await f.connected();
  await f.move();
  f.page.onHeightChange({ detail: { value: 600 } });
  await f.advance();
  f.page.onJoystickEnd(touchEvent([touch(7)], []));
  await f.advance();
  assert.equal(f.page.controller.snapshot().control.speed, 0);
  assert.equal(f.page.controller.snapshot().control.turn, 0);
  assert.equal(f.page.controller.snapshot().control.height, 60);
  assert.equal(f.page.touchId, null);
  assert.ok(f.calls.writes.some((write) => !isNeutral(write.text)));
  assert.equal(f.calls.writes.at(-1).text, 'R 0 0 0 60.0');
});

test('page ignores a second finger and its release while tracking the original touch', async (t) => {
  const f = fixture(t);
  await f.demo();
  await f.move(7);
  const previous = { ...f.page.controller.snapshot().control };
  f.page.onJoystickStart(touchEvent([touch(8, 50, 150)], [touch(7), touch(8, 50, 150)]));
  assert.equal(f.page.touchId, 7);
  f.page.onJoystickMove(touchEvent([touch(8, 50, 150)], [touch(8, 50, 150)]));
  assert.deepEqual(f.page.controller.snapshot().control, previous);
  f.page.onJoystickEnd(touchEvent([touch(8, 50, 150)], [touch(7)]));
  assert.equal(f.page.touchId, 7);
  assert.ok(f.page.controller.snapshot().control.speed > 0);
  f.page.onJoystickEnd(touchEvent([touch(7)], []));
  await flush();
  assert.equal(f.page.touchId, null);
  assert.equal(f.page.controller.snapshot().control.speed, 0);
});

test('page discards delayed joystick layout callbacks after touch release', async (t) => {
  const f = fixture(t);
  await f.demo();
  f.page.toggleArmed();
  await flush();
  f.page.deferSelector = true;
  f.page.onJoystickStart(touchEvent([touch(7)]));
  f.page.onJoystickEnd(touchEvent([touch(7)], []));
  f.calls.selectorCallbacks[0]();
  await f.advance(100);
  assert.equal(f.page.touchId, null);
  assert.equal(f.page.controller.snapshot().control.speed, 0);
});

test('page and app background hooks share one suspension, write neutral and disconnect', async (t) => {
  const f = fixture(t);
  await f.connected();
  await f.move();
  const before = f.calls.writes.length;
  enterBackground();
  const pending = f.page.suspension;
  f.page.onHide();
  assert.equal(f.page.suspension, pending);
  assert.equal(f.page.visible, false);
  assert.equal(f.page.data.armed, false);
  assert.equal(f.page.touchId, null);
  f.page.toggleArmed();
  assert.equal(f.page.data.armed, false);
  await f.advance();
  await pending;
  assert.equal(f.calls.writes.length, before + 1);
  assert.ok(isNeutral(f.calls.writes.at(-1).text));
  assert.deepEqual(f.calls.closes, ['robot']);
  assert.equal(f.page.data.ready, false);
  assert.equal(f.page.data.ble.status, 'idle');
  f.page.onShow();
  await f.advance(1000);
  assert.equal(f.page.data.ready, false);
  assert.equal(f.calls.writes.length, before + 1);
});

test('page unload sends neutral, disconnects and releases all BLE listeners', async (t) => {
  const f = fixture(t);
  await f.connected();
  await f.move();
  f.page.onUnload();
  await f.advance();
  assert.ok(isNeutral(f.calls.writes.at(-1).text));
  assert.ok(f.calls.closes.includes('robot'));
  assert.equal(f.page.destroyed, true);
  for (const handlers of f.handlers.values()) assert.equal(handlers.size, 0);
  const sent = f.calls.writes.length;
  await f.advance(1000);
  assert.equal(f.calls.writes.length, sent);
});

test('page reconnect keeps main motion format and requires rearming', async (t) => {
  const f = fixture(t);
  await f.connected();
  await f.move();
  f.page.disconnectDevice();
  await f.advance();
  await f.connected();
  assert.equal(f.page.data.ready, true);
  assert.equal(f.page.data.armed, false);
  assert.deepEqual(f.calls.writes, []);
  const sent = f.calls.writes.length;
  await f.advance(1000);
  assert.equal(f.calls.writes.length, sent);
  f.page.toggleArmed();
  await f.advance();
  assert.equal(f.page.data.armed, true);
  assert.ok(isNeutral(f.calls.writes.at(-1).text));
});

test('page onHide cancels pending connection and cannot be revived by its late callback', async (t) => {
  let connecting;
  const f = fixture(t, {
    createBLEConnection(options) {
      connecting = options;
    },
  });
  f.page.connectDevice(datasetEvent({ id: 'robot' }));
  await flush();
  assert.equal(f.page.data.ble.status, 'connecting');
  f.page.onHide();
  await flush();
  assert.equal(f.page.data.ready, false);
  assert.equal(f.page.data.ble.status, 'idle');
  connecting.success({});
  await flush();
  assert.equal(f.page.data.ble.status, 'idle');
  assert.equal(f.page.data.ready, false);
  assert.equal(f.page.data.armed, false);
  assert.equal(f.calls.writes.length, 0);
  assert.ok(f.calls.closes.includes('robot'));
});

test('page switches a moving real connection into isolated demo only after neutral and disconnect', async (t) => {
  const f = fixture(t);
  await f.connected();
  await f.move();
  f.page.toggleDemo();
  assert.equal(f.page.data.demo, false);
  await f.advance();
  assert.equal(f.page.data.demo, true);
  assert.equal(f.page.data.ready, true);
  assert.ok(isNeutral(f.calls.writes.at(-1).text));
  assert.ok(f.calls.closes.includes('robot'));
  const sent = f.calls.writes.length;
  await f.move();
  f.page.stopMotion();
  await f.advance(1000);
  assert.equal(f.calls.writes.length, sent);
  f.page.toggleDemo();
  await flush();
  assert.equal(f.page.data.demo, false);
  assert.equal(f.page.data.ready, false);
  assert.equal(f.page.data.armed, false);
});

test('page background during an in-flight motion sends neutral next, then disconnects', async (t) => {
  const f = fixture(t);
  await f.connected();
  f.page.toggleArmed();
  await flush();
  const originalWrite = f.api.writeBLECharacteristicValue;
  const held = [];
  f.api.writeBLECharacteristicValue = (options) => {
    f.calls.writes.push({ text: frameText(options.value), at: Date.now(), options });
    held.push(options);
  };
  f.page.onJoystickStart(touchEvent([touch(7)]));
  await f.advance(100);
  assert.equal(held.length, 1);
  assert.equal(isNeutral(frameText(held[0].value)), false);
  f.page.onHide();
  await flush();
  assert.equal(f.page.data.armed, false);
  assert.equal(f.calls.closes.length, 0);
  held[0].success({});
  await f.advance();
  assert.equal(held.length, 2);
  assert.ok(isNeutral(frameText(held[1].value)));
  held[1].success({});
  await flush();
  assert.deepEqual(f.calls.closes, ['robot']);
  assert.equal(f.page.data.ready, false);
  f.api.writeBLECharacteristicValue = originalWrite;
  const sent = f.calls.writes.length;
  await f.advance(1000);
  assert.equal(f.calls.writes.length, sent);
});

test('page background settles safely when an in-flight BLE write times out', async (t) => {
  const f = fixture(t);
  await f.connected();
  f.page.toggleArmed();
  await flush();
  const originalWrite = f.api.writeBLECharacteristicValue;
  f.api.writeBLECharacteristicValue = (options) => {
    f.calls.writes.push({ text: frameText(options.value), at: Date.now(), options });
  };
  f.page.onJoystickStart(touchEvent([touch(7)]));
  await f.advance(100);
  f.page.onHide();
  const shutdown = f.page.suspension;
  await f.advance(2000);
  await shutdown;
  assert.equal(f.page.suspension, null);
  assert.equal(f.page.data.ready, false);
  assert.equal(f.page.data.armed, false);
  assert.equal(f.page.controller.snapshot().control.speed, 0);
  assert.ok(f.calls.closes.includes('robot'));
  const sent = f.calls.writes.length;
  f.api.writeBLECharacteristicValue = originalWrite;
  await f.advance(1000);
  assert.equal(f.calls.writes.length, sent);
});

test('page supports both thumbs and each release preserves the other joystick targets', async (t) => {
  const f = fixture(t);
  await f.connected();
  await f.move(7);
  const speed = f.page.controller.snapshot().control.speed;
  f.page.onLegJoystickStart(touchEvent([legTouch(8)], [touch(7), legTouch(8)]));
  await f.advance(100);
  const posture = { ...f.page.controller.snapshot().control };
  assert.equal(f.page.touchId, 7);
  assert.equal(f.page.legTouchId, 8);
  assert.equal(posture.speed, speed);
  assert.ok(posture.roll > 0);
  assert.ok(posture.height > 44.5);

  // The left thumb lifts while the right thumb remains on its joystick.
  f.page.onJoystickEnd(touchEvent([touch(7)], [legTouch(8)]));
  await f.advance();
  assert.equal(f.page.controller.snapshot().control.speed, 0);
  assert.equal(f.page.controller.snapshot().control.turn, 0);
  assert.equal(f.page.controller.snapshot().control.roll, posture.roll);
  assert.equal(f.page.controller.snapshot().control.height, posture.height);
  assert.equal(f.page.touchId, null);
  assert.equal(f.page.legTouchId, 8);
  assert.equal(f.calls.writes.at(-1).text, `R 0 0 ${posture.roll} ${posture.height.toFixed(1)}`);

  // Reacquire the left joystick, then deliver the right joystick's touchcancel.
  f.page.onJoystickStart(touchEvent([touch(9)], [touch(9), legTouch(8)]));
  await f.advance(100);
  const moving = { ...f.page.controller.snapshot().control };
  f.page.onLegJoystickEnd(touchEvent([legTouch(8)], [touch(9)]));
  await f.advance();
  assert.equal(f.page.controller.snapshot().control.speed, moving.speed);
  assert.equal(f.page.controller.snapshot().control.turn, moving.turn);
  assert.equal(f.page.controller.snapshot().control.roll, 0);
  assert.equal(f.page.controller.snapshot().control.height, moving.height);
  assert.equal(f.page.touchId, 9);
  assert.equal(f.page.legTouchId, null);
});

test('page right joystick anchors height at touch start and maps full travel to plus or minus 17 mm', async (t) => {
  const f = fixture(t);
  await f.demo();
  f.page.toggleArmed();
  await flush();
  const center = legTouch(8, 500, 100);
  f.page.onLegJoystickStart(touchEvent([center]));
  assert.equal(f.page.controller.snapshot().control.height, 44.5);
  f.page.onLegJoystickMove(touchEvent([legTouch(8, 500, 36)]));
  assert.equal(f.page.controller.snapshot().control.height, 61.5);
  f.page.onLegJoystickEnd(touchEvent([legTouch(8, 500, 36)], []));
  assert.equal(f.page.controller.snapshot().control.height, 61.5);
  f.page.onLegJoystickStart(touchEvent([center]));
  assert.equal(
    f.page.controller.snapshot().control.height,
    61.5,
    'centering a new hold must not reset saved height',
  );
  f.page.onLegJoystickMove(touchEvent([legTouch(8, 500, 164)]));
  assert.equal(f.page.controller.snapshot().control.height, 44.5);
  f.page.onLegJoystickEnd(touchEvent([legTouch(8, 500, 164)], []));
  assert.equal(f.page.controller.snapshot().control.height, 44.5);
});

test('page routes each joystick only to its owning finger and ignores an extra right-side touch', async (t) => {
  const f = fixture(t);
  await f.demo();
  await f.move(7);
  f.page.onLegJoystickStart(touchEvent([legTouch(8)], [touch(7), legTouch(8)]));
  const original = { ...f.page.controller.snapshot().control };
  f.page.onLegJoystickStart(
    touchEvent([legTouch(9, 436, 100)], [touch(7), legTouch(8), legTouch(9, 436, 100)]),
  );
  assert.equal(f.page.legTouchId, 8);
  f.page.onLegJoystickMove(touchEvent([legTouch(9, 436, 100)], [touch(7), legTouch(9, 436, 100)]));
  assert.deepEqual(f.page.controller.snapshot().control, original);
  f.page.onLegJoystickEnd(touchEvent([legTouch(9)], [touch(7), legTouch(8)]));
  f.page.onLegJoystickEnd(touchEvent([touch(7)], [legTouch(8)]));
  f.page.onJoystickEnd(touchEvent([legTouch(8)], [touch(7)]));
  assert.equal(f.page.touchId, 7);
  assert.equal(f.page.legTouchId, 8);
  assert.deepEqual(f.page.controller.snapshot().control, original);
  f.page.onLegJoystickMove(touchEvent([legTouch(8, 436, 100)], [touch(7), legTouch(8, 436, 100)]));
  assert.ok(f.page.controller.snapshot().control.roll < 0);
  assert.equal(f.page.controller.snapshot().control.speed, original.speed);
});

for (const side of ['left', 'right']) {
  test(`page rejects an old ${side} layout result even when a later touch reuses the same identifier`, async (t) => {
    const f = fixture(t);
    await f.demo();
    f.page.toggleArmed();
    await flush();
    f.page.deferSelector = true;
    const start = side === 'left' ? 'onJoystickStart' : 'onLegJoystickStart';
    const end = side === 'left' ? 'onJoystickEnd' : 'onLegJoystickEnd';
    const oldTouch = side === 'left' ? touch(7) : legTouch(7);
    const newTouch = side === 'left' ? touch(7, 100, 100) : legTouch(7, 500, 100);
    f.page[start](touchEvent([oldTouch]));
    f.page[end](touchEvent([oldTouch], []));
    f.page[start](touchEvent([newTouch]));
    assert.equal(f.calls.selectorCallbacks.length, 2);
    f.calls.selectorCallbacks[1]();
    const expected = { ...f.page.controller.snapshot().control };
    f.calls.selectorCallbacks[0]();
    assert.deepEqual(f.page.controller.snapshot().control, expected);
  });
}

test('page keeps both joystick targets and pointers during prolonged stationary holds', async (t) => {
  const f = fixture(t);
  await f.connected();
  await f.move(7);
  for (let tick = 0; tick < 29; tick += 1) await f.advance(100);
  f.page.onLegJoystickStart(touchEvent([legTouch(8)], [touch(7), legTouch(8)]));
  const targets = { ...f.page.controller.snapshot().control };
  for (let tick = 0; tick < 650; tick += 1) await f.advance(100);
  assert.equal(f.page.touchId, 7);
  assert.equal(f.page.legTouchId, 8);
  assert.equal(f.page.controller.snapshot().motionHolding, true);
  assert.equal(f.page.controller.snapshot().poseHolding, true);
  assert.deepEqual(f.page.controller.snapshot().control, targets);
  assert.equal(f.page.data.error, '');
  assert.equal(
    f.calls.writes.at(-1).text,
    'R ' +
      targets.turn +
      ' ' +
      -targets.speed +
      ' ' +
      targets.roll +
      ' ' +
      targets.height.toFixed(1),
  );
  f.page.onJoystickMove(touchEvent([touch(7, 100, 164)]));
  f.page.onLegJoystickMove(touchEvent([legTouch(8, 436, 100)]));
  await f.advance(100);
  assert.ok(f.page.controller.snapshot().control.speed < 0);
  assert.ok(f.page.controller.snapshot().control.roll < 0);
  f.page.onJoystickEnd(touchEvent([touch(7)], [legTouch(8)]));
  await f.advance();
  assert.equal(f.page.controller.snapshot().control.speed, 0);
  assert.equal(f.page.legTouchId, 8);
  const height = f.page.controller.snapshot().control.height;
  f.page.onLegJoystickEnd(touchEvent([legTouch(8)], []));
  await f.advance();
  assert.equal(f.page.controller.snapshot().control.roll, 0);
  assert.equal(f.page.controller.snapshot().control.height, height);
  assert.equal(f.page.touchId, null);
  assert.equal(f.page.legTouchId, null);
  assert.ok(isNeutral(f.calls.writes.at(-1).text));
});

test('page defaults to full range and sends each speed mode through BLE including 150 RPM', async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.page.data.speedModes, [
    '标准 · 60 RPM',
    '全量程 · 100 RPM',
    '超级模式 · 150 RPM',
  ]);
  assert.equal(f.page.data.speedModeIndex, 1);
  await f.connected();
  await f.move(7);
  assert.equal(f.page.controller.snapshot().control.speed, 100);
  assert.equal(f.calls.writes.at(-1).text, 'R 0 -100 0 44.5');
  for (const [index, limit] of [
    [0, 60],
    [1, 100],
    [2, 150],
  ]) {
    f.page.onSpeedModeChange({ detail: { value: String(index) } });
    await f.advance();
    assert.equal(f.page.controller.snapshot().control.speed, 0);
    assert.equal(f.page.touchId, null);
    assert.ok(isNeutral(f.calls.writes.at(-1).text));
    f.page.onJoystickStart(touchEvent([touch(7)]));
    await f.advance(100);
    assert.equal(f.page.controller.snapshot().control.speed, limit);
    assert.equal(f.calls.writes.at(-1).text, 'R 0 ' + -limit + ' 0 44.5');
    f.page.onJoystickMove(touchEvent([touch(7, 100, 164)]));
    await f.advance(100);
    assert.equal(f.page.controller.snapshot().control.speed, -limit);
    assert.equal(f.calls.writes.at(-1).text, 'R 0 ' + limit + ' 0 44.5');
    f.page.onJoystickMove(touchEvent([touch(7, 164, 100)]));
    await f.advance(100);
    assert.equal(f.page.controller.snapshot().control.turn, limit);
    assert.equal(f.calls.writes.at(-1).text, 'R ' + limit + ' 0 0 44.5');
  }
});

for (const action of ['stop', 'background', 'tab', 'resize']) {
  test(`page ${action} clears both pointers and both joystick targets`, async (t) => {
    const f = fixture(t);
    await f.demo();
    await f.move(7);
    f.page.onLegJoystickStart(touchEvent([legTouch(8)], [touch(7), legTouch(8)]));
    const height = f.page.controller.snapshot().control.height;
    if (action === 'stop') f.page.stopMotion();
    if (action === 'background') f.page.onHide();
    if (action === 'tab') f.page.switchTab(datasetEvent({ tab: 'console' }));
    if (action === 'resize') f.page.onResize();
    await flush();
    assert.equal(f.page.touchId, null);
    assert.equal(f.page.legTouchId, null);
    assert.equal(f.page.controller.snapshot().motionHolding, false);
    assert.equal(f.page.controller.snapshot().poseHolding, false);
    assert.equal(f.page.controller.snapshot().control.speed, 0);
    assert.equal(f.page.controller.snapshot().control.turn, 0);
    assert.equal(f.page.controller.snapshot().control.roll, 0);
    assert.equal(f.page.controller.snapshot().control.height, height);
    f.page.onJoystickMove(touchEvent([touch(7)]));
    f.page.onLegJoystickMove(touchEvent([legTouch(8)]));
    assert.equal(f.page.controller.snapshot().control.speed, 0);
    assert.equal(f.page.controller.snapshot().control.roll, 0);
  });
}

test('page exposes raw received serial text without treating command targets as telemetry', async (t) => {
  const f = fixture(t);
  await f.connected();
  await f.move();
  const handshakeReceives = f.page.data.receiveCount;
  assert.equal(handshakeReceives, 3);
  const desired = { ...f.page.controller.snapshot().control };
  const raw = 'pitch=1.2 speed=-3.4 unknown:7\r\n';
  const event = {
    deviceId: 'robot',
    serviceId: 'UART',
    characteristicId: 'RX',
    value: Uint8Array.from(Buffer.from(raw)).buffer,
  };
  f.emit('BLECharacteristicValueChange', { ...event, deviceId: 'other-device' });
  assert.equal(f.page.data.receiveCount, handshakeReceives);
  f.emit('BLECharacteristicValueChange', event);
  await f.advance(100);
  assert.equal(f.page.data.lastReceive, raw);
  assert.equal(f.page.data.receiveCount, handshakeReceives + 1);
  assert.ok(f.page.data.lastReceiveAt);
  assert.deepEqual(f.page.controller.snapshot().control, desired);
  assert.ok(f.page.logEntries.some((log) => log.direction === 'RX' && log.text === raw));

  f.page.toggleDemo();
  await f.advance();
  assert.equal(f.page.data.demo, true);
  const received = {
    text: f.page.data.lastReceive,
    at: f.page.data.lastReceiveAt,
    count: f.page.data.receiveCount,
  };
  const existingRx = f.page.logEntries.filter((log) => log.direction === 'RX').length;
  await f.move(9);
  f.page.onLegJoystickStart(touchEvent([legTouch(10)], [touch(9), legTouch(10)]));
  await f.advance(100);
  f.emit('BLECharacteristicValueChange', event);
  assert.equal(f.page.data.lastReceive, received.text);
  assert.equal(f.page.data.lastReceiveAt, received.at);
  assert.equal(f.page.data.receiveCount, received.count);
  assert.equal(f.page.logEntries.filter((log) => log.direction === 'RX').length, existingRx);
});

test('installation page confirms state, blocks local arming and keeps lock across tabs', async (t) => {
  const f = fixture(t);
  await f.connected();
  f.page.switchTab(datasetEvent({ tab: 'installation' }));
  await f.advance(100);
  await f.advance(100);
  assert.equal(f.page.data.tab, 'installation');
  f.page.installationService.receive('install: active=0 ready=0 height=44.5 control=on\n');
  await f.advance(100);
  await f.advance(100);
  f.page.enterInstallation();
  await f.advance(100);
  await f.advance(100);
  assert.equal(f.page.data.installation.status, null);
  assert.equal(f.page.data.installationLock, true);
  f.page.installationService.receive('install: active=1 ready=1 height=44.5 control=off\n');
  await f.advance(100);
  await f.advance(100);
  f.page.switchTab(datasetEvent({ tab: 'control' }));
  await f.advance(100);
  await f.advance(100);
  f.page.toggleArmed();
  assert.equal(f.page.data.armed, false);
  assert.match(f.page.data.error, /安装/);
  assert.equal(
    f.calls.writes.some((w) => w.text === 'install off\n'),
    false,
  );
  f.page.finishInstallation();
  await f.advance(100);
  await f.advance(100);
  f.page.installationService.receive('install: active=0 ready=0 height=44.5 control=off\n');
  await f.advance(100);
  await f.advance(100);
  assert.equal(f.page.data.installationLock, false);
  assert.equal(
    f.calls.writes.some((w) => w.text === 'control on\n'),
    false,
  );
});
test('installation in simulation sends no physical BLE commands', async (t) => {
  const f = fixture(t);
  await f.demo();
  f.page.switchTab(datasetEvent({ tab: 'installation' }));
  f.page.enterInstallation();
  await flush();
  assert.equal(f.calls.writes.length, 0);
  assert.equal(f.page.data.installation.status, null);
});

test('product switch waits for neutral and disconnect before navigating, including repeated taps', async (t) => {
  const f = fixture(t);
  await f.connected();
  await f.move();
  const held = [];
  let closing;
  f.api.writeBLECharacteristicValue = (options) => held.push(options);
  f.api.closeBLEConnection = (options) => {
    f.calls.closes.push(options.deviceId);
    closing = options;
  };
  const switching = f.page.switchProduct();
  void f.page.switchProduct();
  await f.advance();
  assert.equal(f.page.data.armed, false);
  assert.equal(f.page.touchId, null);
  assert.equal(f.page.data.switchingProduct, true);
  assert.equal(held.length, 1);
  assert.ok(isNeutral(frameText(held[0].value)));
  assert.deepEqual(f.calls.closes, []);
  assert.deepEqual(f.calls.redirects, []);
  held[0].success({});
  await flush();
  assert.deepEqual(f.calls.closes, ['robot']);
  assert.deepEqual(f.calls.redirects, []);
  closing.success({});
  await switching;
  assert.equal(f.calls.redirects.length, 1);
  assert.equal(f.calls.redirects[0].url, '/pages/index/index?choose=1');
  assert.equal(f.page.data.ready, false);
  await f.page.switchProduct();
  assert.equal(f.calls.redirects.length, 1);
});

test('failed product navigation restores interaction for retry without restoring motion', async (t) => {
  let attempts = 0;
  const f = fixture(t, {
    redirectTo(options) {
      attempts += 1;
      if (attempts === 1) options.fail({ errMsg: 'redirectTo:fail' });
    },
  });
  await f.connected();
  await f.move();
  const switching = f.page.switchProduct();
  await f.advance();
  await switching;
  assert.equal(f.page.visible, true);
  assert.equal(f.page.data.switchingProduct, false);
  assert.equal(f.page.data.ready, false);
  assert.equal(f.page.data.armed, false);
  assert.equal(f.page.controller.snapshot().control.speed, 0);
  assert.match(f.page.data.error, /返回产品页失败/);
  const sent = f.calls.writes.length;
  f.page.toggleArmed();
  await f.advance(1000);
  assert.equal(f.calls.writes.length, sent);
  await f.page.switchProduct();
  assert.equal(attempts, 2);
});

for (const event of ['background', 'hide', 'unload']) {
  test(`product switch does not navigate after ${event} while stopping`, async (t) => {
    const f = fixture(t);
    await f.connected();
    await f.move();
    let neutral;
    f.api.writeBLECharacteristicValue = (options) => {
      neutral = options;
    };
    const switching = f.page.switchProduct();
    await f.advance();
    if (event === 'background') enterBackground();
    if (event === 'hide') f.page.onHide();
    if (event === 'unload') f.page.onUnload();
    neutral.success({});
    await switching;
    assert.deepEqual(f.calls.redirects, []);
    assert.equal(f.page.visible, false);
    assert.equal(f.page.data.armed, false);
    if (event !== 'unload') {
      assert.equal(f.page.data.switchingProduct, false);
      f.page.onShow();
      await f.page.switchProduct();
      assert.equal(f.calls.redirects.length, 1);
    }
  });
}

test('late product navigation failure cannot revive a backgrounded or destroyed controller', async (t) => {
  const f = fixture(t);
  await f.demo();
  await f.move();
  await f.page.switchProduct();
  const redirect = f.calls.redirects[0];
  f.page.onHide();
  redirect.fail({ errMsg: 'redirectTo:fail' });
  await flush();
  assert.equal(f.page.visible, false);
  assert.equal(f.page.data.ready, false);
  assert.equal(f.page.data.armed, false);
  f.page.onUnload();
  const afterUnload = structuredClone(f.page.data);
  redirect.fail({ errMsg: 'redirectTo:fail' });
  assert.deepEqual(f.page.data, afterUnload);
});

test('product switch still disconnects if stopping rejects unexpectedly', async (t) => {
  const f = fixture(t);
  await f.connected();
  const stop = f.page.controller.stop.bind(f.page.controller);
  f.page.controller.stop = async () => {
    throw new Error('unexpected stop error');
  };
  await f.page.switchProduct();
  assert.deepEqual(f.calls.closes, ['robot']);
  assert.equal(f.calls.redirects.length, 1);
  assert.equal(f.page.data.ready, false);
  f.page.controller.stop = stop;
});

test('product navigation can retry after a lost callback without accepting an older failure', async (t) => {
  const redirects = [];
  const f = fixture(t, { redirectTo: (options) => redirects.push(options) });
  await f.page.switchProduct();
  assert.equal(redirects.length, 1);
  assert.equal(f.page.data.switchingProduct, true);
  f.page.onHide();
  await flush();
  f.page.onShow();
  assert.equal(f.page.visible, true);
  assert.equal(f.page.data.switchingProduct, false);
  await f.page.switchProduct();
  assert.equal(redirects.length, 2);
  redirects[0].fail({ errMsg: 'redirectTo:fail stale request' });
  assert.equal(f.page.data.switchingProduct, true);
  assert.equal(f.page.visible, false);
  assert.equal(f.page.data.error, '');
  redirects[1].fail({ errMsg: 'redirectTo:fail current request' });
  assert.equal(f.page.data.switchingProduct, false);
  assert.equal(f.page.visible, true);
  assert.equal(f.page.data.armed, false);
  assert.equal(f.page.data.ready, false);
  assert.match(f.page.data.error, /返回产品页失败/);
});

test('returning from background while stopping navigates only the new product switch', async (t) => {
  const f = fixture(t);
  await f.connected();
  await f.move();
  let neutral;
  f.api.writeBLECharacteristicValue = (options) => {
    neutral = options;
  };
  const oldSwitch = f.page.switchProduct();
  await f.advance();
  enterBackground();
  f.page.onShow();
  assert.equal(f.page.data.switchingProduct, false);
  const newSwitch = f.page.switchProduct();
  assert.equal(f.page.data.switchingProduct, true);
  neutral.success({});
  await Promise.all([oldSwitch, newSwitch]);
  assert.equal(f.calls.redirects.length, 1);
  assert.equal(f.page.data.switchingProduct, true);
  assert.equal(f.page.data.armed, false);
  assert.equal(f.page.data.ready, false);
  assert.deepEqual(f.calls.closes, ['robot']);
});
