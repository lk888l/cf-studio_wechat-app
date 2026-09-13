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
    showModal: (options) => options.success({ confirm: false, cancel: true }),
    getStorageSync: () => '',
    setStorageSync: () => undefined,
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
      for (const [key, value] of Object.entries(structuredClone(update))) {
        const segments = key.replace(/\[(\d+)\]/g, '.$1').split('.');
        let target = this.data;
        for (const segment of segments.slice(0, -1)) target = target[segment];
        target[segments.at(-1)] = value;
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

const tuningInput = (id, value) => ({ currentTarget: { dataset: { id } }, detail: { value } });

function receiveParameters(f, text) {
  f.emit('BLECharacteristicValueChange', {
    deviceId: 'robot',
    serviceId: 'UART',
    characteristicId: 'RX',
    value: Uint8Array.from(Buffer.from(text)).buffer,
  });
}
const disarmedParameters = 'params: flash_valid=true unsaved=true armed=false enabled=false\n';
async function connectedSoftEngine(f) {
  await f.connected();
  f.page.onProfileChange({ detail: { value: 1 } });
  await f.advance();
  assert.equal(f.page.data.parameterAvailable, true);
}
test('page save immediately writes save without opening a panel, querying or confirming', async (t) => {
  const f = fixture(t);
  await connectedSoftEngine(f);
  f.api.showModal = () => assert.fail('save must not show a confirmation');
  const before = f.calls.writes.length;
  // Dispatch the real primary button binding, so a modal-only entry cannot regress.
  const template = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../miniprogram/pages/index/index.wxml'),
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
    await connectedSoftEngine(f);
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
        '@velocitypid -i 0.009\n',
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
    await connectedSoftEngine(f);
    await f.move();
    f.page.onLegJoystickStart(touchEvent([legTouch(8)]));
    const target = { ...f.page.data.control };
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
    assert.deepEqual(f.page.data.control, target);
    const afterSave = f.calls.writes.length;
    for (let index = 0; index < 5; index++) await f.advance(100);
    assert.ok(
      f.calls.writes.length >= afterSave + 5,
      'motion keeps refreshing while save is pending',
    );
    assert.ok(f.calls.writes.slice(afterSave).every((write) => write.text.startsWith('@R ')));
    assert.equal(f.page.data.parameters.busy, 'save');
    f.page.onJoystickMove(touchEvent([touch(7, 100, 164)]));
    f.page.onLegJoystickMove(touchEvent([legTouch(8, 436, 100)]));
    await f.advance(100);
    const updatedTarget = { ...f.page.data.control };
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
    assert.deepEqual(f.page.data.control, updatedTarget);
    assert.deepEqual(
      f.calls.writes
        .slice(before)
        .filter((write) => !write.text.startsWith('@R '))
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
  await connectedSoftEngine(f);
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
  await connectedSoftEngine(f);
  const before = f.calls.writes.length;
  await f.page.disableFirmwareControl();
  assert.equal(f.calls.writes.length, before);
  assert.equal(f.page.data.parameterPreparing, false);
});

test('save timeout and late BLE reply never report page success', async (t) => {
  const f = fixture(t);
  await connectedSoftEngine(f);
  f.page.saveParameters();
  await f.advance();
  await f.advance(5000);
  assert.equal(f.page.data.parameters.message, '未收到保存结果');
  assert.equal(f.page.data.parameters.busy, '');
  receiveParameters(f, 'save: ok\n');
  await flush();
  assert.equal(f.page.data.parameters.success, false);
});

for (const action of ['disconnect', 'background', 'profile']) {
  test(`page ${action} cancels waiting for save and rejects its late result`, async (t) => {
    const f = fixture(t);
    await connectedSoftEngine(f);
    f.page.saveParameters();
    await f.advance();
    if (action === 'disconnect') f.page.disconnectDevice();
    if (action === 'background') f.page.onHide();
    if (action === 'profile') f.page.onProfileChange({ detail: { value: 0 } });
    for (let index = 0; index < 4; index++) await f.advance();
    receiveParameters(f, 'save: ok\n');
    await flush();
    assert.equal(f.page.data.parameters.success, false);
    assert.equal(f.page.data.parameters.status, null);
    assert.equal(f.calls.writes.filter((write) => write.text === 'save\n').length, 1);
  });
}

test('save has no profile or notification gate; missing replies time out and SIM stays isolated', async (t) => {
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
  f.page.onProfileChange({ detail: { value: 1 } });
  await f.advance();
  assert.equal(f.page.data.parameterAvailable, true);
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
  const { speed, turn } = f.page.data.control;
  f.page.onTuningInput(tuningInput('velocity-i', '0.008'));
  assert.equal(f.page.findTuningParameter('velocity-i').sliderValue, 8);
  f.page.onTuningSliderChange(tuningInput('velocity-i', 9));
  assert.equal(f.page.findTuningParameter('velocity-i').draft, '0.009');
  assert.ok(!f.page.data.logs.some((log) => log.text.startsWith('velocitypid')));
  f.page.sendTuningParameter(datasetEvent({ id: 'velocity-i' }));
  await flush();
  assert.ok(
    f.page.data.logs.some((log) => log.direction === 'SIM' && log.text === 'velocitypid -i 0.009'),
  );
  assert.equal(f.page.findTuningParameter('velocity-i').status, '模拟发送 · 未写入设备');
  assert.equal(f.page.data.armed, true);
  assert.equal(f.page.data.control.speed, speed);
  assert.equal(f.page.data.control.turn, turn);
  assert.deepEqual(f.calls.writes, []);
});

test('slider endpoints, negative values and decimal steps map to precise sendable values', async (t) => {
  const f = fixture(t);
  await f.connected();
  const bias = () => f.page.findTuningParameter('angle-bias');
  assert.equal(bias().sliderMaximum, 400);
  assert.equal(bias().sliderValue, 326);
  f.page.onTuningSliderChange(tuningInput('angle-bias', 0));
  assert.equal(bias().draft, '-20.0');
  f.page.onTuningSliderChange(tuningInput('angle-bias', 400));
  assert.equal(bias().draft, '20.0');
  f.page.onTuningSliderChange(tuningInput('angle-bias', 146));
  assert.equal(bias().draft, '-5.4');
  f.page.onTuningSliderChange(tuningInput('velocity-i', 9999));
  assert.equal(f.page.findTuningParameter('velocity-i').draft, '9.999');
  for (const value of [-1, 401, 3.2, NaN])
    f.page.onTuningSliderChange(tuningInput('angle-bias', value));
  assert.equal(bias().draft, '-5.4');
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
  for (const draft of ['', '-', '.', '21', '0.001']) {
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
  assert.equal(bias().draft, '0.1');
  assert.deepEqual(f.calls.writes, []);
});

test('slider cannot modify unsupported parameters or an active send, and other drafts remain editable', async (t) => {
  let pendingWrite;
  const f = fixture(t, {
    writeBLECharacteristicValue: (options) => {
      pendingWrite = options;
    },
  });
  await f.connected();
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
  assert.equal(f.page.findTuningParameter('angle-bias').draft, '12.6');
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

test('SoftEngine profile exposes manual and auto Kp with framed commands and its own reference bias', async (t) => {
  const f = fixture(t);
  await f.demo();
  f.page.onTuningInput(tuningInput('angle-bias', '13.1'));
  f.page.onProfileChange({ detail: { value: 1 } });
  await flush();
  assert.equal(f.page.findTuningParameter('angle-bias').draft, '7.0');
  assert.equal(f.page.findTuningParameter('angle-p').unavailable, '');
  f.page.sendTuningParameter(datasetEvent({ id: 'angle-p' }));
  await flush();
  f.page.restoreAutoAngleKp();
  await flush();
  assert.ok(f.page.data.logs.some((log) => log.text === '@anglepid -p 70\n'));
  assert.ok(f.page.data.logs.some((log) => log.text === '@anglepid -auto\n'));
  assert.deepEqual(f.calls.writes, []);
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
