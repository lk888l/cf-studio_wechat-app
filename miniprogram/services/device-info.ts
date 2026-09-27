export type DeviceInfoCommand = 'uid' | 'anglebias' | 'rollbias';

export interface AngleBiasStatus {
  /** Minimum leg-height pitch midpoint stored by the car. */
  base: number;
  /** Pitch compensation at the car's current target leg height. */
  effective: number;
}

export interface RollBiasStatus {
  /** Roll midpoint stored by the car. */
  base: number;
  raw: number;
  effective: number;
}

export interface DeviceInfoSnapshot {
  busy: '' | DeviceInfoCommand;
  uid: string;
  angleBias: AngleBiasStatus | null;
  rollBias: RollBiasStatus | null;
  message: string;
}

export const DEVICE_INFO_TIMEOUT_MS = 5000;
const MAX_LINE_LENGTH = 256;
const decimal = '([+-]?\\d+(?:\\.\\d+)?)';
const angleBiasPattern = new RegExp(`^anglebias base=${decimal} effective=${decimal}$`);
const rollBiasPattern = new RegExp(
  `^rollbias base=${decimal} raw=${decimal} effective=${decimal}$`,
);

export function encodeDeviceInfoCommand(command: DeviceInfoCommand): string {
  if (!['uid', 'anglebias', 'rollbias'].includes(command)) throw new Error('不支持的设备信息命令');
  return `${command}\n`;
}

export function parseUniqueId(line: string): string | null {
  const match = line.match(/^uid: ([0-9A-Fa-f]{24})$/);
  return match ? match[1].toUpperCase() : null;
}

export function parseAngleBiasStatus(line: string): AngleBiasStatus | null {
  const match = line.match(angleBiasPattern);
  if (!match) return null;
  const base = Number(match[1]);
  const effective = Number(match[2]);
  return Number.isFinite(base) && Number.isFinite(effective) ? { base, effective } : null;
}

export function parseRollBiasStatus(line: string): RollBiasStatus | null {
  const match = line.match(rollBiasPattern);
  if (!match) return null;
  const base = Number(match[1]);
  const raw = Number(match[2]);
  const effective = Number(match[3]);
  return [base, raw, effective].every(Number.isFinite) ? { base, raw, effective } : null;
}

interface ReplyWaiter {
  receive(line: string): void;
  cancel(message: string): void;
}

/** The three readouts share one line parser and are requested in order. */
export class DeviceInfoService {
  private state: DeviceInfoSnapshot = {
    busy: '',
    uid: '',
    angleBias: null,
    rollBias: null,
    message: '',
  };
  private line = '';
  private discardLine = false;
  private epoch = 0;
  private waiter: ReplyWaiter | null = null;

  constructor(
    private readonly write: (frame: string, onStart: () => void) => Promise<void>,
    private readonly changed: (state: DeviceInfoSnapshot) => void,
  ) {}

  snapshot(): DeviceInfoSnapshot {
    return {
      ...this.state,
      angleBias: this.state.angleBias ? { ...this.state.angleBias } : null,
      rollBias: this.state.rollBias ? { ...this.state.rollBias } : null,
    };
  }

  private patch(update: Partial<DeviceInfoSnapshot>): void {
    this.state = { ...this.state, ...update };
    this.changed(this.snapshot());
  }

  receive(chunk: string): void {
    for (const character of chunk) {
      if (character === '\n') {
        const line = this.line.replace(/\r$/, '');
        const discarded = this.discardLine;
        this.line = '';
        this.discardLine = false;
        if (!discarded) this.waiter?.receive(line);
      } else if (!this.discardLine) {
        this.line += character;
        if (this.line.length > MAX_LINE_LENGTH) {
          this.line = '';
          this.discardLine = true;
        }
      }
    }
  }

  reset(message = ''): void {
    ++this.epoch;
    this.waiter?.cancel('蓝牙连接已切换，读取已取消');
    this.line = '';
    this.discardLine = false;
    this.patch({ busy: '', uid: '', angleBias: null, rollBias: null, message });
  }

  markCalibrationStale(command: 'anglebias' | 'rollbias'): void {
    this.patch({
      ...(command === 'anglebias' ? { angleBias: null } : { rollBias: null }),
      message: '中点指令已发送；重新读取可确认车端当前值',
    });
  }

  async readAll(): Promise<void> {
    if (this.state.busy) return;
    const epoch = this.epoch;
    const failures: string[] = [];
    this.patch({ uid: '', angleBias: null, rollBias: null });
    for (const command of ['uid', 'anglebias', 'rollbias'] as const) {
      if (epoch !== this.epoch) return;
      this.patch({ busy: command, message: `正在读取${this.label(command)}…` });
      try {
        if (command === 'uid') {
          const uid = await this.request(command, parseUniqueId);
          if (epoch !== this.epoch) return;
          this.patch({ uid });
        } else if (command === 'anglebias') {
          const angleBias = await this.request(command, parseAngleBiasStatus);
          if (epoch !== this.epoch) return;
          this.patch({ angleBias });
        } else {
          const rollBias = await this.request(command, parseRollBiasStatus);
          if (epoch !== this.epoch) return;
          this.patch({ rollBias });
        }
      } catch (error) {
        if (epoch !== this.epoch) return;
        failures.push(
          `${this.label(command)}${error instanceof Error ? error.message : '读取失败'}`,
        );
      }
    }
    if (epoch === this.epoch)
      this.patch({
        busy: '',
        message: failures.length
          ? `部分信息未读取：${failures.join('；')}`
          : '已读取本车序列号和两个中心角度',
      });
  }

  private label(command: DeviceInfoCommand): string {
    return command === 'uid' ? '序列号' : command === 'anglebias' ? '俯仰中点' : '横滚中点';
  }

  private request<T>(command: DeviceInfoCommand, parse: (line: string) => T | null): Promise<T> {
    return new Promise((resolve, reject) => {
      let started = false;
      let settled = false;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        if (this.waiter === waiter) this.waiter = null;
        return true;
      };
      const waiter: ReplyWaiter = {
        receive: (line) => {
          if (!started) return;
          if (line === `receive: ${command}`) {
            if (finish()) reject(new Error('：固件不支持该命令'));
            return;
          }
          const result = parse(line);
          if (result !== null && finish()) resolve(result);
        },
        cancel: (message) => {
          if (finish()) reject(new Error(message));
        },
      };
      const timer = setTimeout(() => waiter.cancel('：等待回执超时'), DEVICE_INFO_TIMEOUT_MS);
      this.waiter = waiter;
      void this.write(encodeDeviceInfoCommand(command), () => {
        if (settled) throw new Error('设备信息读取已取消');
        if (this.line.length) {
          this.line = '';
          this.discardLine = true;
        }
        started = true;
      }).catch((error: unknown) => {
        waiter.cancel(`：${error instanceof Error ? error.message : '蓝牙发送失败'}`);
      });
    });
  }
}
