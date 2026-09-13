import { ControlState, DeviceProfile, neutral } from '../devices/profiles';
import { encodeAutoAngleKp, encodeTuning } from '../devices/tuning';

interface TuningWrite {
  frame: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

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
  private stopping = false;
  private urgentMotion = false;
  private tuning: TuningWrite | null = null;
  private tuningActive = false;

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
    this.cancelTuning();
    this.pending = false;
    this.clearTimer();
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
    this.emit();
    this.requestSend();
    this.timer = this.timing.setInterval(() => {
      this.requestSend();
    }, this.profile.intervalMs);
  }

  beginHold(): void {
    if (!this.state.armed) return;
    this.state.motionHolding = true;
    this.state.error = '';
    this.emit();
  }

  move(speed: number, turn: number): void {
    if (!this.state.armed || !this.state.motionHolding) return;
    this.state.control = this.profile.normalize({ ...this.state.control, speed, turn });
    this.emit();
  }

  release(): void {
    this.state.motionHolding = false;
    this.state.poseHolding = false;
    this.state.control = neutral(this.state.control);
    this.emit();
    if (this.state.armed) this.requestSend(true);
  }

  releaseMotion(): void {
    this.state.motionHolding = false;
    this.state.control = { ...this.state.control, speed: 0, turn: 0 };
    this.emit();
    if (this.state.armed) this.requestSend(true);
  }

  beginPoseHold(): void {
    if (!this.state.armed) return;
    this.state.poseHolding = true;
    this.state.error = '';
    this.emit();
  }

  movePose(height: number, roll: number): void {
    if (!this.state.armed || !this.state.poseHolding) return;
    this.state.control = this.profile.normalize({ ...this.state.control, height, roll });
    this.emit();
    // Both sticks are coalesced into the same scheduled R frame.
  }

  releasePose(): void {
    this.state.poseHolding = false;
    this.state.control = { ...this.state.control, roll: 0 };
    this.emit();
    if (this.state.armed) this.requestSend(true);
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
    this.cancelTuning();
    this.clearTimer();
    this.state.armed = false;
    this.state.motionHolding = false;
    this.state.poseHolding = false;
    this.state.control = neutral(this.state.control);
    this.emit();
    try {
      if (this.ready) this.requestSend(true);
      // A stale session's finally may start a new drain. Await that neutral too.
      while (this.drainPromise) await this.drainPromise;
    } finally {
      this.stopping = false;
    }
  }

  sendTuning(id: string, value: string): Promise<void> {
    return this.enqueueTuning(encodeTuning(this.profile.id, id, value));
  }

  restoreAutoAngleKp(): Promise<void> {
    return this.enqueueTuning(encodeAutoAngleKp(this.profile.id));
  }

  private async enqueueTuning(frame: string): Promise<void> {
    if (!this.ready || !this.profile.supported) throw new Error('请先连接并确认串口通道');
    if (this.stopping) throw new Error('正在停止运动，请稍后调参');
    if (this.tuning || this.tuningActive) throw new Error('请等待当前参数发送完成');
    return new Promise<void>((resolve, reject) => {
      this.tuning = { frame, resolve, reject };
      this.ensureDrain();
    });
  }

  private cancelTuning(): void {
    this.tuning?.reject(new Error('调参已取消：运动停止或连接已切换'));
    this.tuning = null;
  }

  private requestSend(urgent = false): void {
    if (!this.ready) return;
    this.pending = true;
    this.urgentMotion = this.urgentMotion || urgent;
    this.ensureDrain();
  }

  private ensureDrain(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
      if ((this.pending || this.tuning) && this.ready) this.ensureDrain();
    });
  }

  private async drain(): Promise<void> {
    const generation = this.generation;
    while ((this.pending || this.tuning) && this.ready && generation === this.generation) {
      const tuning = this.pending && this.urgentMotion ? null : this.tuning;
      if (tuning) {
        this.tuning = null;
        this.tuningActive = true;
      } else {
        this.pending = false;
        this.urgentMotion = false;
      }
      const frame = tuning ? tuning.frame : this.profile.encode(this.state.control);
      try {
        await this.write(frame);
        if (generation !== this.generation) {
          tuning?.reject(new Error('连接已切换，无法确认参数发送结果'));
          return;
        }
        this.state.lastFrame = frame;
        this.state.sentCount += 1;
        this.onSent(frame);
        this.emit();
        tuning?.resolve();
      } catch (error) {
        tuning?.reject(error instanceof Error ? error : new Error('参数发送失败'));
        if (generation !== this.generation) return;
        this.cancelTuning();
        this.ready = false;
        this.pending = false;
        this.clearTimer();
        this.state.armed = false;
        this.state.motionHolding = false;
        this.state.poseHolding = false;
        this.state.control = neutral(this.state.control);
        this.state.error = error instanceof Error ? error.message : '发送失败，请重新连接';
        this.emit();
      } finally {
        if (tuning) this.tuningActive = false;
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
