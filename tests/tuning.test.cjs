const test = require('node:test');
const assert = require('node:assert/strict');
const {
  tuningGroups,
  encodeTuning,
  encodeAutoAngleKp,
} = require('../.test-build/miniprogram/devices/tuning.js');

test('tuning commands match car handlers, without VOFA radio wrappers or incorrect roll option', () => {
  assert.equal(encodeTuning('wl1-main', 'angle-bias', '12.6'), 'anglebias 12.6');
  assert.equal(encodeTuning('wl1-main', 'motor-deadzone', '75'), 'deadzone 75');
  assert.equal(encodeTuning('wl1-main', 'angle-d', '-10.1'), 'anglepid -d -10.1');
  assert.equal(encodeTuning('wl1-main', 'velocity-i', '0.008'), 'velocitypid -i 0.008');
  assert.equal(encodeTuning('wl1-main', 'difference-i', '0.001'), 'differpid -i 0.001');
  assert.equal(encodeTuning('wl1-main', 'roll-i', '-0.4'), 'rollpid -i -0.4');
  assert.throws(() => encodeTuning('wl1-main', 'roll-p', '1'));
  assert.throws(() => encodeTuning('wl1-main', 'roll-d', '1'));
  assert.throws(() => encodeTuning('wl1-main', 'angle-p', '70'));
  assert.throws(() => encodeAutoAngleKp('wl1-main'));
  assert.equal(encodeTuning('wl1-softengine', 'angle-p', '70.0'), '@anglepid -p 70\n');
  assert.equal(encodeTuning('wl1-softengine', 'roll-p', '-0.4'), '@rollpid -p -0.4\n');
  assert.equal(encodeTuning('wl1-softengine', 'roll-d', '0.1'), '@rollpid -d 0.1\n');
  assert.equal(encodeAutoAngleKp('wl1-softengine'), '@anglepid -auto\n');
  assert.equal(encodeTuning('wl1-softengine', 'motor-deadzone', '0'), '@deadzone 0\n');
});

test('balance group exposes one shared bounded integer motor dead-zone control', () => {
  const balance = tuningGroups('wl1-main')[0];
  assert.equal(balance.name, '重心标定与电机输出死区');
  const deadzone = balance.parameters.find((parameter) => parameter.id === 'motor-deadzone');
  assert.deepEqual(
    {
      label: deadzone.label,
      command: deadzone.command,
      minimum: deadzone.minimum,
      maximum: deadzone.maximum,
      step: deadzone.step,
      digits: deadzone.digits,
      initial: deadzone.initial,
    },
    {
      label: '电机输出死区 / PWM',
      command: 'deadzone',
      minimum: 0,
      maximum: 1000,
      step: 1,
      digits: 0,
      initial: 0,
    },
  );
  for (const value of ['-1', '1001', '50.5', '50junk'])
    assert.throws(() => encodeTuning('wl1-main', 'motor-deadzone', value));
});

test('every selectable parameter value fits its transport, including values just below powers of ten', () => {
  for (const profile of ['wl1-main', 'wl1-softengine']) {
    for (const parameter of tuningGroups(profile).flatMap((group) => group.parameters)) {
      if (parameter.unavailable) continue;
      const steps = Math.round((parameter.maximum - parameter.minimum) / parameter.step);
      for (let index = 0; index <= steps; index++) {
        const value = (parameter.minimum + index * parameter.step).toFixed(parameter.digits);
        const frame = encodeTuning(profile, parameter.id, value);
        assert.ok(frame.length <= (profile === 'wl1-main' ? 20 : 34), frame);
        assert.match(
          frame,
          profile === 'wl1-main'
            ? /^[a-z]+(?: -[pid])? -?[\d.]+$/
            : /^@[a-z]+(?: -[pid])? -?[\d.]+\n$/,
        );
      }
    }
  }
});

test('invalid, nonfinite, injected, out-of-range and overprecise parameter input is rejected', () => {
  for (const value of [
    '',
    ' ',
    '-',
    '.',
    'NaN',
    'Infinity',
    '1e-3',
    '0x10',
    '1\nR 0 0 0 44.5',
    '1abc',
    '1,2',
    '20.1',
    '-20.1',
    '0.01',
    '0.0000000001',
  ]) {
    assert.throws(() => encodeTuning('wl1-main', 'angle-bias', value), value);
  }
  assert.throws(() => encodeTuning('unknown', 'angle-bias', '1'));
  assert.throws(() => encodeTuning('wl1-main', 'motor', '1'));
  assert.equal(encodeTuning('wl1-main', 'angle-bias', '-0.0'), 'anglebias 0');
});
