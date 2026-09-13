const test = require('node:test');
const assert = require('node:assert/strict');
const pagePath = require.resolve('../.test-build/miniprogram/pages/index/index.js');
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
  const calls = { writes: [], connections: [], closes: [], selectorCallbacks: [], scans: 0 };
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
      calls.writes.push({ text: frameText(options.value), at: Date.now(), options });
      success(options);
    },
    setClipboardData: success,
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
    setData(update) {
      Object.assign(this.data, structuredClone(update));
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
    },
    async move(identifier = 7) {
      page.toggleArmed();
      await flush();
      assert.equal(page.data.armed, true);
      page.onJoystickStart(touchEvent([touch(identifier)]));
      await f.advance(100);
      assert.ok(page.data.control.speed > 0);
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
  assert.ok(f.page.data.logs.some((log) => log.direction === 'SIM'));
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
  assert.equal(f.page.data.control.speed, 0);
  assert.equal(f.page.data.control.turn, 0);
  assert.equal(f.page.data.control.height, 60);
  assert.equal(f.page.data.knobX, 0);
  assert.equal(f.page.data.knobY, 0);
  assert.equal(f.page.touchId, null);
  assert.ok(f.calls.writes.some((write) => !isNeutral(write.text)));
  assert.equal(f.calls.writes.at(-1).text, 'R 0 0 0 60.0');
});

test('page ignores a second finger and its release while tracking the original touch', async (t) => {
  const f = fixture(t);
  await f.demo();
  await f.move(7);
  const previous = { ...f.page.data.control };
  f.page.onJoystickStart(touchEvent([touch(8, 50, 150)], [touch(7), touch(8, 50, 150)]));
  assert.equal(f.page.touchId, 7);
  f.page.onJoystickMove(touchEvent([touch(8, 50, 150)], [touch(8, 50, 150)]));
  assert.deepEqual(f.page.data.control, previous);
  f.page.onJoystickEnd(touchEvent([touch(8, 50, 150)], [touch(7)]));
  assert.equal(f.page.touchId, 7);
  assert.ok(f.page.data.control.speed > 0);
  f.page.onJoystickEnd(touchEvent([touch(7)], []));
  await flush();
  assert.equal(f.page.touchId, null);
  assert.equal(f.page.data.control.speed, 0);
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
  assert.equal(f.page.data.control.speed, 0);
  assert.equal(f.page.data.knobY, 0);
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

test('page profile switch sends old neutral and uses the new format only after rearming', async (t) => {
  const f = fixture(t);
  await f.connected();
  await f.move();
  f.page.onProfileChange({ detail: { value: 1 } });
  await f.advance();
  assert.equal(f.page.data.profileIndex, 1);
  assert.equal(f.page.data.ready, true);
  assert.equal(f.page.data.armed, false);
  assert.ok(isNeutral(f.calls.writes.at(-1).text));
  const sent = f.calls.writes.length;
  await f.advance(1000);
  assert.equal(f.calls.writes.length, sent);
  f.page.toggleArmed();
  await f.advance();
  assert.equal(f.page.data.armed, true);
  assert.match(f.calls.writes.at(-1).text, /^@R 0 0 0 [0-9.]+\n$/);
  f.page.onProfileChange({ detail: { value: 0 } });
  await f.advance();
  assert.equal(f.page.data.armed, false);
  assert.equal(f.page.data.profileIndex, 0);
  f.page.toggleArmed();
  await f.advance();
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
  assert.equal(f.page.data.control.speed, 0);
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
  const speed = f.page.data.control.speed;
  f.page.onLegJoystickStart(touchEvent([legTouch(8)], [touch(7), legTouch(8)]));
  await f.advance(100);
  const posture = { ...f.page.data.control };
  assert.equal(f.page.touchId, 7);
  assert.equal(f.page.legTouchId, 8);
  assert.equal(posture.speed, speed);
  assert.ok(posture.roll > 0);
  assert.ok(posture.height > 44.5);
  assert.ok(f.page.data.legKnobX > 0);

  // The left thumb lifts while the right thumb remains on its joystick.
  f.page.onJoystickEnd(touchEvent([touch(7)], [legTouch(8)]));
  await f.advance();
  assert.equal(f.page.data.control.speed, 0);
  assert.equal(f.page.data.control.turn, 0);
  assert.equal(f.page.data.control.roll, posture.roll);
  assert.equal(f.page.data.control.height, posture.height);
  assert.equal(f.page.touchId, null);
  assert.equal(f.page.legTouchId, 8);
  assert.equal(f.page.data.knobY, 0);
  assert.ok(f.page.data.legKnobX > 0);
  assert.equal(f.calls.writes.at(-1).text, `R 0 0 ${posture.roll} ${posture.height.toFixed(1)}`);

  // Reacquire the left joystick, then deliver the right joystick's touchcancel.
  f.page.onJoystickStart(touchEvent([touch(9)], [touch(9), legTouch(8)]));
  await f.advance(100);
  const moving = { ...f.page.data.control };
  f.page.onLegJoystickEnd(touchEvent([legTouch(8)], [touch(9)]));
  await f.advance();
  assert.equal(f.page.data.control.speed, moving.speed);
  assert.equal(f.page.data.control.turn, moving.turn);
  assert.equal(f.page.data.control.roll, 0);
  assert.equal(f.page.data.control.height, moving.height);
  assert.equal(f.page.touchId, 9);
  assert.equal(f.page.legTouchId, null);
  assert.equal(f.page.data.legKnobX, 0);
  assert.equal(f.page.data.legKnobY, 0);
  assert.ok(f.page.data.knobY < 0);
});

test('page right joystick anchors height at touch start and maps full travel to plus or minus 17 mm', async (t) => {
  const f = fixture(t);
  await f.demo();
  f.page.toggleArmed();
  await flush();
  const center = legTouch(8, 500, 100);
  f.page.onLegJoystickStart(touchEvent([center]));
  assert.equal(f.page.data.control.height, 44.5);
  f.page.onLegJoystickMove(touchEvent([legTouch(8, 500, 36)]));
  assert.equal(f.page.data.control.height, 61.5);
  f.page.onLegJoystickEnd(touchEvent([legTouch(8, 500, 36)], []));
  assert.equal(f.page.data.control.height, 61.5);
  f.page.onLegJoystickStart(touchEvent([center]));
  assert.equal(
    f.page.data.control.height,
    61.5,
    'centering a new hold must not reset saved height',
  );
  f.page.onLegJoystickMove(touchEvent([legTouch(8, 500, 164)]));
  assert.equal(f.page.data.control.height, 44.5);
  f.page.onLegJoystickEnd(touchEvent([legTouch(8, 500, 164)], []));
  assert.equal(f.page.data.control.height, 44.5);
});

test('page routes each joystick only to its owning finger and ignores an extra right-side touch', async (t) => {
  const f = fixture(t);
  await f.demo();
  await f.move(7);
  f.page.onLegJoystickStart(touchEvent([legTouch(8)], [touch(7), legTouch(8)]));
  const original = { ...f.page.data.control };
  f.page.onLegJoystickStart(
    touchEvent([legTouch(9, 436, 100)], [touch(7), legTouch(8), legTouch(9, 436, 100)]),
  );
  assert.equal(f.page.legTouchId, 8);
  f.page.onLegJoystickMove(touchEvent([legTouch(9, 436, 100)], [touch(7), legTouch(9, 436, 100)]));
  assert.deepEqual(f.page.data.control, original);
  f.page.onLegJoystickEnd(touchEvent([legTouch(9)], [touch(7), legTouch(8)]));
  f.page.onLegJoystickEnd(touchEvent([touch(7)], [legTouch(8)]));
  f.page.onJoystickEnd(touchEvent([legTouch(8)], [touch(7)]));
  assert.equal(f.page.touchId, 7);
  assert.equal(f.page.legTouchId, 8);
  assert.deepEqual(f.page.data.control, original);
  f.page.onLegJoystickMove(touchEvent([legTouch(8, 436, 100)], [touch(7), legTouch(8, 436, 100)]));
  assert.ok(f.page.data.control.roll < 0);
  assert.equal(f.page.data.control.speed, original.speed);
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
    const expected = { ...f.page.data.control };
    f.calls.selectorCallbacks[0]();
    assert.deepEqual(f.page.data.control, expected);
    assert.equal(f.page.data[side === 'left' ? 'knobY' : 'legKnobY'], 0);
  });
}

test('page keeps both joystick targets and pointers during prolonged stationary holds', async (t) => {
  const f = fixture(t);
  await f.connected();
  await f.move(7);
  for (let tick = 0; tick < 29; tick += 1) await f.advance(100);
  f.page.onLegJoystickStart(touchEvent([legTouch(8)], [touch(7), legTouch(8)]));
  const targets = { ...f.page.data.control };
  const knobs = [f.page.data.knobX, f.page.data.knobY, f.page.data.legKnobX, f.page.data.legKnobY];
  for (let tick = 0; tick < 650; tick += 1) await f.advance(100);
  assert.equal(f.page.touchId, 7);
  assert.equal(f.page.legTouchId, 8);
  assert.equal(f.page.data.motionHolding, true);
  assert.equal(f.page.data.poseHolding, true);
  assert.deepEqual(f.page.data.control, targets);
  assert.deepEqual(
    [f.page.data.knobX, f.page.data.knobY, f.page.data.legKnobX, f.page.data.legKnobY],
    knobs,
  );
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
  assert.ok(f.page.data.control.speed < 0);
  assert.ok(f.page.data.control.roll < 0);
  f.page.onJoystickEnd(touchEvent([touch(7)], [legTouch(8)]));
  await f.advance();
  assert.equal(f.page.data.control.speed, 0);
  assert.equal(f.page.legTouchId, 8);
  const height = f.page.data.control.height;
  f.page.onLegJoystickEnd(touchEvent([legTouch(8)], []));
  await f.advance();
  assert.equal(f.page.data.control.roll, 0);
  assert.equal(f.page.data.control.height, height);
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
  assert.equal(f.page.data.control.speed, 100);
  assert.equal(f.calls.writes.at(-1).text, 'R 0 -100 0 44.5');
  for (const [index, limit] of [
    [0, 60],
    [1, 100],
    [2, 150],
  ]) {
    f.page.onSpeedModeChange({ detail: { value: String(index) } });
    await f.advance();
    assert.equal(f.page.data.control.speed, 0);
    assert.equal(f.page.touchId, null);
    assert.ok(isNeutral(f.calls.writes.at(-1).text));
    f.page.onJoystickStart(touchEvent([touch(7)]));
    await f.advance(100);
    assert.equal(f.page.data.control.speed, limit);
    assert.equal(f.calls.writes.at(-1).text, 'R 0 ' + -limit + ' 0 44.5');
    f.page.onJoystickMove(touchEvent([touch(7, 100, 164)]));
    await f.advance(100);
    assert.equal(f.page.data.control.speed, -limit);
    assert.equal(f.calls.writes.at(-1).text, 'R 0 ' + limit + ' 0 44.5');
    f.page.onJoystickMove(touchEvent([touch(7, 164, 100)]));
    await f.advance(100);
    assert.equal(f.page.data.control.turn, limit);
    assert.equal(f.calls.writes.at(-1).text, 'R ' + limit + ' 0 0 44.5');
  }
});

for (const action of ['stop', 'background', 'tab', 'resize']) {
  test(`page ${action} clears both pointers and both joystick targets`, async (t) => {
    const f = fixture(t);
    await f.demo();
    await f.move(7);
    f.page.onLegJoystickStart(touchEvent([legTouch(8)], [touch(7), legTouch(8)]));
    const height = f.page.data.control.height;
    if (action === 'stop') f.page.stopMotion();
    if (action === 'background') f.page.onHide();
    if (action === 'tab') f.page.switchTab(datasetEvent({ tab: 'console' }));
    if (action === 'resize') f.page.onResize();
    await flush();
    assert.equal(f.page.touchId, null);
    assert.equal(f.page.legTouchId, null);
    assert.equal(f.page.data.motionHolding, false);
    assert.equal(f.page.data.poseHolding, false);
    assert.equal(f.page.data.knobX, 0);
    assert.equal(f.page.data.knobY, 0);
    assert.equal(f.page.data.legKnobX, 0);
    assert.equal(f.page.data.legKnobY, 0);
    assert.equal(f.page.data.control.speed, 0);
    assert.equal(f.page.data.control.turn, 0);
    assert.equal(f.page.data.control.roll, 0);
    assert.equal(f.page.data.control.height, height);
    f.page.onJoystickMove(touchEvent([touch(7)]));
    f.page.onLegJoystickMove(touchEvent([legTouch(8)]));
    assert.equal(f.page.data.control.speed, 0);
    assert.equal(f.page.data.control.roll, 0);
  });
}

test('page exposes raw received serial text without treating command targets as telemetry', async (t) => {
  const f = fixture(t);
  await f.connected();
  await f.move();
  assert.equal(f.page.data.lastReceive, '');
  assert.equal(f.page.data.receiveCount, 0);
  const desired = { ...f.page.data.control };
  const raw = 'pitch=1.2 speed=-3.4 unknown:7\r\n';
  const event = {
    deviceId: 'robot',
    serviceId: 'UART',
    characteristicId: 'RX',
    value: Uint8Array.from(Buffer.from(raw)).buffer,
  };
  f.emit('BLECharacteristicValueChange', { ...event, deviceId: 'other-device' });
  assert.equal(f.page.data.receiveCount, 0);
  f.emit('BLECharacteristicValueChange', event);
  assert.equal(f.page.data.lastReceive, raw);
  assert.equal(f.page.data.receiveCount, 1);
  assert.ok(f.page.data.lastReceiveAt);
  assert.deepEqual(f.page.data.control, desired);
  assert.ok(f.page.data.logs.some((log) => log.direction === 'RX' && log.text === raw));

  f.page.toggleDemo();
  await f.advance();
  assert.equal(f.page.data.demo, true);
  const received = {
    text: f.page.data.lastReceive,
    at: f.page.data.lastReceiveAt,
    count: f.page.data.receiveCount,
  };
  const existingRx = f.page.data.logs.filter((log) => log.direction === 'RX').length;
  await f.move(9);
  f.page.onLegJoystickStart(touchEvent([legTouch(10)], [touch(9), legTouch(10)]));
  await f.advance(100);
  f.emit('BLECharacteristicValueChange', event);
  assert.equal(f.page.data.lastReceive, received.text);
  assert.equal(f.page.data.lastReceiveAt, received.at);
  assert.equal(f.page.data.receiveCount, received.count);
  assert.equal(f.page.data.logs.filter((log) => log.direction === 'RX').length, existingRx);
});
