const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DeviceInfoService,
  encodeDeviceInfoCommand,
  parseUniqueId,
  parseAngleBiasStatus,
  parseRollBiasStatus,
} = require('../.test-build/miniprogram/services/device-info.js');

const uid = 'uid: 0123456789ABCDEF10203040\n';
const pitch = 'anglebias base=9.5371 effective=7.2134\n';
const roll = 'rollbias base=-2.5312 raw=2.5000 effective=-0.0312\n';
const flush = async () => {
  for (let i = 0; i < 20; ++i) await Promise.resolve();
};

test('device read commands and exact firmware readouts', () => {
  assert.equal(encodeDeviceInfoCommand('uid'), 'uid\n');
  assert.equal(encodeDeviceInfoCommand('anglebias'), 'anglebias\n');
  assert.equal(encodeDeviceInfoCommand('rollbias'), 'rollbias\n');
  assert.throws(() => encodeDeviceInfoCommand('params'));
  assert.equal(parseUniqueId(uid.trim()), '0123456789ABCDEF10203040');
  assert.deepEqual(parseAngleBiasStatus(pitch.trim()), { base: 9.5371, effective: 7.2134 });
  assert.deepEqual(parseRollBiasStatus(roll.trim()), {
    base: -2.5312,
    raw: 2.5,
    effective: -0.0312,
  });
  for (const invalid of [
    'anglebias min=9.5371 effective=7.2134',
    'anglebias base=nan effective=0.0000',
    'anglebias base=9.5371 effective=7.2134 extra=1',
  ])
    assert.equal(parseAngleBiasStatus(invalid), null);
  for (const invalid of [
    'rollbias base=-2.5312 raw=2.5000',
    'rollbias base=-2.5312 raw=2.5000 effective=nan',
    'rollbias base=-2.5312 raw=2.5000 effective=-0.0312 extra=1',
  ])
    assert.equal(parseRollBiasStatus(invalid), null);
});

test('handshake reads UID, pitch and roll in order from fragmented notifications', async () => {
  const writes = [];
  const service = new DeviceInfoService(
    async (frame, start) => {
      writes.push(frame);
      start();
    },
    () => {},
  );
  const work = service.readAll();
  await flush();
  assert.deepEqual(writes, ['uid\n']);
  service.receive(uid.slice(0, 12));
  assert.equal(service.snapshot().uid, '');
  service.receive(uid.slice(12));
  await flush();
  assert.deepEqual(writes, ['uid\n', 'anglebias\n']);
  service.receive(pitch);
  await flush();
  service.receive(roll.slice(0, 19));
  assert.equal(service.snapshot().rollBias, null);
  service.receive(roll.slice(19));
  await work;
  assert.deepEqual(writes, ['uid\n', 'anglebias\n', 'rollbias\n']);
  assert.equal(service.snapshot().angleBias.base, 9.5371);
  assert.equal(service.snapshot().rollBias.base, -2.5312);
  assert.equal(service.snapshot().busy, '');
});

test('pre-write text and a previous connection cannot initialize calibration', async () => {
  let begin;
  const service = new DeviceInfoService(
    async (_, start) => {
      begin = start;
    },
    () => {},
  );
  const old = service.readAll();
  service.receive(uid);
  assert.equal(service.snapshot().uid, '');
  service.reset();
  assert.throws(begin, /取消/);
  await old;
  const current = service.readAll();
  begin();
  service.receive(uid);
  await flush();
  begin();
  service.receive(pitch);
  await flush();
  begin();
  service.receive(roll);
  await current;
  assert.equal(service.snapshot().angleBias.base, 9.5371);
});

test('unsupported UID does not prevent reading both center angles', async () => {
  const service = new DeviceInfoService(
    async (frame, start) => {
      start();
      if (frame === 'uid\n') service.receive('receive: uid\n');
      if (frame === 'anglebias\n') service.receive(pitch);
      if (frame === 'rollbias\n') service.receive(roll);
    },
    () => {},
  );
  await service.readAll();
  assert.equal(service.snapshot().uid, '');
  assert.equal(service.snapshot().angleBias.base, 9.5371);
  assert.equal(service.snapshot().rollBias.base, -2.5312);
  assert.match(service.snapshot().message, /序列号/);
});

test('a missing roll reply leaves its midpoint unknown while retaining the pitch readout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = new DeviceInfoService(
    async (frame, start) => {
      start();
      if (frame === 'uid\n') service.receive(uid);
      if (frame === 'anglebias\n') service.receive(pitch);
    },
    () => {},
  );
  const work = service.readAll();
  await flush();
  assert.equal(service.snapshot().busy, 'rollbias');
  t.mock.timers.tick(5001);
  await work;
  assert.equal(service.snapshot().angleBias.base, 9.5371);
  assert.equal(service.snapshot().rollBias, null);
  assert.match(service.snapshot().message, /横滚中点.*超时/);
});
