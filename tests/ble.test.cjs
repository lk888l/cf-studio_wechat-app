const test = require('node:test');
const assert = require('node:assert/strict');
const { BleTransport } = require('../.test-build/miniprogram/transport/ble.js');

const flush = async () => {
  for (let index = 0; index < 40; index++) await Promise.resolve();
};
const characteristic = (uuid, properties) => ({
  uuid,
  properties: { read: false, write: false, notify: false, indicate: false, ...properties },
});

function fixture(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const handlers = new Map();
  const calls = { writes: [], closes: [], stops: 0, adapterCloses: 0, notify: [] };
  const success = (options) => options.success({ errMsg: 'ok' });
  const api = {
    openBluetoothAdapter: success,
    closeBluetoothAdapter(options) {
      calls.adapterCloses++;
      success(options);
    },
    startBluetoothDevicesDiscovery: success,
    stopBluetoothDevicesDiscovery(options) {
      calls.stops++;
      success(options);
    },
    getBluetoothDevices(options) {
      options.success({ devices: [] });
    },
    createBLEConnection: success,
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
          characteristic('WRITE', { write: true }),
          characteristic('RX', { notify: true }),
        ],
      });
    },
    notifyBLECharacteristicValueChange(options) {
      calls.notify.push(options);
      success(options);
    },
    writeBLECharacteristicValue(options) {
      calls.writes.push({ ...options, at: Date.now() });
      success(options);
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
  const transport = new BleTransport();
  let state;
  transport.subscribe((value) => {
    state = value;
  });
  t.after(async () => {
    await transport.dispose();
    delete global.wx;
  });
  return {
    transport,
    api,
    calls,
    handlers,
    state: () => state,
    emit(name, value) {
      for (const handler of handlers.get(name)) handler(value);
    },
    async ready() {
      await transport.connect('robot');
      await transport.selectEndpoint(state.endpoints[0]);
    },
  };
}

test('BLE discovery deduplicates devices, updates RSSI and stops after 15 seconds', async (t) => {
  const f = fixture(t);
  await f.transport.scan();
  f.emit('BluetoothDeviceFound', {
    devices: [
      { deviceId: 'a', localName: 'WL1', RSSI: -80 },
      { deviceId: 'b', name: 'UART', RSSI: -70 },
      { deviceId: 'a', localName: 'WL1', RSSI: -40 },
    ],
  });
  assert.deepEqual(
    f.state().devices.map((device) => [device.deviceId, device.rssi]),
    [
      ['a', -40],
      ['b', -70],
    ],
  );
  t.mock.timers.tick(15000);
  await flush();
  assert.equal(f.state().status, 'idle');
  assert.equal(f.calls.stops, 1);
  f.emit('BluetoothDeviceFound', { devices: [{ deviceId: 'late', name: 'late', RSSI: -10 }] });
  assert.equal(f.state().devices.length, 2);
});

test('BLE enumerates every service and waits for explicit endpoint confirmation', async (t) => {
  const inspected = [];
  const f = fixture(t, {
    getBLEDeviceServices(options) {
      options.success({ services: [{ uuid: 'SYSTEM' }, { uuid: 'UART' }] });
    },
    getBLEDeviceCharacteristics(options) {
      inspected.push(options.serviceId);
      options.success({
        characteristics:
          options.serviceId === 'SYSTEM'
            ? [characteristic('SYSTEM-WRITE', { write: true })]
            : [
                characteristic('UART-WRITE', { writeNoResponse: true }),
                characteristic('RX', { notify: true }),
              ],
      });
    },
  });
  await f.transport.connect('robot');
  assert.deepEqual(inspected, ['SYSTEM', 'UART']);
  assert.equal(f.state().status, 'selecting');
  assert.equal(f.state().endpoint, null);
  assert.equal(f.state().endpoints.length, 2);
  await assert.rejects(f.transport.send('S:0;'), /尚未就绪/);
  await assert.rejects(
    f.transport.selectEndpoint({ ...f.state().endpoints[0], writeId: 'INVENTED' }),
    /当前设备/,
  );
  await f.transport.selectEndpoint(f.state().endpoints[1]);
  assert.equal(f.state().status, 'ready');
  assert.equal(f.state().endpoint.writeType, 'writeNoResponse');
  await f.transport.send('S:0;');
  assert.equal(f.calls.writes[0].characteristicId, 'UART-WRITE');
  assert.equal(f.calls.writes[0].writeType, 'writeNoResponse');
});

test('BLE does not assume classic HC-05 SPP is a writable BLE peripheral', async (t) => {
  const f = fixture(t, {
    getBLEDeviceCharacteristics(options) {
      options.success({ characteristics: [characteristic('READ', { read: true })] });
    },
  });
  await assert.rejects(f.transport.connect('HC-05'), /HC-05.*SPP/);
  assert.equal(f.state().status, 'error');
  assert.equal(f.state().endpoint, null);
});

test('BLE notify failure still allows sending and explicitly warns execution is unknown', async (t) => {
  const f = fixture(t, {
    notifyBLECharacteristicValueChange(options) {
      options.fail({ errCode: 10007 });
    },
  });
  await f.ready();
  assert.equal(f.state().status, 'ready');
  assert.match(f.state().error, /无法确认设备是否执行/);
  await f.transport.send('S:0;');
  assert.equal(f.calls.writes.length, 1);
});

test('BLE preserves each ASCII frame in one write and enforces an idle interval', async (t) => {
  const f = fixture(t);
  await f.ready();
  await assert.rejects(f.transport.send('中'), /ASCII/);
  await assert.rejects(f.transport.send('a'.repeat(21)), /ASCII/);
  await assert.rejects(f.transport.send(''), /ASCII/);
  await f.transport.send('A'.repeat(20));
  const second = f.transport.send('S:0;');
  await flush();
  assert.equal(f.calls.writes.length, 1);
  t.mock.timers.tick(24);
  await flush();
  assert.equal(f.calls.writes.length, 1);
  t.mock.timers.tick(1);
  await second;
  assert.deepEqual(
    f.calls.writes.map((call) => Buffer.from(call.value).toString('ascii')),
    ['A'.repeat(20), 'S:0;'],
  );
  assert.equal(f.calls.writes[1].at - f.calls.writes[0].at, 25);
});

test('BLE drops stale queued commands without replaying them after congestion', async (t) => {
  let heldWrite;
  const f = fixture(t, {
    writeBLECharacteristicValue(options) {
      heldWrite = options;
    },
  });
  await f.ready();
  const first = f.transport.send('S:100;');
  const stale = assert.rejects(f.transport.send('S:90;'), /等待过久/);
  await flush();
  assert.ok(heldWrite);
  t.mock.timers.tick(400);
  heldWrite.success({});
  await first;
  await flush();
  t.mock.timers.tick(25);
  await stale;
  assert.equal(Buffer.from(heldWrite.value).toString('ascii'), 'S:100;');
  assert.equal(f.state().status, 'ready');
});

test('SoftEngine chunks remain ordered and cannot interleave with the next command', async (t) => {
  const f = fixture(t);
  await f.ready();
  const frame = '@R -100 -100 -18 78.5\n';
  const first = f.transport.send(frame);
  const second = f.transport.send('@R 0 0 0 44.5\n');
  await flush();
  assert.equal(f.calls.writes.length, 1);
  assert.equal(Buffer.from(f.calls.writes[0].value).toString('ascii'), frame.slice(0, 20));
  t.mock.timers.tick(25);
  await first;
  await flush();
  assert.equal(f.calls.writes.length, 2);
  assert.equal(Buffer.from(f.calls.writes[1].value).toString('ascii'), frame.slice(20));
  t.mock.timers.tick(25);
  await second;
  assert.equal(Buffer.from(f.calls.writes[2].value).toString('ascii'), '@R 0 0 0 44.5\n');
  await assert.rejects(f.transport.send('@R 0 0 0 44.5'), /ASCII/);
  await assert.rejects(f.transport.send('@ping\n@ping\n'), /ASCII/);
  await assert.rejects(f.transport.send('@' + 'x'.repeat(33) + '\n'), /ASCII/);
});

test('disconnect between SoftEngine chunks cancels the incomplete command', async (t) => {
  const f = fixture(t);
  await f.ready();
  const sending = assert.rejects(f.transport.send('@R -100 -100 -18 78.5\n'), /会话已结束/);
  await flush();
  assert.equal(f.calls.writes.length, 1);
  await f.transport.disconnect();
  t.mock.timers.tick(100);
  await sending;
  assert.equal(f.calls.writes.length, 1);
});

test('a delayed first chunk cannot release a stale SoftEngine terminator', async (t) => {
  let heldWrite;
  const f = fixture(t, {
    writeBLECharacteristicValue(options) {
      heldWrite = options;
    },
  });
  await f.ready();
  const sending = assert.rejects(f.transport.send('@R -100 -100 -18 78.5\n'), /等待过久/);
  await flush();
  assert.ok(heldWrite);
  t.mock.timers.tick(400);
  heldWrite.success({});
  await flush();
  t.mock.timers.tick(25);
  await sending;
  assert.equal(f.state().status, 'error');
  assert.equal(Buffer.from(heldWrite.value).toString('ascii').length, 20);
});

test('BLE write timeout invalidates the session and cancels queued commands', async (t) => {
  const writes = [];
  const f = fixture(t, {
    writeBLECharacteristicValue(options) {
      writes.push(options);
    },
  });
  await f.ready();
  const first = assert.rejects(f.transport.send('S:100;'), /超时/);
  const queued = assert.rejects(f.transport.send('S:80;'), /会话已结束/);
  await flush();
  t.mock.timers.tick(2000);
  await Promise.all([first, queued]);
  assert.equal(f.state().status, 'error');
  assert.equal(writes.length, 1);
  writes[0].success({});
  await flush();
  assert.equal(f.state().status, 'error');
  assert.ok(f.calls.closes.includes('robot'));
});

test('BLE cancellation ignores and closes a connection that completes late', async (t) => {
  let pendingConnect;
  const f = fixture(t, {
    createBLEConnection(options) {
      pendingConnect = options;
    },
  });
  const connecting = assert.rejects(f.transport.connect('robot'), /会话已结束/);
  await flush();
  assert.ok(pendingConnect);
  await f.transport.disconnect();
  await connecting;
  pendingConnect.success({});
  await flush();
  assert.equal(f.state().status, 'idle');
  assert.equal(f.state().endpoints.length, 0);
  assert.equal(f.calls.closes.filter((id) => id === 'robot').length, 2);
});

test('BLE connection timeout rejects without waiting indefinitely for native callbacks', async (t) => {
  let pendingConnect;
  const f = fixture(t, {
    createBLEConnection(options) {
      pendingConnect = options;
    },
  });
  const connecting = assert.rejects(f.transport.connect('robot'), /超时/);
  await flush();
  t.mock.timers.tick(10000);
  await connecting;
  assert.equal(f.state().status, 'error');
  pendingConnect.success({});
  await flush();
  assert.equal(f.state().status, 'error');
});

test('BLE receives only selected endpoint data and removes only its own event listeners', async (t) => {
  const f = fixture(t);
  const received = [];
  const stopReceiving = f.transport.onReceive((text) => received.push(text));
  await f.ready();
  const value = Uint8Array.from(Buffer.from('OK\r\n')).buffer;
  f.emit('BLECharacteristicValueChange', {
    deviceId: 'other',
    serviceId: 'UART',
    characteristicId: 'RX',
    value,
  });
  f.emit('BLECharacteristicValueChange', {
    deviceId: 'robot',
    serviceId: 'OTHER',
    characteristicId: 'RX',
    value,
  });
  f.emit('BLECharacteristicValueChange', {
    deviceId: 'robot',
    serviceId: 'uart',
    characteristicId: 'rx',
    value,
  });
  assert.deepEqual(received, ['OK\r\n']);
  stopReceiving();
  f.emit('BLECharacteristicValueChange', {
    deviceId: 'robot',
    serviceId: 'UART',
    characteristicId: 'RX',
    value,
  });
  assert.equal(received.length, 1);
  const externalListener = () => undefined;
  f.handlers.get('BLEConnectionStateChange').add(externalListener);
  await f.transport.dispose();
  for (const [name, handlers] of f.handlers)
    assert.equal(handlers.size, name === 'BLEConnectionStateChange' ? 1 : 0);
  assert.equal(f.calls.adapterCloses, 1);
});

test('BLE adapter loss and device disconnect stop delivery immediately', async (t) => {
  const f = fixture(t);
  await f.ready();
  f.emit('BLEConnectionStateChange', { deviceId: 'robot', connected: false });
  assert.equal(f.state().status, 'error');
  await assert.rejects(f.transport.send('S:10;'), /尚未就绪/);
  await f.ready();
  f.emit('BluetoothAdapterStateChange', { available: false, discovering: false });
  assert.equal(f.state().status, 'error');
  assert.match(f.state().error, /蓝牙已关闭/);
  await assert.rejects(f.transport.send('S:10;'), /尚未就绪/);
});

test('BLE state snapshots cannot mutate transport endpoint identity', async (t) => {
  const f = fixture(t);
  await f.transport.connect('robot');
  f.state().endpoints[0].writeId = 'TAMPERED';
  await assert.rejects(f.transport.selectEndpoint(f.state().endpoints[0]), /当前设备/);
  let fresh;
  const unsubscribe = f.transport.subscribe((state) => {
    fresh = state;
  });
  unsubscribe();
  assert.equal(fresh.endpoints[0].writeId, 'WRITE');
});

test('BLE rejects overlapping connection attempts before their first asynchronous step', async (t) => {
  let pendingConnect;
  const f = fixture(t, {
    createBLEConnection(options) {
      pendingConnect = options;
    },
  });
  const first = f.transport.connect('first');
  await assert.rejects(f.transport.connect('second'), /正在连接/);
  await flush();
  pendingConnect.success({});
  await first;
  assert.equal(f.state().deviceId, 'first');
});

test('BLE does not send old queued frames through a newly connected session', async (t) => {
  const writes = [];
  const f = fixture(t, {
    writeBLECharacteristicValue(options) {
      writes.push(options);
    },
  });
  await f.ready();
  const first = assert.rejects(f.transport.send('S:100;'), /会话已结束/);
  const queued = assert.rejects(f.transport.send('S:80;'), /会话已结束/);
  await flush();
  await f.transport.disconnect();
  await Promise.all([first, queued]);
  await f.ready();
  writes[0].success({});
  await flush();
  assert.equal(f.state().status, 'ready');
  assert.equal(writes.length, 1);
  const fresh = f.transport.send('S:0;');
  await flush();
  assert.equal(writes.length, 2);
  writes[1].success({});
  await fresh;
});

test('BLE late discovery start is stopped after the caller has cancelled the scan', async (t) => {
  let pendingStart;
  const f = fixture(t, {
    startBluetoothDevicesDiscovery(options) {
      pendingStart = options;
    },
  });
  const scanning = assert.rejects(f.transport.scan(), /会话已结束/);
  await flush();
  assert.ok(pendingStart);
  await f.transport.disconnect();
  await scanning;
  pendingStart.success({});
  await flush();
  assert.equal(f.state().status, 'idle');
  assert.equal(f.calls.stops, 1);
});

for (const short of [false, true]) {
  test(`ZX-D30 UART excludes GPIO and pairs FFE2 with FFE1 (short=${short})`, async (t) => {
    const uuid = (id) => (short ? id.toLowerCase() : `0000${id}-0000-1000-8000-00805F9B34FB`);
    const f = fixture(t, {
      getBLEDeviceServices(options) {
        options.success({ services: [{ uuid: uuid('FFE0') }] });
      },
      getBLEDeviceCharacteristics(options) {
        options.success({
          characteristics: [
            characteristic(uuid('FFE3'), { write: true, notify: true }),
            characteristic(uuid('FFE2'), { write: true }),
            characteristic(uuid('FFE1'), { write: true, notify: true }),
          ],
        });
      },
    });
    await f.transport.connect('D30SP_126BB2');
    assert.equal(f.state().endpoints.length, 2);
    assert.equal(f.state().endpoints[0].writeId, uuid('FFE2'));
    assert.equal(f.state().endpoints[0].notifyId, uuid('FFE1'));
    assert.equal(f.state().endpoints[1].notifyId, uuid('FFE1'));
    await f.transport.selectEndpoint(f.state().endpoints[0]);
    assert.equal(f.calls.notify[0].characteristicId, uuid('FFE1'));
    await f.transport.send('@ping\n');
    assert.equal(f.calls.writes[0].characteristicId, uuid('FFE2'));
    assert.equal(Buffer.from(f.calls.writes[0].value).toString(), '@ping\n');
    const received = [];
    f.transport.onReceive((text) => received.push(text));
    for (const id of ['FFE3', 'FFE1'])
      f.emit('BLECharacteristicValueChange', {
        deviceId: 'D30SP_126BB2',
        serviceId: uuid('FFE0'),
        characteristicId: uuid(id),
        value: Uint8Array.from(Buffer.from('pong\n')).buffer,
      });
    assert.deepEqual(received, ['pong\n']);
  });
}

test('ZX-D30 never substitutes GPIO notification when UART notify is missing', async (t) => {
  const f = fixture(t, {
    getBLEDeviceServices(options) {
      options.success({ services: [{ uuid: 'FFE0' }] });
    },
    getBLEDeviceCharacteristics(options) {
      options.success({
        characteristics: [
          characteristic('FFE2', { writeNoResponse: true }),
          characteristic('FFE3', { write: true, notify: true }),
        ],
      });
    },
  });
  await f.transport.connect('robot');
  assert.equal(f.state().endpoints.length, 1);
  assert.equal(f.state().endpoints[0].notifyId, undefined);
  await f.transport.selectEndpoint(f.state().endpoints[0]);
  assert.equal(f.calls.notify.length, 0);
  assert.match(f.state().error, /未启用返回通知/);
});
