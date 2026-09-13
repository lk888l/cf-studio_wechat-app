import { ControlState, DeviceProfile, neutral } from '../devices/profiles';

export interface ControllerSnapshot {
  armed: boolean;
  motionHolding: boolean;
  poseHolding: boolean;
  control: ControlState;
  lastFrame: string;
  sentCount: number;
  error: string;
}

export interface ControllerClock {
  now(): number;
  setInterval(callback: () => void, ms: number): number;
  clearInterval(timer: number): void;
}

const clock: ControllerClock = {
  now: () => Date.now(),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (timer) => clearInterval(timer),
};

/** One in-flight write and one replaceable latest state, never a FIFO of motion. */
export class RemoteController {
  private state: ControllerSnapshot;
  private listeners = new Set<(state: ControllerSnapshot) => void>();
  private timer: number | undefined;
  private pending = false;
  private drainPromise: Promise<void> | null = null;
  private ready = false;
  private generation = 0;
  private holdDeadline = 0;
  private poseHoldDeadline = 0;
  private stopping = false;

  constructor(
    private profile: DeviceProfile,
    private readonly write: (frame: string) => Promise<void>,
    private readonly onSent: (frame: string) => void = () => undefined,
    private readonly timing: ControllerClock = clock,
  ) {
    this.state = {
      armed: false,
      motionHolding: false,
      poseHolding: false,
      control: { ...profile.initial },
      lastFrame: '',
      sentCount: 0,
      error: '',
    };
  }

  snapshot(): ControllerSnapshot {
    return { ...this.state, control: { ...this.state.control } };
  }

  subscribe(listener: (state: ControllerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener(this.snapshot()));
  }

  setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    this.generation += 1;
    this.pending = false;
    this.clearTimer();
    this.holdDeadline = 0;
    this.poseHoldDeadline = 0;
    this.state = {
      ...this.state,
      armed: false,
      motionHolding: false,
      poseHolding: false,
      control: neutral(this.state.control),
      error: '',
    };
    this.emit();
  }

  setProfile(profile: DeviceProfile): void {
    if (this.state.armed || this.drainPromise || this.stopping)
      throw new Error('请等待停止指令发送完成后切换固件');
    this.setReady(false);
    this.profile = profile;
    this.state.control = profile.normalize(neutral(this.state.control));
    this.state.lastFrame = '';
    this.emit();
  }

  arm(): void {
    if (this.stopping) throw new Error('正在发送归零指令，请稍后启用控制');
    if (!this.ready || !this.profile.supported) throw new Error('请先连接并确认串口通道');
    if (this.state.armed) return;
    this.state = {
      ...this.state,
      armed: true,
      motionHolding: false,
      poseHolding: false,
      control: neutral(this.state.control),
      error: '',
    };
    this.holdDeadline = 0;
    this.poseHoldDeadline = 0;
    this.emit();
    this.requestSend();
    this.timer = this.timing.setInterval(() => {
      // A lost touchend must not renew a motion command indefinitely.
      if (this.holdDeadline && this.timing.now() >= this.holdDeadline) {
        this.holdDeadline = 0;
        this.state.motionHolding = false;
        this.state.control = { ...this.state.control, speed: 0, turn: 0 };
        this.state.error = '速度摇杆连续操作已达 5 秒，请松手后重新操作';
        this.emit();
      }
      if (this.poseHoldDeadline && this.timing.now() >= this.poseHoldDeadline) {
        this.poseHoldDeadline = 0;
        this.state.poseHolding = false;
        this.state.control = { ...this.state.control, roll: 0 };
        this.state.error = '腿部摇杆连续操作已达 5 秒，请松手后重新操作';
        this.emit();
      }
      this.requestSend();
    }, this.profile.intervalMs);
  }

  beginHold(): void {
    if (!this.state.armed) return;
    this.holdDeadline = this.timing.now() + 5000;
    this.state.motionHolding = true;
    this.state.error = '';
    this.emit();
  }

  move(speed: number, turn: number): void {
    if (!this.state.armed || !this.holdDeadline || this.timing.now() >= this.holdDeadline) return;
    this.state.control = this.profile.normalize({ ...this.state.control, speed, turn });
    this.emit();
  }

  release(): void {
    this.holdDeadline = 0;
    this.poseHoldDeadline = 0;
    this.state.motionHolding = false;
    this.state.poseHolding = false;
    this.state.control = neutral(this.state.control);
    this.emit();
    if (this.state.armed) this.requestSend();
  }

  releaseMotion(): void {
    this.holdDeadline = 0;
    this.state.motionHolding = false;
    this.state.control = { ...this.state.control, speed: 0, turn: 0 };
    this.emit();
    if (this.state.armed) this.requestSend();
  }

  beginPoseHold(): void {
    if (!this.state.armed) return;
    this.poseHoldDeadline = this.timing.now() + 5000;
    this.state.poseHolding = true;
    this.state.error = '';
    this.emit();
  }

  movePose(height: number, roll: number): void {
    if (!this.state.armed || !this.poseHoldDeadline || this.timing.now() >= this.poseHoldDeadline)
      return;
    this.state.control = this.profile.normalize({ ...this.state.control, height, roll });
    this.emit();
    // Both sticks are coalesced into the same scheduled R frame.
  }

  releasePose(): void {
    this.poseHoldDeadline = 0;
    this.state.poseHolding = false;
    this.state.control = { ...this.state.control, roll: 0 };
    this.emit();
    if (this.state.armed) this.requestSend();
  }

  pose(height: number, roll: number): void {
    if (!this.state.armed) return;
    this.state.control = this.profile.normalize({ ...this.state.control, height, roll });
    this.emit();
    this.requestSend();
  }

  /** Best effort neutral write, not a hardware emergency stop or execution ACK. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimer();
    this.holdDeadline = 0;
    this.poseHoldDeadline = 0;
    this.state.armed = false;
    this.state.motionHolding = false;
    this.state.poseHolding = false;
    this.state.control = neutral(this.state.control);
    this.emit();
    try {
      if (this.ready) this.requestSend();
      // A stale session's finally may start a new drain. Await that neutral too.
      while (this.drainPromise) await this.drainPromise;
    } finally {
      this.stopping = false;
    }
  }

  private requestSend(): void {
    if (!this.ready) return;
    this.pending = true;
    if (this.drainPromise) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
      if (this.pending && this.ready) this.requestSend();
    });
  }

  private async drain(): Promise<void> {
    const generation = this.generation;
    while (this.pending && this.ready && generation === this.generation) {
      this.pending = false;
      const frame = this.profile.encode(this.state.control);
      try {
        await this.write(frame);
        if (generation !== this.generation) return;
        this.state.lastFrame = frame;
        this.state.sentCount += 1;
        this.onSent(frame);
        this.emit();
      } catch (error) {
        if (generation !== this.generation) return;
        this.ready = false;
        this.pending = false;
        this.clearTimer();
        this.state.armed = false;
        this.holdDeadline = 0;
        this.poseHoldDeadline = 0;
        this.state.motionHolding = false;
        this.state.poseHolding = false;
        this.state.control = neutral(this.state.control);
        this.state.error = error instanceof Error ? error.message : '发送失败，请重新连接';
        this.emit();
      }
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.timing.clearInterval(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.setReady(false);
    this.clearTimer();
    this.listeners.clear();
  }
}
