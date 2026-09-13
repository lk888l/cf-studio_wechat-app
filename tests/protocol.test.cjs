const test = require('node:test');
const assert = require('node:assert/strict');
const {
  encodeWl1,
  normalizeWl1,
  neutral,
  joystickVector,
  legJoystickVector,
  wl1Main,
  deviceProfiles,
} = require('../.test-build/miniprogram/devices/profiles.js');

test('WL1 encodes the car field order and the physical remote speed sign', () => {
  const fixtures = [
    [{ speed: 0, turn: 0, roll: 0, height: 44.5 }, 'R 0 0 0 44.5'],
    [{ speed: 30, turn: -12, roll: 8, height: 61.5 }, 'R -12 -30 8 61.5'],
    [{ speed: -30, turn: 12, roll: -8, height: 78.5 }, 'R 12 30 -8 78.5'],
    [{ speed: 100, turn: -100, roll: -18, height: 78.5 }, 'R -100 -100 -18 78.5'],
    [{ speed: -0, turn: -0, roll: -0, height: 61.5 }, 'R 0 0 0 61.5'],
  ];
  for (const [input, expected] of fixtures) assert.equal(encodeWl1(input), expected);
});

test('all physical-remote range corners fit one complete 20-byte ASCII write', () => {
  let longest = 0;
  for (const speed of [-100, 100]) {
    for (const turn of [-100, 100]) {
      for (const roll of [-18, 18]) {
        for (const height of [44.5, 78.5]) {
          const frame = encodeWl1({ speed, turn, roll, height });
          const bytes = Buffer.from(frame, 'ascii');
          assert.ok(bytes.length <= 20, frame);
          assert.match(frame, /^R -?\d+ -?\d+ -?\d+ \d{2}\.\d$/);
          assert.equal(bytes.toString('ascii'), frame);
          assert.ok(!/[\r\n\0]/.test(frame), 'UART idle is the frame boundary');
          longest = Math.max(longest, bytes.length);
        }
      }
    }
  }
  assert.equal(longest, 20);
});

test('out-of-range commands are bounded to the proven remote limits', () => {
  assert.deepEqual(normalizeWl1({ speed: 10000, turn: -10000, roll: 500, height: -1 }), {
    speed: 100,
    turn: -100,
    roll: 18,
    height: 44.5,
  });
  assert.deepEqual(normalizeWl1({ speed: -10000, turn: 10000, roll: -500, height: 500 }), {
    speed: -100,
    turn: 100,
    roll: -18,
    height: 78.5,
  });
  assert.equal(
    encodeWl1({ speed: 10000, turn: -10000, roll: -500, height: 500 }),
    'R -100 -100 -18 78.5',
  );
});

test('fractional input uses integer motion and 0.1 mm height without mutating input', () => {
  const input = Object.freeze({ speed: 23.2, turn: -41.8, roll: 7.1, height: 62.34 });
  assert.deepEqual(normalizeWl1(input), { speed: 23, turn: -42, roll: 7, height: 62.3 });
  assert.equal(encodeWl1(input), 'R -42 -23 7 62.3');
});

test('NaN and infinities in every field are rejected before serialization', () => {
  for (const field of ['speed', 'turn', 'roll', 'height']) {
    for (const value of [NaN, Infinity, -Infinity]) {
      const input = { ...wl1Main.initial, [field]: value };
      assert.throws(() => normalizeWl1(input), Error, `${field}: ${value}`);
      assert.throws(() => encodeWl1(input), Error, `${field}: ${value}`);
    }
  }
});

test('neutral removes every motion target and preserves the selected leg height', () => {
  const input = Object.freeze({ speed: 55, turn: -22, roll: 10, height: 72.5 });
  assert.deepEqual(neutral(input), { speed: 0, turn: 0, roll: 0, height: 72.5 });
});

test('joystick forward, backward, lateral and dead-zone behavior follow user direction', () => {
  assert.deepEqual(joystickVector(0, -1, 30), { speed: 30, turn: 0 });
  assert.equal(joystickVector(0, 1, 30).speed, -30);
  assert.equal(joystickVector(1, 0, 30).turn, 30);
  assert.deepEqual(joystickVector(0.02, -0.02, 100), { speed: 0, turn: 0 });
  assert.deepEqual(joystickVector(NaN, 0, 30), { speed: 0, turn: 0 });
  const diagonal = joystickVector(2, -2, 30);
  assert.ok(diagonal.speed > 0 && diagonal.turn > 0);
  assert.ok(Math.hypot(diagonal.speed, diagonal.turn) <= 31);
});

test('SoftEngine uses explicit framing while main keeps its legacy wire format', () => {
  const profile = deviceProfiles.find((item) => item.id === 'wl1-softengine');
  assert.ok(profile && profile.supported);
  for (const speed of [-100, 0, 100]) {
    for (const turn of [-100, 0, 100]) {
      for (const roll of [-18, 0, 18]) {
        const input = { speed, turn, roll, height: 78.5 };
        assert.equal(profile.encode(input), `@${encodeWl1(input)}\n`);
        assert.ok(Buffer.byteLength(profile.encode(input), 'ascii') <= 22);
      }
    }
  }
});

test('leg joystick center and its axis dead zones preserve the gesture anchor height', () => {
  for (const anchorHeight of [44.5, 50, 61.5, 63.2, 78.5]) {
    assert.deepEqual(legJoystickVector(0, 0, anchorHeight), { height: anchorHeight, roll: 0 });
    assert.deepEqual(legJoystickVector(0.1, -0.1, anchorHeight), { height: anchorHeight, roll: 0 });
    assert.deepEqual(legJoystickVector(-0.12, 0.12, anchorHeight), {
      height: anchorHeight,
      roll: 0,
    });
  }
});

test('leg joystick up raises height, down lowers height and horizontal direction sets roll', () => {
  assert.deepEqual(legJoystickVector(0, -1, 61.5), { height: 78.5, roll: 0 });
  assert.deepEqual(legJoystickVector(0, 1, 61.5), { height: 44.5, roll: 0 });
  assert.deepEqual(legJoystickVector(1, 0, 61.5), { height: 61.5, roll: 18 });
  assert.deepEqual(legJoystickVector(-1, 0, 61.5), { height: 61.5, roll: -18 });
  assert.deepEqual(legJoystickVector(0.56, -0.56, 61.5), { height: 70, roll: 9 });
});

test('leg joystick axes are independent so a roll gesture cannot change leg height', () => {
  assert.deepEqual(legJoystickVector(1, 0.1, 65), { height: 65, roll: 18 });
  assert.deepEqual(legJoystickVector(-0.1, -1, 50), { height: 67, roll: 0 });
  assert.deepEqual(legJoystickVector(1, -1, 61.5), { height: 78.5, roll: 18 });
});

test('leg joystick displacement is relative to a fixed gesture anchor and bounded at both ends', () => {
  assert.deepEqual(legJoystickVector(0, -1, 50), { height: 67, roll: 0 });
  assert.deepEqual(legJoystickVector(0, 1, 50), { height: 44.5, roll: 0 });
  assert.deepEqual(legJoystickVector(0, -1, 75), { height: 78.5, roll: 0 });
  assert.deepEqual(legJoystickVector(0, 1, 75), { height: 58, roll: 0 });
  assert.deepEqual(legJoystickVector(100, -100, 61.5), { height: 78.5, roll: 18 });
  assert.deepEqual(legJoystickVector(-100, 100, 61.5), { height: 44.5, roll: -18 });
  for (const height of [44.5, 50, 61.5, 75, 78.5]) {
    for (const x of [-2, -1, 0, 1, 2]) {
      for (const y of [-2, -1, 0, 1, 2]) {
        const pose = legJoystickVector(x, y, height);
        assert.ok(pose.height >= 44.5 && pose.height <= 78.5);
        assert.ok(pose.roll >= -18 && pose.roll <= 18);
        assert.ok(Buffer.byteLength(encodeWl1({ ...pose, speed: 100, turn: -100 }), 'ascii') <= 20);
      }
    }
  }
});
