const test = require('node:test');
const assert = require('node:assert/strict');
const { RemoteController } = require('../.test-build/miniprogram/control/controller.js');
const { wl1Main, deviceProfiles } = require('../.test-build/miniprogram/devices/profiles.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const neutralFrame = 'R 0 0 0 44.5';

class ManualClock {
  time = 0;
  nextId = 1;
  timers = new Map();
  now() {
    return this.time;
  }
  setInterval(callback, ms) {
    const id = this.nextId++;
    this.timers.set(id, { callback, ms, due: this.time + ms });
    return id;
  }
  clearInterval(id) {
    this.timers.delete(id);
  }
  advance(ms) {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      const [, timer] = due;
      this.time = timer.due;
      timer.due += timer.ms;
      timer.callback();
    }
    this.time = target;
  }
}

function immediateController(t) {
  const timing = new ManualClock();
  const frames = [];
  const controller = new RemoteController(
    wl1Main,
    async (frame) => {
      frames.push(frame);
    },
    undefined,
    timing,
  );
  t.after(() => controller.dispose());
  return { controller, timing, frames };
}

function delayedController(t) {
  const timing = new ManualClock();
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const controller = new RemoteController(
    wl1Main,
    (frame) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return new Promise((resolve, reject) => {
        calls.push({
          frame,
          resolve() {
            active -= 1;
            resolve();
          },
          reject(error) {
            active -= 1;
            reject(error);
          },
        });
      });
    },
    undefined,
    timing,
  );
  t.after(() => controller.dispose());
  return { controller, timing, calls, maximumActive: () => maximumActive };
}

test('arming requires a ready, explicitly supported device and starts with neutral', async (t) => {
  const { controller, frames } = immediateController(t);
  assert.throws(() => controller.arm());
  controller.move(100, 100);
  controller.pose(78.5, 18);
  assert.deepEqual(frames, []);
  controller.setReady(true);
  controller.arm();
  await flush();
  assert.deepEqual(frames, [neutralFrame]);
  assert.equal(controller.snapshot().armed, true);

  const future = deviceProfiles.find((item) => item.id === 'wl1-softengine');
  const unsupported = new RemoteController({ ...future, supported: false }, async () =>
    assert.fail('unsupported write'),
  );
  t.after(() => unsupported.dispose());
  unsupported.setReady(true);
  assert.throws(() => unsupported.arm());
});

test('motion requires a hold and applies the firmware sign at the send boundary', async (t) => {
  const { controller, timing, frames } = immediateController(t);
  controller.setReady(true);
  controller.arm();
  await flush();
  controller.move(50, 20);
  timing.advance(100);
  await flush();
  assert.equal(frames.at(-1), neutralFrame);
  controller.beginHold();
  controller.move(50, -20);
  timing.advance(100);
  await flush();
  assert.equal(frames.at(-1), 'R -20 -50 0 44.5');
});

test('slow writes serialize and coalesce motion to the newest state', async (t) => {
  const { controller, timing, calls, maximumActive } = delayedController(t);
  controller.setReady(true);
  controller.arm();
  controller.beginHold();
  controller.move(10, 1);
  timing.advance(100);
  controller.move(40, 4);
  timing.advance(100);
  controller.move(70, 7);
  timing.advance(100);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].frame, neutralFrame);
  calls[0].resolve();
  await flush();
  assert.deepEqual(
    calls.map((call) => call.frame),
    [neutralFrame, 'R 7 -70 0 44.5'],
  );
  assert.equal(maximumActive(), 1);
  calls[1].resolve();
  await flush();
  assert.equal(calls.length, 2, 'old states must not remain queued');
});

test('stop replaces queued motion with neutral and waits for that neutral write', async (t) => {
  const { controller, timing, calls } = delayedController(t);
  controller.setReady(true);
  controller.arm();
  calls[0].resolve();
  await flush();
  controller.beginHold();
  controller.move(30, 0);
  timing.advance(100);
  controller.move(80, 30);
  timing.advance(100);
  let stopped = false;
  const stop = controller.stop().then(() => {
    stopped = true;
  });
  controller.move(100, 100);
  controller.pose(78.5, 18);
  assert.equal(controller.snapshot().armed, false);
  assert.equal(calls.length, 2);
  assert.equal(stopped, false);
  calls[1].resolve();
  await flush();
  assert.equal(calls[2].frame, neutralFrame);
  assert.equal(stopped, false);
  calls[2].resolve();
  await stop;
  timing.advance(1000);
  await flush();
  assert.deepEqual(
    calls.map((call) => call.frame),
    [neutralFrame, 'R 0 -30 0 44.5', neutralFrame],
  );
});

test('release immediately clears motion and roll while keeping leg height', async (t) => {
  const { controller, timing, frames } = immediateController(t);
  controller.setReady(true);
  controller.arm();
  await flush();
  controller.pose(68.5, 10);
  await flush();
  controller.beginHold();
  controller.move(50, -20);
  timing.advance(100);
  await flush();
  controller.release();
  await flush();
  assert.equal(frames.at(-1), 'R 0 0 0 68.5');
  assert.deepEqual(controller.snapshot().control, { speed: 0, turn: 0, roll: 0, height: 68.5 });
  controller.move(90, 90);
  timing.advance(100);
  await flush();
  assert.equal(frames.at(-1), 'R 0 0 0 68.5');
});

test('background stop behavior disarms and cannot be resumed by stale touch callbacks', async (t) => {
  const { controller, timing, frames } = immediateController(t);
  controller.setReady(true);
  controller.arm();
  await flush();
  controller.beginHold();
  controller.move(60, 0);
  timing.advance(100);
  await flush();
  await controller.stop();
  const sentAtHide = frames.length;
  controller.beginHold();
  controller.move(100, 100);
  controller.release();
  timing.advance(10000);
  await flush();
  assert.equal(frames.at(-1), neutralFrame);
  assert.equal(frames.length, sentAtHide);
  assert.equal(controller.snapshot().armed, false);
});

test('motion holds keep sending beyond five seconds and accept moves until release', async (t) => {
  const { controller, timing, frames } = immediateController(t);
  controller.setReady(true);
  controller.arm();
  await flush();
  controller.beginHold();
  for (let second = 0; second < 4; second += 1) {
    controller.move(40, 10);
    timing.advance(1000);
    await flush();
  }
  controller.move(70, 20);
  timing.advance(999);
  await flush();
  assert.equal(frames.at(-1), 'R 20 -70 0 44.5');
  timing.advance(1);
  await flush();
  assert.equal(frames.at(-1), 'R 20 -70 0 44.5');
  timing.advance(60000);
  await flush();
  assert.equal(frames.at(-1), 'R 20 -70 0 44.5');
  assert.equal(controller.snapshot().motionHolding, true);
  assert.equal(controller.snapshot().error, '');
  controller.move(100, 100);
  timing.advance(1000);
  await flush();
  assert.equal(frames.at(-1), 'R 100 -100 0 44.5');
  controller.release();
  await flush();
  assert.equal(frames.at(-1), neutralFrame);
  controller.move(80, 80);
  timing.advance(100);
  await flush();
  assert.equal(frames.at(-1), neutralFrame);
  controller.beginHold();
  controller.move(20, 0);
  timing.advance(100);
  await flush();
  assert.equal(frames.at(-1), 'R 0 -20 0 44.5');
});

test('disconnect drops pending motion and a late completion cannot rearm or replay it', async (t) => {
  const { controller, timing, calls } = delayedController(t);
  controller.setReady(true);
  controller.arm();
  controller.beginHold();
  controller.move(80, 40);
  timing.advance(100);
  controller.setReady(false);
  controller.setReady(true);
  calls[0].resolve();
  await flush();
  timing.advance(1000);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(controller.snapshot().armed, false);
  assert.equal(
    controller.snapshot().sentCount,
    0,
    'old connection completion is not current delivery',
  );
  controller.arm();
  assert.equal(calls[1].frame, neutralFrame);
  calls[1].resolve();
  await flush();
});

test('a stale connection failure cannot disarm a newly armed connection', async (t) => {
  const { controller, calls } = delayedController(t);
  controller.setReady(true);
  controller.arm();
  controller.setReady(false);
  controller.setReady(true);
  controller.arm();
  calls[0].reject(new Error('old connection failed'));
  await flush();
  assert.equal(controller.snapshot().armed, true);
  assert.equal(controller.snapshot().error, '');
  assert.equal(calls[1].frame, neutralFrame);
  calls[1].resolve();
  await flush();
});

test('send failure disarms, clears motion, stops future writes and requires readiness reset', async (t) => {
  const { controller, timing, calls } = delayedController(t);
  controller.setReady(true);
  controller.arm();
  controller.beginHold();
  controller.move(70, 20);
  timing.advance(100);
  calls[0].reject(new Error('GATT write failed'));
  await flush();
  assert.equal(controller.snapshot().armed, false);
  assert.equal(controller.snapshot().error, 'GATT write failed');
  assert.deepEqual(controller.snapshot().control, wl1Main.initial);
  timing.advance(10000);
  await flush();
  assert.equal(calls.length, 1);
  assert.throws(() => controller.arm());
  controller.setReady(true);
  controller.arm();
  assert.equal(calls[1].frame, neutralFrame);
  calls[1].resolve();
  await flush();
});

test('stop waits for the new connection neutral even while an old write is completing', async (t) => {
  const { controller, calls } = delayedController(t);
  controller.setReady(true);
  controller.arm();
  controller.setReady(false);
  controller.setReady(true);
  controller.arm();
  let stopped = false;
  const stop = controller.stop().then(() => {
    stopped = true;
  });
  calls[0].resolve();
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].frame, neutralFrame);
  assert.equal(stopped, false, 'disconnect-after-stop must wait for current neutral delivery');
  calls[1].resolve();
  await stop;
});

test('external snapshot mutation cannot inject unheld motion', async (t) => {
  const { controller, timing, frames } = immediateController(t);
  controller.setReady(true);
  controller.arm();
  await flush();
  controller.snapshot().control.speed = 100;
  timing.advance(100);
  await flush();
  assert.equal(frames.at(-1), neutralFrame);
});

test('pose joystick requires its own armed hold and cannot borrow the movement hold', async (t) => {
  const { controller, timing, frames } = immediateController(t);
  controller.beginPoseHold();
  controller.movePose(78.5, 18);
  assert.deepEqual(frames, []);
  assert.equal(controller.snapshot().poseHolding, false);
  controller.setReady(true);
  controller.arm();
  await flush();
  controller.beginHold();
  controller.movePose(78.5, 18);
  timing.advance(100);
  await flush();
  assert.equal(frames.at(-1), neutralFrame);
  controller.beginPoseHold();
  controller.movePose(68.5, -10);
  timing.advance(100);
  await flush();
  assert.equal(frames.at(-1), 'R 0 0 -10 68.5');
  assert.equal(controller.snapshot().motionHolding, true);
  assert.equal(controller.snapshot().poseHolding, true);
});

test('left joystick release stops speed and turn while the right joystick remains live', async (t) => {
  const { controller, timing, frames } = immediateController(t);
  controller.setReady(true);
  controller.arm();
  await flush();
  controller.beginHold();
  controller.beginPoseHold();
  controller.move(40, -20);
  controller.movePose(68.5, 9);
  timing.advance(100);
  await flush();
  assert.equal(frames.at(-1), 'R -20 -40 9 68.5');
  controller.releaseMotion();
  await flush();
  assert.equal(frames.at(-1), 'R 0 0 9 68.5');
  assert.equal(controller.snapshot().motionHolding, false);
  assert.equal(controller.snapshot().poseHolding, true);
  controller.move(80, 80);
  controller.movePose(70.5, -8);
  timing.advance(100);
  await flush();
  assert.equal(frames.at(-1), 'R 0 0 -8 70.5');
});

test('right joystick release levels roll and keeps height without interrupting motion', async (t) => {
  const { controller, timing, frames } = immediateController(t);
  controller.setReady(true);
  controller.arm();
  await flush();
  controller.beginHold();
  controller.beginPoseHold();
  controller.move(40, -20);
  controller.movePose(68.5, 9);
  timing.advance(100);
  await flush();
  controller.releasePose();
  await flush();
  assert.equal(frames.at(-1), 'R -20 -40 0 68.5');
  assert.equal(controller.snapshot().motionHolding, true);
  assert.equal(controller.snapshot().poseHolding, false);
  controller.movePose(78.5, 18);
  controller.move(25, 10);
  timing.advance(100);
  await flush();
  assert.equal(frames.at(-1), 'R 10 -25 0 68.5');
});

test('staggered movement and pose holds both stay active past their old deadlines', async (t) => {
  const { controller, timing, frames } = immediateController(t);
  controller.setReady(true);
  controller.arm();
  await flush();
  controller.beginHold();
  controller.move(50, 20);
  timing.advance(2000);
  await flush();
  controller.beginPoseHold();
  controller.movePose(66.5, 12);
  timing.advance(3000);
  await flush();
  assert.equal(frames.at(-1), 'R 20 -50 12 66.5');
  assert.equal(controller.snapshot().motionHolding, true);
  assert.equal(controller.snapshot().poseHolding, true);
  controller.move(100, 100);
  controller.movePose(67.5, -10);
  timing.advance(100);
  await flush();
  assert.equal(frames.at(-1), 'R 100 -100 -10 67.5');
  timing.advance(1900);
  await flush();
  assert.equal(frames.at(-1), 'R 100 -100 -10 67.5');
  assert.equal(controller.snapshot().poseHolding, true);
  assert.equal(controller.snapshot().error, '');
});

test('pose holds keep their targets indefinitely and accept later moves', async (t) => {
  const { controller, timing, frames } = immediateController(t);
  controller.setReady(true);
  controller.arm();
  await flush();
  controller.beginPoseHold();
  controller.movePose(70.5, -11);
  timing.advance(2000);
  await flush();
  controller.beginHold();
  controller.move(35, -15);
  for (let second = 0; second < 3; second += 1) {
    controller.movePose(70.5, -11);
    timing.advance(1000);
    await flush();
  }
  assert.equal(frames.at(-1), 'R -15 -35 -11 70.5');
  assert.equal(controller.snapshot().motionHolding, true);
  assert.equal(controller.snapshot().poseHolding, true);
  timing.advance(60000);
  await flush();
  assert.equal(frames.at(-1), 'R -15 -35 -11 70.5');
  assert.equal(controller.snapshot().error, '');
  controller.movePose(78.5, 18);
  controller.move(25, 5);
  timing.advance(100);
  await flush();
  assert.equal(frames.at(-1), 'R 5 -25 18 78.5');
  controller.releasePose();
  await flush();
  assert.equal(frames.at(-1), 'R 5 -25 0 78.5');
});

test('global release ends both holds and resets both sticks while retaining height', async (t) => {
  const { controller, timing, frames } = immediateController(t);
  controller.setReady(true);
  controller.arm();
  await flush();
  controller.beginHold();
  controller.beginPoseHold();
  controller.move(30, -10);
  controller.movePose(72.5, 15);
  timing.advance(100);
  await flush();
  controller.release();
  await flush();
  assert.equal(frames.at(-1), 'R 0 0 0 72.5');
  assert.equal(controller.snapshot().motionHolding, false);
  assert.equal(controller.snapshot().poseHolding, false);
  assert.equal(controller.snapshot().armed, true);
  controller.move(80, 80);
  controller.movePose(78.5, 18);
  timing.advance(100);
  await flush();
  assert.equal(frames.at(-1), 'R 0 0 0 72.5');
});

test('global stop clears both holds and supersedes pending changes from both joysticks', async (t) => {
  const { controller, timing, calls } = delayedController(t);
  controller.setReady(true);
  controller.arm();
  calls[0].resolve();
  await flush();
  controller.beginHold();
  controller.beginPoseHold();
  controller.move(30, 10);
  controller.movePose(65.5, 9);
  timing.advance(100);
  controller.move(90, -90);
  controller.movePose(70.5, -18);
  const stopping = controller.stop();
  assert.equal(controller.snapshot().motionHolding, false);
  assert.equal(controller.snapshot().poseHolding, false);
  assert.equal(controller.snapshot().armed, false);
  controller.beginHold();
  controller.beginPoseHold();
  controller.move(100, 100);
  controller.movePose(78.5, 18);
  calls[1].resolve();
  await flush();
  assert.equal(calls[2].frame, 'R 0 0 0 70.5');
  calls[2].resolve();
  await stopping;
  timing.advance(1000);
  await flush();
  assert.equal(calls.length, 3);
});

test('disconnect clears both holds and neither stale stick can resume after reconnect', async (t) => {
  const { controller, timing, frames } = immediateController(t);
  controller.setReady(true);
  controller.arm();
  await flush();
  controller.beginHold();
  controller.beginPoseHold();
  controller.move(30, 15);
  controller.movePose(68.5, 10);
  timing.advance(100);
  await flush();
  controller.setReady(false);
  assert.equal(controller.snapshot().motionHolding, false);
  assert.equal(controller.snapshot().poseHolding, false);
  controller.setReady(true);
  controller.arm();
  await flush();
  controller.move(90, 90);
  controller.movePose(78.5, 18);
  timing.advance(100);
  await flush();
  assert.equal(frames.at(-1), 'R 0 0 0 68.5');
  assert.equal(controller.snapshot().motionHolding, false);
  assert.equal(controller.snapshot().poseHolding, false);
});

test('send failure publishes both holds as inactive before any stale gesture can continue', async (t) => {
  const { controller, timing, calls } = delayedController(t);
  controller.setReady(true);
  controller.arm();
  controller.beginHold();
  controller.beginPoseHold();
  controller.move(30, 15);
  controller.movePose(68.5, 10);
  timing.advance(100);
  calls[0].reject(new Error('link lost'));
  await flush();
  assert.equal(controller.snapshot().motionHolding, false);
  assert.equal(controller.snapshot().poseHolding, false);
  assert.equal(controller.snapshot().armed, false);
  controller.move(90, 90);
  controller.movePose(78.5, 18);
  timing.advance(1000);
  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(controller.snapshot().control, { speed: 0, turn: 0, roll: 0, height: 68.5 });
});
