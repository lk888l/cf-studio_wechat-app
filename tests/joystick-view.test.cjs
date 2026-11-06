const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '../miniprogram/pages/wl1/joystick.wxs'),
  'utf8',
);
const touch = (identifier, clientX, clientY) => ({ identifier, clientX, clientY });
const motionRect = { left: 0, top: 0, width: 200, height: 200 };
const poseRect = { left: 400, top: 0, width: 200, height: 200 };

function fixture() {
  const context = { module: { exports: {} } };
  vm.runInNewContext(source, context, { filename: 'joystick.wxs' });
  const joystick = context.module.exports;
  const calls = [];
  const styles = {};
  const order = [];
  const owner = {
    selectComponent(selector) {
      return {
        setStyle(style) {
          styles[selector] = structuredClone(style);
          order.push({ kind: 'style', selector });
        },
      };
    },
    callMethod(name, payload) {
      calls.push({ name, payload: structuredClone(payload) });
      order.push({ kind: 'call', phase: payload.phase });
    },
  };
  const sticks = {};
  for (const side of ['motion', 'pose']) {
    const state = {};
    const instance = { getState: () => state };
    let config;
    sticks[side] = {
      configure(update) {
        const previous = config;
        config = { ...config, ...update, side };
        joystick.configure(config, previous, owner, instance);
      },
      event(phase, changedTouches, touches = changedTouches, type = `touch${phase}`) {
        return joystick[phase]({ instance, changedTouches, touches, type }, owner);
      },
      state,
    };
    sticks[side].configure({
      rect: side === 'motion' ? motionRect : poseRect,
      enabled: true,
      epoch: 1,
    });
  }
  return { ...sticks, calls, styles, order };
}

test('WXS draws in the view before forwarding every control event without a logic callback', () => {
  const f = fixture();
  f.order.length = 0;
  assert.equal(f.motion.event('start', [touch(0, 120, 100)]), false);
  assert.equal(f.styles['#motion-knob'].transform, 'translate3d(20px, 0px, 0)');
  for (let x = 121; x <= 130; x++) f.motion.event('move', [touch(0, x, 100)]);
  assert.equal(f.styles['#motion-knob'].transform, 'translate3d(30px, 0px, 0)');
  assert.equal(f.calls.length, 11);
  assert.equal(f.calls.at(-1).name, 'onStickTouch');
  assert.deepEqual(f.calls.at(-1).payload, {
    side: 'motion',
    phase: 'move',
    touches: [touch(0, 130, 100)],
    changedTouches: [touch(0, 130, 100)],
    epoch: 1,
  });
  for (let index = 0; index < f.order.length; index += 2) {
    assert.equal(f.order[index].kind, 'style');
    assert.equal(f.order[index + 1].kind, 'call');
  }
});

test('WXS clamps both axes to a circle using the shorter measured side', () => {
  const f = fixture();
  f.motion.configure({ rect: { left: 10, top: 20, width: 200, height: 100 } });
  f.motion.event('start', [touch(1, 310, 270)]);
  assert.equal(f.styles['#motion-knob'].transform, 'translate3d(23px, 23px, 0)');
  f.motion.event('move', [touch(1, -100, 70)]);
  assert.equal(f.styles['#motion-knob'].transform, 'translate3d(-32px, 0px, 0)');
});

test('WXS keeps two sticks and extra fingers isolated by touch identifier', () => {
  const f = fixture();
  const left = touch(0, 120, 100);
  const right = touch(4, 500, 70);
  const extra = touch(8, 40, 100);
  f.motion.event('start', [left]);
  f.pose.event('start', [right], [left, right]);
  f.motion.event('start', [extra], [left, right, extra]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.motion.state.touchId, 0);
  f.motion.event('move', [touch(0, 130, 100)], [right, extra, touch(0, 130, 100)]);
  assert.equal(f.styles['#motion-knob'].transform, 'translate3d(30px, 0px, 0)');
  assert.equal(f.styles['#pose-knob'].transform, 'translate3d(0px, -30px, 0)');
  f.motion.event('end', [extra], [left, right]);
  assert.equal(f.calls.length, 3);
  assert.equal(f.motion.state.active, true);
  f.motion.event('end', [left], [right]);
  assert.equal(f.styles['#motion-knob'].transform, 'translate3d(0px, 0px, 0)');
  assert.equal(f.styles['#pose-knob'].transform, 'translate3d(0px, -30px, 0)');
  assert.equal(f.pose.state.active, true);
  assert.equal(f.calls.at(-1).payload.phase, 'end');
});

test('WXS forwards an unmeasured gesture and redraws its latest position when layout arrives', () => {
  const f = fixture();
  f.motion.configure({ rect: null });
  f.motion.event('start', [touch(1, 105, 100)]);
  f.motion.event('move', [touch(1, 140, 110)]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.styles['#motion-knob'].transform, 'translate3d(0px, 0px, 0)');
  f.motion.configure({ rect: motionRect });
  assert.equal(f.styles['#motion-knob'].transform, 'translate3d(40px, 10px, 0)');
  assert.equal(f.calls.length, 2);
});

test('epoch invalidation resets locally and stale move/end cannot restore the gesture', () => {
  const f = fixture();
  const held = touch(1, 140, 100);
  f.motion.event('start', [held]);
  f.motion.configure({ epoch: 2 });
  assert.equal(f.styles['#motion-knob'].transform, 'translate3d(0px, 0px, 0)');
  assert.equal(f.motion.state.active, false);
  f.motion.event('move', [held]);
  f.motion.event('end', [held], []);
  f.motion.configure({ rect: motionRect });
  assert.equal(f.calls.length, 1);
  assert.equal(f.styles['#motion-knob'].transform, 'translate3d(0px, 0px, 0)');
  f.motion.event('start', [touch(2, 110, 100)]);
  assert.equal(f.calls.at(-1).payload.epoch, 2);
  assert.equal(f.styles['#motion-knob'].transform, 'translate3d(10px, 0px, 0)');
});

test('disabling resets each knob and re-enabling requires a fresh start', () => {
  const f = fixture();
  const held = touch(1, 140, 100);
  f.motion.event('start', [held]);
  f.motion.configure({ enabled: false });
  f.motion.event('start', [held]);
  f.motion.event('move', [held]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.styles['#motion-knob'].transform, 'translate3d(0px, 0px, 0)');
  f.motion.configure({ enabled: true });
  f.motion.event('move', [held]);
  assert.equal(f.calls.length, 1);
  f.motion.event('start', [touch(2, 100, 80)]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.styles['#motion-knob'].transform, 'translate3d(0px, -20px, 0)');
});

test('cancel ends locally before logic delivery, including a missing changedTouches array', () => {
  const f = fixture();
  const held = touch(1, 140, 100);
  f.motion.event('start', [held]);
  f.order.length = 0;
  f.motion.event('end', [], [held], 'touchcancel');
  assert.equal(f.styles['#motion-knob'].transform, 'translate3d(0px, 0px, 0)');
  assert.equal(f.motion.state.active, false);
  assert.equal(f.calls.at(-1).payload.phase, 'end');
  assert.equal(f.calls.at(-1).payload.changedTouches[0].identifier, 1);
  assert.deepEqual(
    f.order.map((item) => item.kind),
    ['style', 'call'],
  );
  f.motion.configure({ rect: motionRect });
  f.motion.event('move', [held]);
  assert.equal(f.calls.length, 2);
});

test('a normal cancel for another finger leaves the owning gesture active', () => {
  const f = fixture();
  const held = touch(1, 140, 100);
  f.motion.event('start', [held]);
  f.motion.event('end', [touch(2, 70, 100)], [held], 'touchcancel');
  assert.equal(f.calls.length, 1);
  assert.equal(f.motion.state.active, true);
  f.motion.event('end', [held], [], 'touchcancel');
  assert.equal(f.calls.length, 2);
  assert.equal(f.styles['#motion-knob'].transform, 'translate3d(0px, 0px, 0)');
});
