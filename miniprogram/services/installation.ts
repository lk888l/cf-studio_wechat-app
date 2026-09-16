export type InstallationCommand = 'install on' | 'install off' | 'install status';
export interface InstallationStatus {
  active: boolean;
  ready: boolean;
  control: boolean;
}
export interface InstallationSnapshot {
  busy: string;
  status: InstallationStatus | null;
  message: string;
  success: boolean;
}
export const INSTALLATION_TIMEOUT_MS = 5000;
export function encodeInstallationCommand(command: InstallationCommand): string {
  if (!['install on', 'install off', 'install status'].includes(command))
    throw new Error('不支持的安装命令');
  return `${command}\n`;
}
export function parseInstallationStatus(line: string): InstallationStatus | null {
  const match = line.match(/^install: active=([01]) ready=([01]) height=44\.5 control=(on|off)$/);
  if (!match) return null;
  const status = { active: match[1] === '1', ready: match[2] === '1', control: match[3] === 'on' };
  if ((status.active && status.control) || (!status.active && status.ready)) return null;
  return status;
}
interface ReplyWaiter {
  receive(line: string): void;
  cancel(message: string): void;
}

/** Only a complete UART reply from the current BLE session confirms installation. */
export class InstallationService {
  private state: InstallationSnapshot = { busy: '', status: null, message: '', success: false };
  private line = '';
  private discardLine = false;
  private epoch = 0;
  private waiter: ReplyWaiter | null = null;
  constructor(
    private readonly write: (frame: string, onStart: () => void) => Promise<void>,
    private readonly changed: (state: InstallationSnapshot) => void,
  ) {}
  snapshot(): InstallationSnapshot {
    return { ...this.state, status: this.state.status ? { ...this.state.status } : null };
  }
  private patch(update: Partial<InstallationSnapshot>): void {
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
        if (this.line.length > 256) {
          this.line = '';
          this.discardLine = true;
        }
      }
    }
  }
  reset(): void {
    ++this.epoch;
    this.waiter?.cancel('连接已切换，请重新查询安装状态');
    this.line = '';
    this.discardLine = false;
    this.patch({
      busy: '',
      status: null,
      success: false,
      message: '状态待查询；断开连接不会退出车端安装模式',
    });
  }
  query(): Promise<void> {
    return this.run('install status');
  }
  set(enabled: boolean): Promise<void> {
    return this.run(enabled ? 'install on' : 'install off');
  }
  private async read(command: InstallationCommand): Promise<InstallationStatus> {
    const result = await this.request(
      command,
      (line) => {
        if (/^install: (rejected|usage:)/.test(line))
          return { error: '车端拒绝安装操作，请检查启动状态' };
        const status = parseInstallationStatus(line);
        return status ? { status } : null;
      },
      '未收到安装回执，请确认固件支持安装模式并重新查询',
    );
    if ('error' in result) throw new Error(result.error);
    return result.status;
  }
  private async run(command: InstallationCommand): Promise<void> {
    if (this.state.busy) return;
    const epoch = this.epoch;
    this.patch({ busy: command, status: null, message: '等待车端确认…', success: false });
    try {
      let status = await this.read(command);
      if (epoch !== this.epoch) return;
      if (command === 'install on' && !status.active) throw new Error('车端尚未进入安装模式');
      if (command === 'install off' && (status.active || status.control))
        throw new Error('退出安装尚未确认');
      // A second round trip lets the servo task finish moving; ready is a PWM target acknowledgement.
      if (command === 'install on' && !status.ready) {
        status = await this.read('install status');
        if (epoch !== this.epoch) return;
        if (!status.active) throw new Error('安装锁定已解除，请重新查询');
      }
      this.patch({
        status,
        success: true,
        message: status.active
          ? status.ready
            ? '最低腿高已锁定，可以安装舵盘和连杆'
            : '正在移动到安装位置，请刷新状态后开始安装'
          : '安装模式已退出；需要运行时，请手动恢复车端控制',
      });
    } catch (error) {
      if (epoch === this.epoch)
        this.patch({
          status: null,
          success: false,
          message: error instanceof Error ? error.message : '安装操作失败',
        });
    } finally {
      if (epoch === this.epoch) this.patch({ busy: '' });
    }
  }
  private request<T>(
    command: InstallationCommand,
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
      const timer = setTimeout(() => waiter.cancel(timeoutMessage), INSTALLATION_TIMEOUT_MS);
      this.waiter = waiter;
      void this.write(encodeInstallationCommand(command), () => {
        if (settled) throw new Error('安装操作已取消');
        // Do not accept a reply whose prefix arrived before this actual BLE write.
        if (this.line.length) {
          this.line = '';
          this.discardLine = true;
        }
        started = true;
      }).catch((error: unknown) => {
        waiter.cancel(
          command === 'install on'
            ? '安装状态未确认：蓝牙发送失败，请重新连接并查询状态'
            : error instanceof Error
              ? error.message
              : '蓝牙发送失败',
        );
      });
    });
  }
}
