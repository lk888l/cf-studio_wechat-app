export type ParameterCommand = 'params' | 'save' | 'control off' | 'control on';
type Operation = '' | 'params' | 'save' | 'off' | 'on';

export interface ParameterStatus {
  armed: boolean;
  unsaved: boolean;
  enabled: boolean | null;
  flashValid: boolean | null;
}

export interface ParameterSnapshot {
  busy: Operation;
  status: ParameterStatus | null;
  message: string;
  success: boolean;
}

export const PARAMETER_TIMEOUT_MS = 5000;
const MAX_LINE_LENGTH = 2048;

export function encodeParameterCommand(command: ParameterCommand): string {
  if (!['params', 'save', 'control off', 'control on'].includes(command))
    throw new Error('不支持的参数保存命令');
  // These commands deliberately bypass the @ prefix used for motion/tuning.
  return `${command}\n`;
}

export function parseParameterStatus(line: string): ParameterStatus | null {
  if (!line.startsWith('params:')) return null;
  const field = (name: string): boolean | null => {
    const match = line.match(new RegExp(`(?:^|\\s)${name}=(true|false|1|0)(?=\\s|$)`));
    return match ? match[1] === 'true' || match[1] === '1' : null;
  };
  const armed = field('armed');
  const unsaved = field('unsaved');
  if (armed === null || unsaved === null) return null;
  return { armed, unsaved, enabled: field('enabled'), flashValid: field('flash_valid') };
}

export function parseSaveResult(line: string): { success: boolean; message: string } | null {
  const match = line.match(/^save: (ok|unchanged|busy|full|invalid|flash error)(?=$|[\s;(])/);
  if (!match) return null;
  const messages: Record<string, string> = {
    ok: '保存成功',
    unchanged: '参数未变化，已经保存',
    busy: line.includes('system is starting')
      ? '小车正在启动，请稍后重试保存'
      : '小车暂时忙，请稍后重试保存',
    full: '参数存储区已满，请通过高级维护回收存储区后重试',
    invalid: '参数无效',
    'flash error': '保存失败，当前 RAM 参数仍保留',
  };
  return { success: match[1] === 'ok' || match[1] === 'unchanged', message: messages[match[1]] };
}

interface ReplyWaiter {
  receive(line: string): void;
  cancel(message: string): void;
}

/** One transaction at a time; only complete, current-session UART lines can confirm it. */
export class ParameterService {
  private state: ParameterSnapshot = { busy: '', status: null, message: '', success: false };
  private line = '';
  private discardLine = false;
  private epoch = 0;
  private waiter: ReplyWaiter | null = null;

  constructor(
    private readonly write: (frame: string, onStart: () => void) => Promise<void>,
    private readonly changed: (state: ParameterSnapshot) => void,
  ) {}

  snapshot(): ParameterSnapshot {
    return { ...this.state, status: this.state.status ? { ...this.state.status } : null };
  }

  private patch(update: Partial<ParameterSnapshot>): void {
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
    this.waiter?.cancel(message || '连接或操作已切换');
    this.line = '';
    this.discardLine = false;
    this.patch({ busy: '', status: null, message, success: false });
  }

  markParametersChanged(): void {
    // GATT completion does not tell us whether firmware applied a tuning/pose change.
    this.patch({ status: null, success: false, message: '参数指令已发送，请查询车端保存状态' });
  }

  query(): Promise<void> {
    return this.run('params', async (epoch) => {
      const status = await this.readStatus(epoch);
      this.checkEpoch(epoch);
      this.patch({ message: status.unsaved ? '存在未保存修改' : '当前参数无未保存修改' });
    });
  }

  save(): Promise<void> {
    return this.run('save', async (epoch) => {
      // Runtime saves keep balance and motion active; only recycle requires stopping.
      this.patch({ status: null, message: '等待保存结果…' });
      const result = await this.request('save', parseSaveResult, '未收到保存结果');
      this.checkEpoch(epoch);
      this.patch(result);
    });
  }

  control(enabled: boolean): Promise<void> {
    return this.run(enabled ? 'on' : 'off', async (epoch) => {
      this.patch({ status: null, message: enabled ? '等待恢复控制回执…' : '等待关闭控制回执…' });
      const reply = await this.request(
        enabled ? 'control on' : 'control off',
        (line) => (line.startsWith('control:') ? line : null),
        '未收到控制结果，请查询车端状态',
      );
      this.checkEpoch(epoch);
      if (enabled && !/^control: on(?=$|[\s;])/.test(reply))
        throw new Error('恢复控制失败，请检查车端状态');
      if (enabled && /^control: on rejected\b/.test(reply))
        throw new Error('车端拒绝恢复控制：系统尚未就绪');
      if (!enabled && !/^control: off(?=$|[\s;])/.test(reply))
        throw new Error('关闭控制未获确认，请查询车端状态');
      const status = await this.readStatus(epoch);
      this.checkEpoch(epoch);
      this.patch({
        message: enabled
          ? '已请求恢复正常稳定启动流程；启用本地控制后可操作摇杆'
          : status.armed || status.enabled === true
            ? '车端控制尚未关闭，请稍后查询状态'
            : '已确认车端控制关闭',
      });
    });
  }

  private async readStatus(epoch: number): Promise<ParameterStatus> {
    this.patch({ status: null });
    const status = await this.request('params', parseParameterStatus, '未收到参数状态，请重试查询');
    this.checkEpoch(epoch);
    this.patch({ status });
    return status;
  }

  private checkEpoch(epoch: number): void {
    if (epoch !== this.epoch) throw new Error('操作已取消');
  }

  private async run(operation: Operation, action: (epoch: number) => Promise<void>): Promise<void> {
    if (this.state.busy) return;
    const epoch = this.epoch;
    this.patch({ busy: operation, success: false, message: '等待车端回执…' });
    try {
      await action(epoch);
    } catch (error) {
      if (epoch === this.epoch)
        this.patch({
          status: null,
          success: false,
          message: error instanceof Error ? error.message : '操作失败',
        });
    } finally {
      if (epoch === this.epoch) this.patch({ busy: '' });
    }
  }

  private request<T>(
    command: ParameterCommand,
    parse: (line: string) => T | null,
    timeoutMessage: string,
  ): Promise<T> {
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
          const result = parse(line);
          if (result !== null && finish()) resolve(result);
        },
        cancel: (message) => {
          if (finish()) reject(new Error(message));
        },
      };
      const timer = setTimeout(() => waiter.cancel(timeoutMessage), PARAMETER_TIMEOUT_MS);
      this.waiter = waiter;
      void this.write(encodeParameterCommand(command), () => {
        if (settled) throw new Error('参数操作已取消');
        // Do not accept a reply whose prefix arrived before this actual BLE write.
        if (this.line.length) {
          this.line = '';
          this.discardLine = true;
        }
        started = true;
      }).catch((error: unknown) => {
        waiter.cancel(
          command === 'save'
            ? '未收到保存结果：蓝牙发送失败，请重新连接并查询参数状态'
            : error instanceof Error
              ? error.message
              : '蓝牙发送失败',
        );
      });
    });
  }
}
