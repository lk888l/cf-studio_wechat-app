const test = require('node:test');
const assert = require('node:assert/strict');
const {
  InstallationService,
  parseInstallationStatus,
  encodeInstallationCommand,
} = require('../.test-build/miniprogram/services/installation.js');
const reply = (active = 1, ready = 1, control = 'off') =>
  `install: active=${active} ready=${ready} height=44.5 control=${control}\n`;
const flush = async () => {
  for (let i = 0; i < 20; ++i) await Promise.resolve();
};

test('installation protocol requires complete consistent firmware state', () => {
  assert.equal(encodeInstallationCommand('install on'), 'install on\n');
  assert.throws(() => encodeInstallationCommand('control on'));
  assert.deepEqual(parseInstallationStatus(reply().trim()), {
    active: true,
    ready: true,
    control: false,
  });
  for (const text of [
    reply(1, 1, 'on'),
    reply(0, 1),
    'install: active=1 ready=1',
    'receive: install on',
  ])
    assert.equal(parseInstallationStatus(text.trim()), null);
});
test('GATT completion alone cannot confirm installation; split UART response can', async () => {
  let service = new InstallationService(
    async (_, start) => start(),
    () => {},
  );
  const work = service.set(true);
  await flush();
  assert.equal(service.snapshot().status, null);
  assert.ok(service.snapshot().busy);
  service.receive('install: active=1 re');
  service.receive('ady=1 height=44.5 control=off\r\n');
  await work;
  assert.equal(service.snapshot().status.ready, true);
});
test('moving acknowledgement is followed by a status query, never control on', async () => {
  const writes = [];
  const service = new InstallationService(
    async (frame, start) => {
      writes.push(frame);
      start();
      service.receive(reply(1, writes.length > 1 ? 1 : 0));
    },
    () => {},
  );
  await service.set(true);
  assert.deepEqual(writes, ['install on\n', 'install status\n']);
  assert.equal(service.snapshot().status.ready, true);
});
test('exit confirms inactive and leaves control off', async () => {
  const writes = [];
  const service = new InstallationService(
    async (frame, start) => {
      writes.push(frame);
      start();
      service.receive(reply(0, 0));
    },
    () => {},
  );
  await service.set(false);
  assert.deepEqual(writes, ['install off\n']);
  assert.deepEqual(service.snapshot().status, { active: false, ready: false, control: false });
});
test('disconnect and late acknowledgements cannot report a successful installation', async () => {
  const service = new InstallationService(
    async (_, start) => start(),
    () => {},
  );
  const work = service.set(true);
  service.receive('install: active=1 ');
  service.reset();
  service.receive('ready=1 height=44.5 control=off\n');
  await work;
  assert.equal(service.snapshot().status, null);
  assert.equal(service.snapshot().success, false);
});
test('unsupported firmware times out without a false locked state', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = new InstallationService(
    async (_, start) => start(),
    () => {},
  );
  const work = service.set(true);
  service.receive('receive: install on\n');
  t.mock.timers.tick(5001);
  await work;
  assert.equal(service.snapshot().status, null);
  assert.match(service.snapshot().message, /未收到安装回执/);
});
test('firmware rejection is shown immediately and retains unknown state', async () => {
  const service = new InstallationService(
    async (_, start) => {
      start();
      service.receive('install: rejected; system not ready or storage busy\n');
    },
    () => {},
  );
  await service.set(true);
  assert.equal(service.snapshot().success, false);
  assert.match(service.snapshot().message, /拒绝/);
});
