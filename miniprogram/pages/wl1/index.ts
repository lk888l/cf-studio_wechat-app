import { ControllerSnapshot, RemoteController } from '../../control/controller';
import { joystickVector, legJoystickVector, wl1Main } from '../../devices/profiles';
import { parseTuningValue, tuningGroups } from '../../devices/tuning';
import { InstallationService, InstallationSnapshot } from '../../services/installation';
import { DeviceInfoService, DeviceInfoSnapshot } from '../../services/device-info';
import { onBackground } from '../../services/lifecycle';
import { ParameterService, ParameterSnapshot } from '../../services/parameters';
import { rememberProduct } from '../../services/products';
import { BleState, BleTransport } from '../../transport/ble';

interface LogEntry {
  id: number;
  time: string;
  direction: string;
  text: string;
}
interface JoystickRect {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface StickEvent {
  touches: WechatMiniprogram.TouchDetail[];
  changedTouches: WechatMiniprogram.TouchDetail[];
}
interface StickViewEvent extends StickEvent {
  side: 'motion' | 'pose';
  phase: 'start' | 'move' | 'end';
  epoch: number;
}
interface LiveViewPatch {
  control?: ControllerSnapshot['control'];
  lastFrame?: string;
  sentCount?: number;
  lastReceive?: string;
  lastReceiveAt?: string;
  receiveCount?: number;
  logs?: LogEntry[];
}
// The sticks paint in WXS. Only the instrument readings cross the bridge at 10 Hz.
const liveViewIntervalMs = 100;
type ValueEvent = WechatMiniprogram.CustomEvent<{ value: string | number }>;
const panelSettingsKey = 'wl1-control-panel-v1';
const targetBluetoothNamePrefix = 'D30LE_';
function createTuningGroups(profileId: string) {
  return tuningGroups(profileId).map((group) => ({
    ...group,
    parameters: group.parameters.map((parameter) => ({
      ...parameter,
      draft: parameter.initial.toFixed(parameter.digits),
      sliderMaximum: Math.round((parameter.maximum - parameter.minimum) / parameter.step),
      sliderValue: Math.round((parameter.initial - parameter.minimum) / parameter.step),
      status: '固件参考值 · 未发送',
    })),
  }));
}
const initialBle: BleState = {
  status: 'idle',
  devices: [],
  deviceId: '',
  deviceName: '',
  endpoints: [],
  endpoint: null,
  error: '',
};
const statusLabels: Record<BleState['status'], string> = {
  idle: '未连接',
  scanning: '搜索中',
  connecting: '连接中',
  selecting: '待确认通道',
  ready: '通道就绪',
  error: '连接异常',
};

Page({
  data: {
    tab: 'control',
    demo: false,
    ble: initialBle,
    statusLabel: '未连接',
    ready: false,
    armed: false,
    busy: false,
    switchingProduct: false,
    control: { ...wl1Main.initial },
    speedModes: ['标准 · 60 RPM', '全量程 · 100 RPM', '超级模式 · 150 RPM'],
    speedModeIndex: 1,
    motionRect: null as JoystickRect | null,
    poseRect: null as JoystickRect | null,
    motionViewEpoch: 0,
    poseViewEpoch: 0,
    lastFrame: '',
    sentCount: 0,
    lastReceive: '',
    lastReceiveAt: '',
    receiveCount: 0,
    error: '',
    logs: [] as LogEntry[],
    helpOpen: false,
    targetBluetoothName: `${targetBluetoothNamePrefix}*`,
    panelModeIndex: 0,
    tuningGroupIndex: 0,
    tuningGroups: createTuningGroups(wl1Main.id),
    tuningBusy: '',
    tuningMessage: '',
    installation: {
      busy: '',
      status: null,
      message: '连接设备后查询安装状态',
      success: false,
    } as InstallationSnapshot,
    installationLock: false,
    parameterPanelOpen: false,
    parameterPreparing: false,
    parameterAvailable: false,
    parameters: { busy: '', status: null, message: '', success: false } as ParameterSnapshot,
    deviceInfo: {
      busy: '',
      uid: '',
      angleBias: null,
      rollBias: null,
      message: '',
    } as DeviceInfoSnapshot,
  },
  transport: null as BleTransport | null,
  controller: null as RemoteController | null,
  installationService: null as InstallationService | null,
  parameterService: null as ParameterService | null,
  deviceInfoService: null as DeviceInfoService | null,
  subscriptions: [] as Array<() => void>,
  touchId: null as number | null,
  joystickRect: null as JoystickRect | null,
  legTouchId: null as number | null,
  legJoystickRect: null as JoystickRect | null,
  legHeightAnchor: wl1Main.initial.height,
  motionGesture: 0,
  legGesture: 0,
  visible: true,
  foreground: true,
  destroyed: false,
  logId: 0,
  logEntries: [] as LogEntry[],
  receivedPackets: 0,
  controllerState: null as ControllerSnapshot | null,
  pendingView: null as LiveViewPatch | null,
  viewTimer: undefined as number | undefined,
  viewInFlight: 0,
  viewGeneration: 0,
  viewReady: false,
  layoutGeneration: 0,
  motionLatestTouch: null as WechatMiniprogram.TouchDetail | null,
  poseLatestTouch: null as WechatMiniprogram.TouchDetail | null,
  suspension: null as Promise<void> | null,
  tuningEpoch: 0,
  productSwitchEpoch: 0,

  onLoad() {
    this.logEntries = [];
    rememberProduct('wl1');
    try {
      const settings = wx.getStorageSync(panelSettingsKey);
      if (settings && typeof settings === 'object') {
        this.setData({
          panelModeIndex: settings.mode === 1 ? 1 : 0,
          tuningGroupIndex:
            Number.isInteger(settings.group) && settings.group >= 0 && settings.group < 5
              ? settings.group
              : 0,
        });
      }
    } catch {
      // Storage is optional; the original instrument panel remains the default.
    }
    this.transport = new BleTransport({ preferredNamePrefix: targetBluetoothNamePrefix });
    this.parameterService = new ParameterService(
      async (frame, onStart) => {
        if (!this.data.parameterAvailable || !this.transport)
          throw new Error('请先连接蓝牙设备并确认串口通道');
        await this.transport.send(frame, onStart);
        this.addLog('TX', frame);
      },
      (parameters) => {
        if (this.destroyed) return;
        this.setData({ parameters });
        if (!parameters.busy && parameters.message) this.addLog('INFO', parameters.message);
      },
    );
    this.deviceInfoService = new DeviceInfoService(
      async (frame, onStart) => {
        if (!this.data.parameterAvailable || !this.transport)
          throw new Error('请先连接蓝牙设备并确认串口通道');
        await this.transport.send(frame, onStart);
        this.addLog('TX', frame);
      },
      (deviceInfo) => {
        if (this.destroyed) return;
        this.applyDeviceInfo(deviceInfo);
        if (!deviceInfo.busy && deviceInfo.message) this.addLog('INFO', deviceInfo.message);
      },
    );
    this.installationService = new InstallationService(
      async (frame, onStart) => {
        if (!this.data.parameterAvailable || !this.transport)
          throw new Error('请连接真实设备后操作');
        await this.transport.send(frame, onStart);
        this.addLog('TX', frame);
      },
      (installation) => {
        if (this.destroyed) return;
        this.setData({ installation });
        if (installation.status) this.setData({ installationLock: installation.status.active });
        if (!installation.busy && installation.message) this.addLog('INFO', installation.message);
      },
    );
    this.controller = new RemoteController(
      wl1Main,
      async (frame) => {
        if (this.data.demo) {
          // Deliberately isolated: demo never calls any BLE write API.
          return;
        }
        if (!this.transport) throw new Error('蓝牙服务未初始化');
        await this.transport.send(frame);
      },
      (frame) => this.addLog(this.data.demo ? 'SIM' : 'TX', frame),
    );
    this.subscriptions.push(
      this.controller.subscribe((state) => {
        if (this.destroyed) return;
        const previous = this.controllerState;
        this.controllerState = state;
        if (previous?.armed && !state.armed) this.clearJoysticks();
        const flags: { armed?: boolean; error?: string } = {};
        if (state.armed !== this.data.armed) flags.armed = state.armed;
        if (!previous || state.error !== previous.error) flags.error = state.error;
        if (Object.keys(flags).length) this.setData(flags);
        if (!state.motionHolding && this.touchId !== null) {
          this.touchId = null;
          this.motionLatestTouch = null;
          this.motionGesture += 1;
          this.setData({ motionViewEpoch: this.data.motionViewEpoch + 1 });
        }
        if (!state.poseHolding && this.legTouchId !== null) {
          this.legTouchId = null;
          this.poseLatestTouch = null;
          this.legGesture += 1;
          this.setData({ poseViewEpoch: this.data.poseViewEpoch + 1 });
        }
        this.queueLiveView(
          { control: state.control, lastFrame: state.lastFrame, sentCount: state.sentCount },
          !state.armed ||
            previous?.motionHolding !== state.motionHolding ||
            previous?.poseHolding !== state.poseHolding,
        );
      }),
    );
    this.subscriptions.push(
      this.transport.subscribe((ble) => {
        if (this.destroyed) return;
        const ready =
          this.visible && wl1Main.supported && (this.data.demo || ble.status === 'ready');
        if (ble.deviceId !== this.data.ble.deviceId) {
          this.receivedPackets = 0;
          this.queueLiveView({ lastReceive: '', lastReceiveAt: '', receiveCount: 0 }, true);
        }
        const sessionChanged =
          ready !== this.data.ready ||
          ble.deviceId !== this.data.ble.deviceId ||
          ble.endpoint?.writeId !== this.data.ble.endpoint?.writeId ||
          ble.endpoint?.serviceId !== this.data.ble.endpoint?.serviceId ||
          ble.endpoint?.notifyId !== this.data.ble.endpoint?.notifyId;
        if (sessionChanged) {
          this.resetTuning();
          this.resetParameters();
          this.installationService?.reset();
          this.deviceInfoService?.reset();
        }
        this.setData({
          ble,
          ready,
          statusLabel: this.data.demo ? '模拟演练' : statusLabels[ble.status],
        });
        this.controller?.setReady(ready);
        this.updateParameterAvailability();
        if (sessionChanged && this.data.parameterAvailable) void this.startCalibrationHandshake();
        if (ble.error) this.setData({ error: ble.error });
      }),
    );
    this.subscriptions.push(
      this.transport.onReceive((text) => {
        if (this.destroyed || this.data.demo) return;
        this.queueLiveView({
          lastReceive: text.slice(0, 256),
          lastReceiveAt: new Date().toTimeString().slice(0, 8),
          receiveCount: ++this.receivedPackets,
        });
        this.addLog('RX', text);
        if (this.visible) {
          this.parameterService?.receive(text);
          this.installationService?.receive(text);
          this.deviceInfoService?.receive(text);
        }
      }),
    );
    this.subscriptions.push(
      onBackground(() => {
        this.foreground = false;
        this.cancelProductSwitch();
        void this.suspend();
      }),
    );
    this.addLog('INFO', 'WL1 main · 待连接。模拟演练不会向设备发送数据。');
  },

  onShow() {
    this.foreground = true;
    if (this.data.switchingProduct) return;
    this.visible = true;
    if (this.pendingView) this.queueLiveView({});
    if (this.data.tab === 'console') this.queueLiveView({ logs: this.logEntries }, true);
    if (this.viewReady) this.measureJoysticks();
    if (this.data.demo && !this.suspension) {
      const ready = wl1Main.supported;
      this.controller?.setReady(ready);
      this.setData({ ready });
    }
  },

  onReady() {
    this.viewReady = true;
    this.measureJoysticks();
  },

  onHide() {
    this.foreground = false;
    this.cancelProductSwitch();
    void this.suspend();
  },

  onUnload() {
    this.foreground = false;
    this.cancelProductSwitch();
    const shutdown = this.suspend();
    this.destroyed = true;
    this.cancelLiveView();
    this.subscriptions.forEach((unsubscribe) => unsubscribe());
    this.subscriptions = [];
    void shutdown.finally(() => {
      this.controller?.dispose();
      void this.transport?.dispose().catch(() => undefined);
    });
  },

  onResize() {
    this.releaseJoysticks();
    this.invalidateJoystickLayout(true);
  },

  async suspend(): Promise<void> {
    this.visible = false;
    this.cancelLiveView();
    this.invalidateJoystickLayout();
    if (this.suspension) return this.suspension;
    this.installationService?.reset();
    this.deviceInfoService?.reset();
    this.resetParameters();
    this.setData({ parameterAvailable: false, parameterPanelOpen: false });
    this.clearJoysticks();
    this.setData({ busy: true });
    const work = async (): Promise<void> => {
      try {
        await this.controller?.stop();
      } finally {
        try {
          await this.transport?.disconnect();
        } finally {
          this.controller?.setReady(false);
        }
      }
    };
    this.suspension = work()
      .catch((error) => {
        if (!this.destroyed)
          this.setData({ error: error instanceof Error ? error.message : '断开失败，请检查设备' });
      })
      .finally(() => {
        this.suspension = null;
        if (!this.destroyed) {
          const ready = this.visible && this.data.demo && wl1Main.supported;
          this.controller?.setReady(ready);
          this.setData({ busy: false, ready });
        }
      });
    return this.suspension;
  },

  cancelProductSwitch() {
    this.productSwitchEpoch += 1;
    if (!this.destroyed && this.data.switchingProduct) this.setData({ switchingProduct: false });
  },

  async switchProduct(): Promise<void> {
    if (this.destroyed || !this.foreground || this.data.switchingProduct) return;
    const epoch = ++this.productSwitchEpoch;
    this.setData({ switchingProduct: true, error: '' });
    await this.suspend();
    if (this.destroyed || !this.foreground || epoch !== this.productSwitchEpoch) return;
    const failed = () => {
      if (this.destroyed || epoch !== this.productSwitchEpoch) return;
      this.visible = this.foreground;
      this.controller?.setReady(false);
      this.setData({
        switchingProduct: false,
        ready: false,
        error: '返回产品页失败，请点击“产品”重试。设备控制已停止。',
      });
    };
    try {
      wx.redirectTo({ url: '/pages/index/index?choose=1', fail: failed });
    } catch {
      failed();
    }
  },

  async perform(action: () => Promise<void>): Promise<void> {
    if (this.data.busy || this.destroyed || !this.visible) return;
    this.resetParameters();
    this.setData({ busy: true, error: '' });
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : '操作失败，请重试';
      if (!this.destroyed) {
        this.setData({ error: message });
        this.addLog('ERR', message);
      }
    } finally {
      if (!this.destroyed && !this.suspension) this.setData({ busy: false });
    }
  },

  queueLiveView(patch: LiveViewPatch, immediate = false) {
    if (this.destroyed) return;
    this.pendingView = { ...this.pendingView, ...patch };
    if (immediate) this.flushLiveView(true);
    else if (this.visible && this.viewTimer === undefined && !this.viewInFlight) {
      this.viewTimer = setTimeout(() => {
        this.viewTimer = undefined;
        this.flushLiveView();
      }, liveViewIntervalMs);
    }
  },

  flushLiveView(immediate = false) {
    if (this.destroyed || !this.pendingView || (!immediate && this.viewInFlight)) return;
    if (this.viewTimer !== undefined) clearTimeout(this.viewTimer);
    this.viewTimer = undefined;
    const patch = this.pendingView;
    this.pendingView = null;
    if (this.data.tab !== 'console') delete patch.logs;
    const generation = this.viewGeneration;
    const trackRender = this.visible;
    if (trackRender) this.viewInFlight += 1;
    this.setData(patch, () => {
      if (generation !== this.viewGeneration) return;
      if (trackRender) this.viewInFlight -= 1;
      if (this.pendingView && this.visible && !this.destroyed) this.queueLiveView({});
    });
  },

  cancelLiveView() {
    if (this.viewTimer !== undefined) clearTimeout(this.viewTimer);
    this.viewTimer = undefined;
    this.pendingView = null;
    // Background rendering callbacks may arrive late or never arrive. They must
    // not block a new foreground session or release its in-flight render slot.
    this.viewGeneration += 1;
    this.viewInFlight = 0;
  },

  addLog(direction: string, text: string) {
    if (this.destroyed) return;
    const time = new Date().toTimeString().slice(0, 8);
    const entry = { id: ++this.logId, time, direction, text: text.slice(0, 256) };
    this.logEntries = [entry, ...this.logEntries].slice(0, 60);
    if (this.data.tab === 'console' && this.visible) this.queueLiveView({ logs: this.logEntries });
  },

  switchTab(event: WechatMiniprogram.BaseEvent) {
    this.resetParameters();
    this.releaseJoysticks();
    const tab = String(event.currentTarget.dataset.tab);
    if (['control', 'connection', 'console', 'installation'].includes(tab)) {
      if (tab !== 'control') void this.controller?.stop();
      this.invalidateJoystickLayout();
      this.setData({ tab }, () => {
        if (tab === 'control') this.measureJoysticks();
      });
      if (tab === 'console') this.queueLiveView({ logs: this.logEntries }, true);
      if (tab === 'installation') void this.operateInstallation('query');
    }
  },

  toggleDemo() {
    void this.perform(async () => {
      await this.controller?.stop();
      await this.transport?.disconnect();
      this.controller?.setReady(false);
      if (!this.visible || this.destroyed) return;
      const demo = !this.data.demo;
      const ready = demo && wl1Main.supported;
      this.receivedPackets = 0;
      this.queueLiveView(
        { lastFrame: '', lastReceive: '', lastReceiveAt: '', receiveCount: 0 },
        true,
      );
      this.setData({
        demo,
        ready,
        statusLabel: demo ? '模拟演练' : '未连接',
        lastFrame: '',
        lastReceive: '',
        lastReceiveAt: '',
        receiveCount: 0,
        error: '',
      });
      this.controller?.setReady(ready);
      this.resetTuning();
      this.resetParameters();
      this.updateParameterAvailability();
      this.addLog(
        'INFO',
        demo ? '已进入模拟演练，所有帧仅在本地展示。' : '已退出模拟，请重新连接 BLE 设备。',
      );
    });
  },

  startScan() {
    if (this.data.demo) return;
    void this.perform(async () => {
      await this.transport?.scan();
    });
  },
  stopScan() {
    void this.perform(async () => {
      await this.transport?.stopScan();
    });
  },
  connectDevice(event: WechatMiniprogram.BaseEvent) {
    if (this.data.demo) return;
    const id = String(event.currentTarget.dataset.id || '');
    if (id)
      void this.perform(async () => {
        await this.controller?.stop();
        await this.transport?.connect(id);
      });
  },
  disconnectDevice() {
    void this.perform(async () => {
      await this.controller?.stop();
      await this.transport?.disconnect();
      this.addLog('INFO', '已请求归零并断开；固件无执行确认。');
    });
  },
  selectEndpoint(event: WechatMiniprogram.BaseEvent) {
    const endpoint = this.data.ble.endpoints[Number(event.currentTarget.dataset.index)];
    if (!endpoint || this.data.demo) return;
    void this.perform(async () => {
      this.resetParameters();
      await this.transport?.selectEndpoint(endpoint);
      this.addLog('INFO', `串口通道 ${endpoint.writeId}；写入成功不代表车端已执行。`);
    });
  },

  async operateInstallation(action: 'on' | 'off' | 'query'): Promise<void> {
    if (!this.canOperateParameters() || this.data.installation.busy) return;
    this.setData({ busy: true, error: '' });
    const service = this.installationService;
    const deviceId = this.data.ble.deviceId;
    try {
      if (action !== 'query') {
        this.clearJoysticks();
        await this.controller?.stop();
        if (
          this.destroyed ||
          !this.visible ||
          !this.data.parameterAvailable ||
          deviceId !== this.data.ble.deviceId
        )
          return;
        if (action === 'on') this.setData({ installationLock: true });
        await service?.set(action === 'on');
      } else await service?.query();
    } finally {
      if (!this.destroyed && !this.suspension) this.setData({ busy: false });
    }
  },
  enterInstallation() {
    void this.operateInstallation('on');
  },
  finishInstallation() {
    void this.operateInstallation('off');
  },
  queryInstallation() {
    void this.operateInstallation('query');
  },
  toggleArmed() {
    if (!this.data.demo && this.data.installationLock) {
      this.setData({ error: '请先在安装页面确认退出安装模式' });
      return;
    }
    if (
      this.data.busy ||
      this.data.parameters.busy ||
      this.data.parameterPreparing ||
      !this.data.ready ||
      !this.visible
    )
      return;
    this.resetParameters();
    if (this.data.armed) {
      void this.controller?.stop();
      return;
    }
    try {
      this.controller?.arm();
      this.addLog('INFO', '控制已启用。摇杆握持不限时；松手归零，腿高保持。');
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : '无法启用控制' });
    }
  },
  stopMotion() {
    this.resetParameters();
    this.clearJoysticks();
    void this.controller?.stop();
  },

  clearJoysticks() {
    this.touchId = null;
    this.legTouchId = null;
    this.motionGesture += 1;
    this.legGesture += 1;
    this.motionLatestTouch = null;
    this.poseLatestTouch = null;
    this.setData({
      motionViewEpoch: this.data.motionViewEpoch + 1,
      poseViewEpoch: this.data.poseViewEpoch + 1,
    });
  },

  releaseJoysticks() {
    this.clearJoysticks();
    this.controller?.release();
  },

  invalidateJoystickLayout(remeasure = false) {
    this.layoutGeneration += 1;
    this.joystickRect = null;
    this.legJoystickRect = null;
    this.setData({ motionRect: null, poseRect: null }, () => {
      if (remeasure) this.measureJoysticks();
    });
  },

  measureJoysticks() {
    if (this.destroyed || !this.visible || this.data.tab !== 'control') return;
    const generation = this.layoutGeneration;
    for (const side of ['motion', 'pose'] as const) {
      this.createSelectorQuery()
        .select(side === 'motion' ? '#joystick' : '#leg-joystick')
        .boundingClientRect((rect) => {
          if (
            !rect ||
            Array.isArray(rect) ||
            !rect.width ||
            !rect.height ||
            this.destroyed ||
            !this.visible ||
            this.data.tab !== 'control' ||
            generation !== this.layoutGeneration
          )
            return;
          this.applyJoystickRect(side, rect);
        })
        .exec();
    }
  },

  applyJoystickRect(side: 'motion' | 'pose', rect: JoystickRect) {
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    // Cache geometry until a layout change; the view layer uses the same coordinates.
    const bounds = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    if (side === 'motion') {
      this.joystickRect = bounds;
      this.setData({ motionRect: bounds });
      if (this.motionLatestTouch) this.updateJoystick(this.motionLatestTouch);
    } else {
      this.legJoystickRect = bounds;
      this.setData({ poseRect: bounds });
      if (this.poseLatestTouch) this.updateLegJoystick(this.poseLatestTouch);
    }
  },

  onStickTouch(event: StickViewEvent) {
    if (this.destroyed || !this.visible || this.data.tab !== 'control' || !this.data.ready) return;
    if (event.side === 'motion' && event.epoch === this.data.motionViewEpoch) {
      if (event.phase === 'start') this.onJoystickStart(event);
      else if (event.phase === 'move') this.onJoystickMove(event);
      else if (event.phase === 'end') this.onJoystickEnd(event);
    } else if (event.side === 'pose' && event.epoch === this.data.poseViewEpoch) {
      if (event.phase === 'start') this.onLegJoystickStart(event);
      else if (event.phase === 'move') this.onLegJoystickMove(event);
      else if (event.phase === 'end') this.onLegJoystickEnd(event);
    }
  },

  onJoystickStart(event: StickEvent) {
    if (!this.data.armed || this.touchId !== null || !event.changedTouches.length) return;
    const touch = event.changedTouches[0];
    if (touch.identifier === this.legTouchId) return;
    this.touchId = touch.identifier;
    this.motionLatestTouch = touch;
    this.controller?.beginHold();
    if (this.joystickRect) {
      this.updateJoystick(touch);
      return;
    }
    const gesture = ++this.motionGesture;
    this.createSelectorQuery()
      .select('#joystick')
      .boundingClientRect((rect) => {
        if (
          !rect ||
          Array.isArray(rect) ||
          this.touchId !== touch.identifier ||
          !this.data.armed ||
          gesture !== this.motionGesture
        )
          return;
        this.applyJoystickRect('motion', rect);
      })
      .exec();
  },
  onJoystickMove(event: StickEvent) {
    const touch = event.touches.find((item) => item.identifier === this.touchId);
    if (touch) {
      this.motionLatestTouch = touch;
      this.updateJoystick(touch);
    }
  },
  stickOffset(rect: JoystickRect, touch: WechatMiniprogram.TouchDetail) {
    const radius = Math.min(rect.width, rect.height) * 0.32;
    const dx = touch.clientX - rect.left - rect.width / 2;
    const dy = touch.clientY - rect.top - rect.height / 2;
    const length = Math.sqrt(dx * dx + dy * dy);
    const factor = length > radius ? radius / length : 1;
    return { x: dx * factor, y: dy * factor, radius };
  },
  updateJoystick(touch: WechatMiniprogram.TouchDetail) {
    const rect = this.joystickRect;
    if (!rect || !this.data.armed || !rect.width || !rect.height) return;
    const { x, y, radius } = this.stickOffset(rect, touch);
    const { speed, turn } = joystickVector(
      x / radius,
      y / radius,
      [60, 100, 150][this.data.speedModeIndex],
    );
    this.controller?.move(speed, turn);
  },
  onJoystickEnd(event?: StickEvent) {
    if (event && !event.changedTouches.some((touch) => touch.identifier === this.touchId)) return;
    this.touchId = null;
    this.motionLatestTouch = null;
    this.motionGesture += 1;
    // A touchend already resets WXS locally. Preserve its epoch so a rapid
    // re-grab before the next render is not mistaken for a stale gesture.
    if (!event) this.setData({ motionViewEpoch: this.data.motionViewEpoch + 1 });
    this.controller?.releaseMotion();
  },
  onLegJoystickStart(event: StickEvent) {
    if (!this.data.armed || this.legTouchId !== null || !event.changedTouches.length) return;
    const touch = event.changedTouches[0];
    if (touch.identifier === this.touchId) return;
    this.legTouchId = touch.identifier;
    this.poseLatestTouch = touch;
    this.legHeightAnchor = this.controller?.snapshot().control.height ?? this.data.control.height;
    this.controller?.beginPoseHold();
    if (this.legJoystickRect) {
      this.updateLegJoystick(touch);
      return;
    }
    const gesture = ++this.legGesture;
    this.createSelectorQuery()
      .select('#leg-joystick')
      .boundingClientRect((rect) => {
        if (
          !rect ||
          Array.isArray(rect) ||
          this.legTouchId !== touch.identifier ||
          !this.data.armed ||
          gesture !== this.legGesture
        )
          return;
        this.applyJoystickRect('pose', rect);
      })
      .exec();
  },
  onLegJoystickMove(event: StickEvent) {
    const touch = event.touches.find((item) => item.identifier === this.legTouchId);
    if (touch) {
      this.poseLatestTouch = touch;
      this.updateLegJoystick(touch);
    }
  },
  updateLegJoystick(touch: WechatMiniprogram.TouchDetail) {
    const rect = this.legJoystickRect;
    if (!rect || !this.data.armed || !rect.width || !rect.height) return;
    const { x, y, radius } = this.stickOffset(rect, touch);
    const { height, roll } = legJoystickVector(x / radius, y / radius, this.legHeightAnchor);
    this.controller?.movePose(height, roll);
  },
  onLegJoystickEnd(event?: StickEvent) {
    if (event && !event.changedTouches.some((touch) => touch.identifier === this.legTouchId))
      return;
    this.legTouchId = null;
    this.poseLatestTouch = null;
    this.legGesture += 1;
    if (!event) this.setData({ poseViewEpoch: this.data.poseViewEpoch + 1 });
    this.controller?.releasePose();
  },
  onSpeedModeChange(event: ValueEvent) {
    this.onJoystickEnd();
    const index = Number(event.detail.value);
    if (index >= 0 && index <= 2 && Number.isInteger(index))
      this.setData({ speedModeIndex: index });
  },
  onHeightChange(event: ValueEvent) {
    this.controller?.pose(Number(event.detail.value) / 10, this.controller.snapshot().control.roll);
  },
  onRollChange(event: ValueEvent) {
    this.controller?.pose(this.controller.snapshot().control.height, Number(event.detail.value));
  },
  resetPose() {
    this.onLegJoystickEnd();
    this.controller?.pose(wl1Main.initial.height, 0);
  },
  resetTuning() {
    this.tuningEpoch += 1;
    this.setData({
      tuningGroups: createTuningGroups(wl1Main.id),
      tuningBusy: '',
      tuningMessage: '',
    });
  },
  applyDeviceInfo(deviceInfo: DeviceInfoSnapshot) {
    const previous = this.data.deviceInfo;
    this.setData({ deviceInfo });
    const midpoint = (id: string, value: number) => {
      const parameter = this.findTuningParameter(id);
      if (!parameter) return;
      const sliderValue = Math.max(
        0,
        Math.min(parameter.sliderMaximum, Math.round((value - parameter.minimum) / parameter.step)),
      );
      this.updateTuningParameter(id, {
        draft: value.toFixed(parameter.digits),
        sliderValue,
        status:
          value < parameter.minimum || value > parameter.maximum
            ? '已读取车端值 · 超出页面调节范围'
            : '已从本车读取 · 未修改',
      });
    };
    if (
      deviceInfo.angleBias &&
      (!previous.angleBias || previous.angleBias.base !== deviceInfo.angleBias.base)
    )
      midpoint('angle-bias', deviceInfo.angleBias.base);
    if (
      deviceInfo.rollBias &&
      (!previous.rollBias || previous.rollBias.base !== deviceInfo.rollBias.base)
    )
      midpoint('roll-bias', deviceInfo.rollBias.base);
  },
  async startCalibrationHandshake() {
    if (!this.data.parameterAvailable || !this.deviceInfoService) return;
    const epoch = this.tuningEpoch;
    for (const id of ['angle-bias', 'roll-bias'])
      this.updateTuningParameter(id, { draft: '', status: '正在读取本车当前值…' });
    if (!this.data.ble.endpoint?.notifyId) {
      this.deviceInfoService.reset('串口未启用返回通知，无法读取机身参数');
    } else {
      await this.deviceInfoService.readAll();
    }
    if (this.destroyed || epoch !== this.tuningEpoch) return;
    if (!this.data.deviceInfo.angleBias)
      this.updateTuningParameter('angle-bias', {
        status: '未读到本车值 · 请刷新或手动输入',
      });
    if (!this.data.deviceInfo.rollBias)
      this.updateTuningParameter('roll-bias', {
        status: '未读到本车值 · 请刷新或手动输入',
      });
  },
  refreshDeviceInfo() {
    if (this.canOperateParameters()) void this.startCalibrationHandshake();
  },
  savePanelSettings() {
    try {
      wx.setStorageSync(panelSettingsKey, {
        mode: this.data.panelModeIndex,
        group: this.data.tuningGroupIndex,
      });
    } catch {
      this.addLog('INFO', '面板设置本次有效，本地保存失败。');
    }
  },
  onPanelModeChange(event: WechatMiniprogram.CustomEvent<{ value: boolean }>) {
    if (typeof event.detail.value !== 'boolean') return;
    this.setData({ panelModeIndex: event.detail.value ? 1 : 0 });
    this.savePanelSettings();
  },
  onTuningGroupChange(event: ValueEvent) {
    const index = Number(event.detail.value);
    if (!Number.isInteger(index) || !this.data.tuningGroups[index]) return;
    this.setData({ tuningGroupIndex: index });
    this.savePanelSettings();
  },
  findTuningParameter(id: string) {
    return this.data.tuningGroups
      .flatMap((group) => group.parameters)
      .find((parameter) => parameter.id === id);
  },
  updateTuningParameter(
    id: string,
    update: { draft?: string; status?: string; sliderValue?: number },
  ) {
    const groupIndex = this.data.tuningGroups.findIndex((group) =>
      group.parameters.some((parameter) => parameter.id === id),
    );
    if (groupIndex < 0) return;
    const parameterIndex = this.data.tuningGroups[groupIndex].parameters.findIndex(
      (parameter) => parameter.id === id,
    );
    const prefix = `tuningGroups[${groupIndex}].parameters[${parameterIndex}]`;
    const patch: Record<string, string | number> = {};
    if (update.draft !== undefined) patch[`${prefix}.draft`] = update.draft;
    if (update.status !== undefined) patch[`${prefix}.status`] = update.status;
    if (update.sliderValue !== undefined) patch[`${prefix}.sliderValue`] = update.sliderValue;
    // Keep native input focus and the scroll position while editing one row.
    this.setData(patch);
  },
  onTuningInput(event: ValueEvent) {
    const id = String(event.currentTarget.dataset.id || '');
    const parameter = this.findTuningParameter(id);
    if (
      !parameter ||
      parameter.unavailable ||
      this.data.tuningBusy === id ||
      this.data.deviceInfo.busy
    )
      return;
    const draft = String(event.detail.value);
    let sliderValue = parameter.sliderValue;
    try {
      const value = parseTuningValue(parameter, draft);
      sliderValue = Math.round((value - parameter.minimum) / parameter.step);
    } catch {
      // Preserve intermediate text such as "-" or an empty field; validate on send.
    }
    this.updateTuningParameter(id, { draft, sliderValue, status: '已编辑 · 未发送' });
    this.setData({ tuningMessage: '' });
  },
  onTuningSliderChange(event: ValueEvent) {
    const id = String(event.currentTarget.dataset.id || '');
    const parameter = this.findTuningParameter(id);
    const sliderValue = Number(event.detail.value);
    if (
      !parameter ||
      parameter.unavailable ||
      this.data.tuningBusy === id ||
      this.data.deviceInfo.busy ||
      !Number.isInteger(sliderValue) ||
      sliderValue < 0 ||
      sliderValue > parameter.sliderMaximum
    )
      return;
    // Native slider values are integer ticks; convert only at the UI boundary.
    const draft = (parameter.minimum + sliderValue * parameter.step).toFixed(parameter.digits);
    this.updateTuningParameter(id, { draft, sliderValue, status: '已编辑 · 未发送' });
    this.setData({ tuningMessage: '' });
  },
  sendTuningParameter(event: WechatMiniprogram.BaseEvent) {
    const id = String(event.currentTarget.dataset.id || '');
    const parameter = this.findTuningParameter(id);
    if (!parameter || parameter.unavailable) return;
    void this.performTuning(id, async () => {
      const value = parseTuningValue(parameter, parameter.draft);
      this.updateTuningParameter(id, { draft: value.toFixed(parameter.digits) });
      await this.controller!.sendTuning(id, String(value));
    });
  },
  async performTuning(id: string, action: () => Promise<void>) {
    if (
      this.destroyed ||
      !this.visible ||
      this.data.busy ||
      this.data.tuningBusy ||
      this.data.parameters.busy ||
      this.data.parameterPreparing ||
      this.data.deviceInfo.busy ||
      !this.controller
    )
      return;
    if (!this.data.ready) {
      this.setData({ tuningMessage: '请先连接设备或启用模拟' });
      return;
    }
    const epoch = this.tuningEpoch;
    this.setData({ tuningBusy: id, tuningMessage: '' });
    try {
      await action();
      if (this.destroyed || epoch !== this.tuningEpoch) return;
      if (!this.data.demo) {
        this.parameterService?.markParametersChanged();
        if (id === 'angle-bias' || id === 'roll-bias')
          this.deviceInfoService?.markCalibrationStale(
            id === 'angle-bias' ? 'anglebias' : 'rollbias',
          );
      }
      const status = this.data.demo ? '模拟发送 · 未写入设备' : '已发送 · 未确认执行';
      this.updateTuningParameter(id === 'angle-auto' ? 'angle-p' : id, {
        status: id === 'angle-auto' ? `自动 Kp ${status}` : status,
      });
      this.setData({ tuningMessage: id === 'angle-auto' ? `自动 Kp ${status}` : status });
    } catch (error) {
      if (this.destroyed || epoch !== this.tuningEpoch) return;
      const message = error instanceof Error ? error.message : '参数发送失败';
      this.updateTuningParameter(id, { status: '未完成发送' });
      this.setData({ tuningMessage: message });
      this.addLog('ERR', message);
    } finally {
      if (!this.destroyed && epoch === this.tuningEpoch) this.setData({ tuningBusy: '' });
    }
  },
  updateParameterAvailability() {
    this.setData({
      parameterAvailable: this.visible && !this.data.demo && this.data.ble.status === 'ready',
    });
  },
  resetParameters() {
    const message =
      this.data.parameters.busy === 'save'
        ? '未收到保存结果：操作已中断，请重新查询车端参数状态'
        : '';
    this.parameterService?.reset(message);
  },
  openParameterPanel() {
    if (this.data.armed) this.releaseJoysticks();
    this.setData({ parameterPanelOpen: true });
    this.queryParameters();
  },
  closeParameterPanel() {
    this.setData({ parameterPanelOpen: false });
  },
  canOperateParameters() {
    return (
      !this.destroyed &&
      this.visible &&
      this.data.parameterAvailable &&
      !this.data.busy &&
      !this.data.tuningBusy &&
      !this.data.parameters.busy &&
      !this.data.parameterPreparing &&
      !this.data.installation.busy &&
      !this.data.deviceInfo.busy
    );
  },
  queryParameters() {
    if (this.canOperateParameters()) void this.parameterService?.query();
  },
  saveParameters() {
    if (!this.canOperateParameters()) return;
    void this.parameterService?.save();
  },
  async disableFirmwareControl() {
    if (!this.canOperateParameters()) return;
    const epoch = this.tuningEpoch;
    this.setData({ parameterPreparing: true });
    try {
      const confirmed = await new Promise<boolean>((resolve) => {
        wx.showModal({
          title: '关闭车端平衡控制',
          content: '请先扶稳车体。关闭后车轮将停止平衡控制，车体需要支撑。确认已扶稳后继续。',
          confirmText: '确认关闭',
          success: (result) => resolve(result.confirm),
          fail: () => resolve(false),
        });
      });
      if (
        !confirmed ||
        this.destroyed ||
        !this.visible ||
        epoch !== this.tuningEpoch ||
        !this.data.parameterAvailable
      )
        return;
      this.clearJoysticks();
      if (this.data.armed) await this.controller?.stop();
      if (
        this.destroyed ||
        !this.visible ||
        epoch !== this.tuningEpoch ||
        !this.data.parameterAvailable
      )
        return;
      await this.parameterService?.control(false);
    } finally {
      if (!this.destroyed) this.setData({ parameterPreparing: false });
    }
  },
  enableFirmwareControl() {
    if (this.data.installationLock) {
      this.setData({ error: '请先在安装页面退出安装模式' });
      return;
    }
    if (this.canOperateParameters()) void this.parameterService?.control(true);
  },
  clearLogs() {
    this.logEntries = [];
    this.queueLiveView({ logs: [] }, true);
  },
  copyLogs() {
    wx.setClipboardData({
      data: this.logEntries.map((log) => `${log.time} [${log.direction}] ${log.text}`).join('\n'),
      fail: () => this.setData({ error: '复制日志失败' }),
    });
  },
  toggleHelp() {
    this.setData({ helpOpen: !this.data.helpOpen });
  },
});
