/** WeChat exposes BLE GATT, not the classic Bluetooth SPP used by ordinary HC-05 modules. */
export interface BleEndpoint {
  serviceId: string;
  writeId: string;
  notifyId?: string;
  writeType: 'write' | 'writeNoResponse';
  label: string;
}

export interface BleState {
  status: 'idle' | 'scanning' | 'connecting' | 'selecting' | 'ready' | 'error';
  devices: Array<{ deviceId: string; name: string; rssi: number }>;
  deviceId: string;
  deviceName: string;
  endpoints: BleEndpoint[];
  endpoint: BleEndpoint | null;
  error: string;
}

type Callbacks<T> = { success: (value: T) => void; fail: (reason: unknown) => void };
type ModernProperties = WechatMiniprogram.BLECharacteristicProperties & {
  writeNoResponse?: boolean;
};
type ModernWrite = WechatMiniprogram.WriteBLECharacteristicValueOption & {
  writeType: BleEndpoint['writeType'];
};

const SCAN_MS = 15000;
const API_TIMEOUT_MS = 6000;
const CONNECT_TIMEOUT_MS = 10000;
const WRITE_TIMEOUT_MS = 2000;
const FRAME_GAP_MS = 25;
// An old steering command must never be replayed after congestion clears.
const MAX_QUEUE_AGE_MS = 350;
const normalizeUuid = (uuid: string): string => {
  const upper = uuid.toUpperCase();
  return /^[0-9A-F]{4}$/.test(upper) ? `0000${upper}-0000-1000-8000-00805F9B34FB` : upper;
};
const sameUuid = (first: string, second: string): boolean =>
  normalizeUuid(first) === normalizeUuid(second);

function errorMessage(reason: unknown, action: string): string {
  if (reason instanceof Error) return reason.message;
  const code =
    typeof reason === 'object' && reason !== null && 'errCode' in reason
      ? Number((reason as { errCode: unknown }).errCode)
      : 0;
  const messages: Record<number, string> = {
    10000: '蓝牙尚未初始化，请重新扫描',
    10001: '蓝牙不可用，请开启手机蓝牙并检查微信蓝牙权限',
    10002: '未找到设备，请确认设备已开机并支持 BLE',
    10003: '连接失败，请靠近设备并确认未被其他手机占用',
    10004: '找不到蓝牙服务，请重新连接',
    10005: '找不到蓝牙特征，请重新连接',
    10006: '蓝牙连接已断开，请重新连接',
    10007: '所选蓝牙特征不支持此操作，请核对串口服务',
    10008: '蓝牙系统异常，请关闭蓝牙后重新开启',
    10009: '当前系统不支持微信低功耗蓝牙功能',
    10012: '蓝牙操作超时，请靠近设备后重新连接',
    10013: '蓝牙参数无效，请重新扫描并选择串口服务',
  };
  return (
    messages[code] ||
    `${action}失败，请检查蓝牙权限、设备状态和 BLE 串口配置${code ? `（${code}）` : ''}`
  );
}

function snapshot(state: BleState): BleState {
  return {
    ...state,
    devices: state.devices.map((device) => ({ ...device })),
    endpoints: state.endpoints.map((endpoint) => ({ ...endpoint })),
    endpoint: state.endpoint ? { ...state.endpoint } : null,
  };
}

/** A session-scoped BLE transport. A successful send means GATT accepted the write only. */
export class BleTransport {
  private state: BleState = {
    status: 'idle',
    devices: [],
    deviceId: '',
    deviceName: '',
    endpoints: [],
    endpoint: null,
    error: '',
  };
  private readonly listeners = new Set<(state: BleState) => void>();
  private readonly receivers = new Set<(text: string) => void>();
  private readonly pending = new Set<() => void>();
  private session = 0;
  private scanGeneration = 0;
  private scanTimer: number | undefined;
  private disposed = false;
  private adapterOpened = false;
  private discoveryStarted = false;
  private discoveryTail: Promise<void> = Promise.resolve();
  private closeTail: Promise<void> = Promise.resolve();
  private writeTail: Promise<void> = Promise.resolve();
  private lastWriteFinished = 0;
  private selecting = false;
  private connectionPending = false;

  constructor() {
    wx.onBluetoothDeviceFound(this.handleDevices);
    wx.onBluetoothAdapterStateChange(this.handleAdapter);
    wx.onBLEConnectionStateChange(this.handleConnection);
    wx.onBLECharacteristicValueChange(this.handleValue);
  }

  subscribe(listener: (state: BleState) => void): () => void {
    this.assertAlive();
    this.listeners.add(listener);
    listener(snapshot(this.state));
    return () => {
      this.listeners.delete(listener);
    };
  }

  onReceive(listener: (text: string) => void): () => void {
    this.assertAlive();
    this.receivers.add(listener);
    return () => {
      this.receivers.delete(listener);
    };
  }

  async scan(): Promise<void> {
    this.assertAlive();
    if (this.state.deviceId) throw new Error('请先断开当前设备，再扫描其他 BLE 设备');
    await this.stopScan();
    this.assertAlive();
    const session = this.session;
    const generation = ++this.scanGeneration;
    this.patch({ status: 'scanning', devices: [], error: '' });
    try {
      await this.openAdapter(session);
      this.checkScan(session, generation);
      await this.discoveryOperation(async () => {
        this.checkScan(session, generation);
        await this.call<WechatMiniprogram.GeneralCallbackResult>(
          '搜索 BLE 设备',
          (callbacks) => {
            wx.startBluetoothDevicesDiscovery({
              allowDuplicatesKey: true,
              interval: 0,
              ...callbacks,
            });
          },
          API_TIMEOUT_MS,
          session,
          () => {
            if (this.disposed || this.state.status !== 'scanning') {
              void this.call<WechatMiniprogram.GeneralCallbackResult>(
                '停止过期搜索',
                (callbacks) => {
                  wx.stopBluetoothDevicesDiscovery(callbacks);
                },
              ).catch(() => undefined);
            }
          },
        );
        this.discoveryStarted = true;
      });
      this.checkScan(session, generation);
      this.scanTimer = setTimeout(() => {
        void this.stopScan().catch((reason) => this.reportScanError(reason, session));
      }, SCAN_MS);
      // Some phones report cached advertisements only through this API.
      const result = await this.call<WechatMiniprogram.GetBluetoothDevicesSuccessCallbackResult>(
        '读取 BLE 设备',
        (callbacks) => wx.getBluetoothDevices(callbacks),
        API_TIMEOUT_MS,
        session,
      );
      this.checkScan(session, generation);
      this.handleDevices(result);
    } catch (reason) {
      if (this.isCurrent(session) && generation === this.scanGeneration) {
        await this.stopScan().catch(() => undefined);
        this.reportScanError(reason, session);
      }
      throw reason;
    }
  }

  async stopScan(): Promise<void> {
    ++this.scanGeneration;
    this.clearScanTimer();
    if (this.state.status === 'scanning') this.patch({ status: 'idle' });
    await this.discoveryOperation(async () => {
      if (!this.discoveryStarted) return;
      this.discoveryStarted = false;
      await this.call<WechatMiniprogram.GeneralCallbackResult>('停止搜索', (callbacks) => {
        wx.stopBluetoothDevicesDiscovery(callbacks);
      });
    });
  }

  async connect(deviceId: string): Promise<void> {
    this.assertAlive();
    if (!deviceId.trim()) throw new Error('请选择一个 BLE 设备');
    if (this.connectionPending) throw new Error('正在连接设备，请等待连接结果');
    this.connectionPending = true;
    const previousDeviceId = this.state.deviceId;
    this.invalidate();
    const session = this.session;
    const device = this.state.devices.find((item) => item.deviceId === deviceId);
    this.patch({
      status: 'connecting',
      deviceId,
      deviceName: device ? device.name : 'BLE 设备',
      endpoints: [],
      endpoint: null,
      error: '',
    });
    try {
      await this.stopScan();
      if (previousDeviceId) await this.closeDevice(previousDeviceId);
      await this.closeTail;
      this.checkSession(session);
      await this.openAdapter(session);
      await this.call<WechatMiniprogram.GeneralCallbackResult>(
        '连接 BLE 设备',
        (callbacks) => {
          wx.createBLEConnection({ deviceId, timeout: CONNECT_TIMEOUT_MS, ...callbacks });
        },
        CONNECT_TIMEOUT_MS,
        session,
        () => {
          // A native connect may complete after timeout/disposal. Close that orphan connection.
          if (!this.isCurrent(session) && this.state.deviceId !== deviceId)
            void this.closeDevice(deviceId);
        },
      );
      this.checkSession(session);
      const { services } =
        await this.call<WechatMiniprogram.GetBLEDeviceServicesSuccessCallbackResult>(
          '读取蓝牙服务',
          (callbacks) => wx.getBLEDeviceServices({ deviceId, ...callbacks }),
          API_TIMEOUT_MS,
          session,
        );
      const endpoints: BleEndpoint[] = [];
      for (const service of services) {
        this.checkSession(session);
        try {
          const { characteristics } =
            await this.call<WechatMiniprogram.GetBLEDeviceCharacteristicsSuccessCallbackResult>(
              '读取蓝牙特征',
              (callbacks) =>
                wx.getBLEDeviceCharacteristics({ deviceId, serviceId: service.uuid, ...callbacks }),
              API_TIMEOUT_MS,
              session,
            );
          endpoints.push(...this.makeEndpoints(service.uuid, characteristics));
        } catch (reason) {
          this.checkSession(session);
          // A device may expose inaccessible system services alongside its UART service.
          if (reason instanceof Error && reason.message.includes('超时')) throw reason;
        }
      }
      this.checkSession(session);
      if (!endpoints.length)
        throw new Error(
          '设备没有可写的 BLE 特征。普通 HC-05 使用经典蓝牙 SPP，微信小程序无法直连，请使用 BLE 串口模块',
        );
      this.patch({ status: 'selecting', endpoints, endpoint: null, error: '' });
    } catch (reason) {
      if (this.isCurrent(session)) this.failSession(errorMessage(reason, '连接'));
      throw reason;
    } finally {
      this.connectionPending = false;
    }
  }

  async selectEndpoint(endpoint: BleEndpoint): Promise<void> {
    this.assertAlive();
    if (this.state.status !== 'selecting' || this.selecting)
      throw new Error('请连接设备并等待串口服务列表加载完成');
    const selected = this.state.endpoints.find(
      (item) =>
        sameUuid(item.serviceId, endpoint.serviceId) &&
        sameUuid(item.writeId, endpoint.writeId) &&
        item.writeType === endpoint.writeType &&
        item.notifyId === endpoint.notifyId,
    );
    if (!selected) throw new Error('请选择当前设备发现的可写串口特征');
    const session = this.session;
    const deviceId = this.state.deviceId;
    this.selecting = true;
    let warning = '';
    try {
      if (selected.notifyId) {
        try {
          await this.call<WechatMiniprogram.GeneralCallbackResult>(
            '订阅串口返回数据',
            (callbacks) => {
              wx.notifyBLECharacteristicValueChange({
                deviceId,
                serviceId: selected.serviceId,
                characteristicId: selected.notifyId as string,
                state: true,
                ...callbacks,
              });
            },
            API_TIMEOUT_MS,
            session,
          );
        } catch (reason) {
          this.checkSession(session);
          warning = `${errorMessage(reason, '订阅返回数据')}；仍可发送，无法确认设备是否执行`;
        }
      } else {
        warning = '此端点未启用返回通知；仍可发送，无法确认设备是否执行';
      }
      this.checkSession(session);
      this.patch({ status: 'ready', endpoint: { ...selected }, error: warning });
    } finally {
      if (this.isCurrent(session)) this.selecting = false;
    }
  }

  async send(frame: string, onStart?: () => void): Promise<void> {
    this.assertAlive();
    // Legacy idle-delimited commands still require one write. Only explicitly
    // framed SoftEngine commands can span multiple 20-byte GATT writes.
    const framed = /^@[^@\r\n\0]{1,32}\r?\n$/.test(frame);
    if (
      !frame.length ||
      /[^\x00-\x7f]/.test(frame) ||
      (frame.startsWith('@') ? !framed : frame.length > 20)
    ) {
      throw new Error('串口命令须为 ASCII：旧协议最多 20 字节，SoftEngine 使用 @命令\\n 分帧');
    }
    if (this.state.status !== 'ready' || !this.state.endpoint)
      throw new Error('蓝牙尚未就绪，请先连接并确认 UART 特征');
    const session = this.session;
    const endpoint = { ...this.state.endpoint };
    const deviceId = this.state.deviceId;
    const queuedAt = Date.now();
    const operation = this.writeTail.then(async () => {
      this.checkSession(session);
      if (this.state.status !== 'ready') throw new Error('蓝牙连接已失效，命令未发送');
      const delay = Math.max(0, FRAME_GAP_MS - (Date.now() - this.lastWriteFinished));
      if (delay) await this.pause(delay, session);
      this.checkSession(session);
      if (Date.now() - queuedAt > MAX_QUEUE_AGE_MS)
        throw new Error('命令等待过久，已丢弃，避免执行过期控制');
      const bytes = new Uint8Array(frame.length);
      for (let index = 0; index < frame.length; index++) bytes[index] = frame.charCodeAt(index);
      try {
        for (let offset = 0; offset < bytes.length; offset += 20) {
          if (offset) await this.pause(FRAME_GAP_MS, session);
          this.checkSession(session);
          if (offset && Date.now() - queuedAt > MAX_QUEUE_AGE_MS)
            throw new Error('分帧发送等待过久，已取消剩余数据');
          const chunk = bytes.slice(offset, offset + 20);
          if (offset === 0) onStart?.();
          await this.call<WechatMiniprogram.GeneralCallbackResult>(
            '发送串口命令',
            (callbacks) => {
              const options: ModernWrite = {
                deviceId,
                serviceId: endpoint.serviceId,
                characteristicId: endpoint.writeId,
                value: chunk.buffer,
                writeType: endpoint.writeType,
                ...callbacks,
              };
              wx.writeBLECharacteristicValue(options);
            },
            WRITE_TIMEOUT_MS,
            session,
          );
          this.checkSession(session);
          this.lastWriteFinished = Date.now();
        }
      } catch (reason) {
        if (this.isCurrent(session))
          this.failSession(`${errorMessage(reason, '发送串口命令')}；已停止发送，请重新连接`);
        throw reason;
      }
    });
    // Keep the queue drainable without converting the caller's failure into success.
    this.writeTail = operation.catch(() => undefined);
    await operation;
  }

  async disconnect(): Promise<void> {
    const deviceId = this.state.deviceId;
    this.invalidate();
    const closing = deviceId ? this.closeDevice(deviceId) : this.closeTail;
    this.patch({
      status: 'idle',
      deviceId: '',
      deviceName: '',
      endpoints: [],
      endpoint: null,
      error: '',
    });
    await this.stopScan().catch(() => undefined);
    await closing;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.receivers.clear();
    wx.offBluetoothDeviceFound(this.handleDevices);
    wx.offBluetoothAdapterStateChange(this.handleAdapter);
    wx.offBLEConnectionStateChange(this.handleConnection);
    wx.offBLECharacteristicValueChange(this.handleValue);
    await this.disconnect();
    if (this.adapterOpened) {
      this.adapterOpened = false;
      await this.call<WechatMiniprogram.GeneralCallbackResult>('关闭蓝牙适配器', (callbacks) => {
        wx.closeBluetoothAdapter(callbacks);
      }).catch(() => undefined);
    }
  }

  private readonly handleDevices = (
    event: WechatMiniprogram.OnBluetoothDeviceFoundCallbackResult,
  ): void => {
    if (this.disposed || this.state.status !== 'scanning') return;
    const devices = new Map(this.state.devices.map((device) => [device.deviceId, device]));
    for (const device of event.devices) {
      if (!device.deviceId) continue;
      const previous = devices.get(device.deviceId);
      devices.set(device.deviceId, {
        deviceId: device.deviceId,
        name: device.localName || device.name || (previous && previous.name) || '未命名 BLE 设备',
        rssi: Number.isFinite(device.RSSI) ? device.RSSI : previous ? previous.rssi : -100,
      });
    }
    this.patch({
      devices: [...devices.values()].sort((first, second) => second.rssi - first.rssi),
    });
  };

  private readonly handleAdapter = (
    event: WechatMiniprogram.OnBluetoothAdapterStateChangeCallbackResult,
  ): void => {
    if (this.disposed) return;
    if (!event.available) {
      this.adapterOpened = false;
      this.discoveryStarted = false;
      this.failSession('手机蓝牙已关闭或权限不可用，已停止发送，请开启蓝牙后重新连接');
    } else if (!event.discovering && this.discoveryStarted && this.state.status === 'scanning') {
      this.discoveryStarted = false;
      ++this.scanGeneration;
      this.clearScanTimer();
      this.patch({ status: 'idle' });
    }
  };

  private readonly handleConnection = (
    event: WechatMiniprogram.OnBLEConnectionStateChangeCallbackResult,
  ): void => {
    if (!this.disposed && !event.connected && event.deviceId === this.state.deviceId) {
      this.failSession('蓝牙连接已断开，已停止发送，请重新连接');
    }
  };

  private readonly handleValue = (
    event: WechatMiniprogram.OnBLECharacteristicValueChangeCallbackResult,
  ): void => {
    const endpoint = this.state.endpoint;
    if (
      this.disposed ||
      this.state.status !== 'ready' ||
      !endpoint ||
      !endpoint.notifyId ||
      event.deviceId !== this.state.deviceId ||
      !sameUuid(event.serviceId, endpoint.serviceId) ||
      !sameUuid(event.characteristicId, endpoint.notifyId)
    )
      return;
    const bytes = new Uint8Array(event.value);
    let value = '';
    for (let index = 0; index < bytes.length; index++) value += String.fromCharCode(bytes[index]);
    for (const listener of this.receivers) {
      try {
        listener(value);
      } catch (reason) {
        console.warn('BLE 接收监听异常', reason);
      }
    }
  };

  private makeEndpoints(
    serviceId: string,
    characteristics: WechatMiniprogram.BLECharacteristic[],
  ): BleEndpoint[] {
    const notifications = characteristics.filter(
      (item) =>
        (item.properties.notify || item.properties.indicate) &&
        !(sameUuid(serviceId, 'FFE0') && sameUuid(item.uuid, 'FFE3')),
    );
    return characteristics
      .filter((item) => {
        const properties: ModernProperties = item.properties;
        // ZX-D30 FFE3 controls module GPIO/settings; it is not UART data.
        if (sameUuid(serviceId, 'FFE0') && sameUuid(item.uuid, 'FFE3')) return false;
        return properties.write || properties.writeNoResponse;
      })
      .map((characteristic) => {
        const properties: ModernProperties = characteristic.properties;
        const nordicNotify =
          sameUuid(serviceId, '6E400001-B5A3-F393-E0A9-E50E24DCCA9E') &&
          sameUuid(characteristic.uuid, '6E400002-B5A3-F393-E0A9-E50E24DCCA9E')
            ? notifications.find((item) =>
                sameUuid(item.uuid, '6E400003-B5A3-F393-E0A9-E50E24DCCA9E'),
              )
            : undefined;
        const zxD30Notify =
          sameUuid(serviceId, 'FFE0') && sameUuid(characteristic.uuid, 'FFE2')
            ? notifications.find((item) => sameUuid(item.uuid, 'FFE1'))
            : undefined;
        const paired =
          notifications.find((item) => sameUuid(item.uuid, characteristic.uuid)) ||
          nordicNotify ||
          zxD30Notify ||
          (notifications.length === 1 ? notifications[0] : undefined);
        return {
          serviceId,
          writeId: characteristic.uuid,
          notifyId: paired ? paired.uuid : undefined,
          writeType: properties.write ? 'write' : 'writeNoResponse',
          label: `${sameUuid(serviceId, 'FFE0') && (sameUuid(characteristic.uuid, 'FFE1') || sameUuid(characteristic.uuid, 'FFE2')) ? 'ZX-D30 透传 · ' : ''}服务 ${serviceId} / 写入 ${characteristic.uuid}${paired ? ' · 有返回通知' : ' · 仅发送'}`,
        };
      });
  }

  private async openAdapter(session: number): Promise<void> {
    await this.call<WechatMiniprogram.GeneralCallbackResult>(
      '开启蓝牙',
      (callbacks) => wx.openBluetoothAdapter(callbacks),
      API_TIMEOUT_MS,
      session,
      () => {
        if (this.disposed) {
          void this.call<WechatMiniprogram.GeneralCallbackResult>(
            '关闭过期蓝牙适配器',
            (callbacks) => {
              wx.closeBluetoothAdapter(callbacks);
            },
          ).catch(() => undefined);
        } else this.adapterOpened = true;
      },
    );
    this.checkSession(session);
    this.adapterOpened = true;
  }

  private async closeDevice(deviceId: string): Promise<void> {
    const closing = this.closeTail.then(() =>
      this.call<WechatMiniprogram.GeneralCallbackResult>('断开蓝牙', (callbacks) => {
        wx.closeBLEConnection({ deviceId, ...callbacks });
      })
        .then(() => undefined)
        .catch(() => undefined),
    );
    this.closeTail = closing;
    await closing;
  }

  private failSession(message: string): void {
    const deviceId = this.state.deviceId;
    this.invalidate();
    if (deviceId) void this.closeDevice(deviceId);
    this.patch({
      status: 'error',
      deviceId: '',
      deviceName: '',
      endpoints: [],
      endpoint: null,
      error: message,
    });
    void this.stopScan().catch(() => undefined);
  }

  private reportScanError(reason: unknown, session: number): void {
    if (this.isCurrent(session))
      this.patch({ status: 'error', error: errorMessage(reason, '扫描 BLE 设备') });
  }

  private patch(update: Partial<BleState>): void {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) {
      try {
        listener(snapshot(this.state));
      } catch (reason) {
        console.warn('BLE 状态监听异常', reason);
      }
    }
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('蓝牙连接管理器已释放，请重新进入页面');
  }

  private isCurrent(session: number): boolean {
    return !this.disposed && session === this.session;
  }

  private checkSession(session: number): void {
    if (!this.isCurrent(session)) throw new Error('蓝牙会话已结束，操作已取消');
  }

  private checkScan(session: number, generation: number): void {
    this.checkSession(session);
    if (generation !== this.scanGeneration) throw new Error('扫描已停止');
  }

  private invalidate(): void {
    ++this.session;
    ++this.scanGeneration;
    this.clearScanTimer();
    this.selecting = false;
    this.lastWriteFinished = 0;
    for (const cancel of [...this.pending]) cancel();
    this.writeTail = Promise.resolve();
  }

  private clearScanTimer(): void {
    if (this.scanTimer !== undefined) clearTimeout(this.scanTimer);
    this.scanTimer = undefined;
  }

  private discoveryOperation(operation: () => Promise<void>): Promise<void> {
    const result = this.discoveryTail.then(operation);
    this.discoveryTail = result.catch(() => undefined);
    return result;
  }

  private pause(milliseconds: number, session: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const cancel = (): void => {
        clearTimeout(timer);
        this.pending.delete(cancel);
        reject(new Error('蓝牙会话已结束，命令已取消'));
      };
      const timer = setTimeout(() => {
        this.pending.delete(cancel);
        try {
          this.checkSession(session);
          resolve();
        } catch (reason) {
          reject(reason);
        }
      }, milliseconds);
      this.pending.add(cancel);
    });
  }

  private call<T>(
    action: string,
    invoke: (callbacks: Callbacks<T>) => void,
    timeout = API_TIMEOUT_MS,
    session?: number,
    onLateSuccess?: () => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(cancel);
        return true;
      };
      const cancel = (): void => {
        if (finish()) reject(new Error('蓝牙会话已结束，操作已取消'));
      };
      const timer = setTimeout(() => {
        if (finish()) reject(new Error(`${action}超时，请检查设备后重新连接`));
      }, timeout);
      if (session !== undefined) this.pending.add(cancel);
      try {
        if (session !== undefined) this.checkSession(session);
        invoke({
          success: (value) => {
            if (!finish()) {
              if (onLateSuccess) onLateSuccess();
              return;
            }
            if (session !== undefined && !this.isCurrent(session))
              reject(new Error('蓝牙会话已结束，操作已取消'));
            else resolve(value);
          },
          fail: (reason) => {
            if (finish()) reject(new Error(errorMessage(reason, action)));
          },
        });
      } catch (reason) {
        if (finish()) reject(new Error(errorMessage(reason, action)));
      }
    });
  }
}
