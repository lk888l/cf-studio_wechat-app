const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ParameterService,
  PARAMETER_TIMEOUT_MS,
  encodeParameterCommand,
  parseParameterStatus,
  parseSaveResult,
} = require('../.test-build/miniprogram/services/parameters.js');

const statusLine = (fields = '') =>
  `params: flash_valid=true unsaved=true armed=false enabled=false${fields}\r\n`;
async function flush() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}
function fixture(t, write) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const frames = [];
  const service = new ParameterService(
    write ||
      (async (frame, start) => {
        start();
        frames.push(frame);
      }),
    () => undefined,
  );
  t.after(() => service.reset());
  return { service, frames };
}

test('maintenance commands are exact ASCII lines without @ or recycle', () => {
  for (const command of ['params', 'save', 'control off', 'control on'])
    assert.equal(encodeParameterCommand(command), command + '\n');
  assert.throws(() => encodeParameterCommand('save recycle'));
  assert.throws(() => encodeParameterCommand('save\ncontrol off'));
  assert.equal(parseParameterStatus('control: off requested; wait for params armed=false'), null);
  assert.equal(parseParameterStatus('params: loaded from flash'), null);
  assert.equal(parseParameterStatus('params: unsaved=true disarmed=false'), null);
  assert.equal(parseParameterStatus('params: unsaved=true armed=falsehood'), null);
  assert.deepEqual(parseParameterStatus('params: armed=0 unsaved=1 enabled=0 flash_valid=1'), {
    armed: false,
    unsaved: true,
    enabled: false,
    flashValid: true,
  });
  assert.equal(parseSaveResult('save: okay'), null);
  assert.equal(parseSaveResult('nRF: send success'), null);
});

test('save sends only save immediately, accepts split CRLF and ignores unrelated ACKs', async (t) => {
  const { service, frames } = fixture(t);
  const saving = service.save();
  assert.deepEqual(frames, ['save\n']);
  service.receive('control: off requested; wait for params armed=false before save\n');
  service.receive('params: flash_valid=true unsaved=true arm');
  service.receive('ed=false enabled=false\r');
  await flush();
  assert.deepEqual(frames, ['save\n']);
  service.receive('\nanglepid p_mid=60\n');
  await flush();
  assert.deepEqual(frames, ['save\n']);
  service.receive('OK\nnRF: send success\nsave: o');
  await flush();
  assert.equal(service.snapshot().busy, 'save');
  assert.equal(service.snapshot().success, false);
  service.receive('k (all motion parameters)\r');
  assert.equal(service.snapshot().busy, 'save');
  service.receive('\n');
  await saving;
  assert.equal(service.snapshot().message, '保存成功');
  assert.equal(service.snapshot().success, true);
  assert.equal(service.snapshot().status, null);
});

for (const [reply, message, success] of [
  ['unchanged (no flash write)', '参数未变化，已经保存', true],
  ['busy; system is starting', '小车正在启动，请稍后重试保存', false],
  [
    'busy; recycle requires stopped control, or another save is active',
    '小车暂时忙，请稍后重试保存',
    false,
  ],
  ['full; use save recycle to erase journal and save', '参数存储区已满', false],
  ['invalid parameters', '参数无效', false],
  ['flash error; RAM settings retained', '当前 RAM 参数仍保留', false],
]) {
  test(`save result ${reply} is interpreted from its prefix`, async (t) => {
    const { service, frames } = fixture(t);
    const saving = service.save();
    service.receive('save: ' + reply + '\n');
    await saving;
    assert.equal(service.snapshot().success, success);
    assert.ok(service.snapshot().message.includes(message));
    if (reply.startsWith('busy'))
      assert.doesNotMatch(service.snapshot().message, /关闭控制|扶稳|平衡控制/);
    assert.deepEqual(frames, ['save\n']);
  });
}

for (const fields of [
  'armed=true enabled=false',
  'armed=false enabled=true',
  'armed=true enabled=true',
]) {
  test(`runtime save succeeds with cached control status ${fields}`, async (t) => {
    const { service, frames } = fixture(t);
    const query = service.query();
    service.receive(`params: unsaved=true ${fields}\n`);
    await query;
    frames.length = 0;
    const saving = service.save();
    assert.deepEqual(frames, ['save\n']);
    service.receive('save: ok (all motion parameters)\n');
    await saving;
    assert.deepEqual(frames, ['save\n']);
    assert.equal(service.snapshot().success, true);
    assert.equal(service.snapshot().message, '保存成功');
  });
}

test('save times out without claiming success, ignores late results and prevents duplicate operations', async (t) => {
  const { service, frames } = fixture(t);
  const saving = service.save();
  await service.save();
  await service.query();
  await service.control(false);
  assert.deepEqual(frames, ['save\n']);
  await service.save();
  service.receive('save: ok');
  t.mock.timers.tick(PARAMETER_TIMEOUT_MS);
  await saving;
  assert.equal(service.snapshot().message, '未收到保存结果');
  assert.equal(service.snapshot().busy, '');
  assert.equal(service.snapshot().success, false);
  service.receive('\nsave: ok\n');
  assert.equal(service.snapshot().success, false);
  assert.deepEqual(frames, ['save\n']);
});

test('saving needs no params response, and malformed status cannot confirm a save', async (t) => {
  const { service, frames } = fixture(t);
  const saving = service.save();
  service.receive('params: armed=false\ncontrol: off requested\n');
  t.mock.timers.tick(PARAMETER_TIMEOUT_MS);
  await saving;
  assert.match(service.snapshot().message, /未收到保存结果/);
  assert.deepEqual(frames, ['save\n']);
});

test('manual off still reports the actual queried control state', async (t) => {
  const { service, frames } = fixture(t);
  const closing = service.control(false);
  service.receive('control: off requested; wait for params armed=false before save\n');
  await flush();
  assert.equal(service.snapshot().status, null);
  assert.deepEqual(frames, ['control off\n', 'params\n']);
  service.receive('params: unsaved=true armed=true enabled=false\n');
  await closing;
  assert.match(service.snapshot().message, /尚未关闭/);
  assert.equal(service.snapshot().status.armed, true);
  const query = service.query();
  service.receive(statusLine());
  await query;
  assert.equal(service.snapshot().status.armed, false);
  assert.ok(!frames.includes('save\n'));
});

test('control on is explicit and rejection is not displayed as restored', async (t) => {
  const { service, frames } = fixture(t);
  const opening = service.control(true);
  service.receive('control: on rejected; system not ready\n');
  await opening;
  assert.match(service.snapshot().message, /拒绝恢复/);
  assert.deepEqual(frames, ['control on\n']);
  const retry = service.control(true);
  service.receive('control: on; waiting for normal startup conditions\n');
  await flush();
  service.receive('params: unsaved=false armed=false enabled=true\n');
  await retry;
  assert.match(service.snapshot().message, /正常稳定启动流程/);
  assert.equal(service.snapshot().status.enabled, true);
});

test('reset cancels a pending save even when its result just arrived', async (t) => {
  const { service, frames } = fixture(t);
  const saving = service.save();
  service.receive('save: ok\n');
  service.reset('未收到保存结果：连接已断开');
  await saving;
  service.receive('save: ok\n');
  assert.deepEqual(frames, ['save\n']);
  assert.equal(service.snapshot().status, null);
  assert.equal(service.snapshot().success, false);
  assert.match(service.snapshot().message, /连接已断开/);
});

test('replies arriving before the actual queued write cannot satisfy a request', async (t) => {
  const starts = [];
  const { service } = fixture(t, async (_frame, start) => {
    starts.push(start);
  });
  const query = service.query();
  service.receive(statusLine());
  service.receive('params: unsaved=true armed=');
  starts[0]();
  service.receive('false enabled=false\n');
  await flush();
  assert.equal(service.snapshot().status, null);
  service.receive(statusLine());
  await query;
  assert.equal(service.snapshot().status.armed, false);
});

test('overlong lines are discarded through newline and cannot masquerade as replies', async (t) => {
  const { service } = fixture(t);
  const query = service.query();
  service.receive('x'.repeat(10000) + statusLine());
  assert.equal(service.snapshot().status, null);
  service.receive(statusLine());
  await query;
  assert.equal(service.snapshot().status.armed, false);
});

test('failed BLE save write reports failure without a false RAM/Flash confirmation', async (t) => {
  const { service } = fixture(t, async (frame, start) => {
    start();
    if (frame === 'save\n') throw new Error('write failed');
  });
  const saving = service.save();
  service.receive(statusLine());
  await saving;
  assert.match(service.snapshot().message, /未收到保存结果.*蓝牙发送失败/);
  assert.equal(service.snapshot().success, false);
});
