import { RemoteController } from '../../control/controller';
import { deviceProfiles, joystickVector, legJoystickVector, wl1Main } from '../../devices/profiles';
import { onBackground } from '../../services/lifecycle';
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
type ValueEvent = WechatMiniprogram.CustomEvent<{ value: string | number }>;
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
    control: { ...wl1Main.initial },
    speedModes: ['精细 · 30 RPM', '标准 · 60 RPM', '全量程 · 100 RPM'],
    speedModeIndex: 0,
    knobX: 0,
    knobY: 0,
    legKnobX: 0,
    legKnobY: 0,
    lastFrame: '',
    sentCount: 0,
    lastReceive: '',
    lastReceiveAt: '',
    receiveCount: 0,
    error: '',
    logs: [] as LogEntry[],
    helpOpen: false,
    profileNames: ['WL1 · main（已适配）', 'WL1 · SoftEngine（串口适配）'],
    profileIndex: 0,
  },
  transport: null as BleTransport | null,
  controller: null as RemoteController | null,
  subscriptions: [] as Array<() => void>,
  touchId: null as number | null,
  joystickRect: null as JoystickRect | null,
  legTouchId: null as number | null,
  legJoystickRect: null as JoystickRect | null,
  legHeightAnchor: wl1Main.initial.height,
  motionGesture: 0,
  legGesture: 0,
  visible: true,
  destroyed: false,
  logId: 0,
  suspension: null as Promise<void> | null,

  onLoad() {
    this.transport = new BleTransport();
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
        this.setData({ ...state });
        if (!state.motionHolding) {
          this.touchId = null;
          this.motionGesture += 1;
          this.setData({ knobX: 0, knobY: 0 });
        }
        if (!state.poseHolding) {
          this.legTouchId = null;
          this.legGesture += 1;
          this.setData({ legKnobX: 0, legKnobY: 0 });
        }
      }),
    );
    this.subscriptions.push(
      this.transport.subscribe((ble) => {
        if (this.destroyed) return;
        const ready =
          this.visible &&
          deviceProfiles[this.data.profileIndex].supported &&
          (this.data.demo || ble.status === 'ready');
        if (ble.deviceId !== this.data.ble.deviceId) {
          this.setData({ lastReceive: '', lastReceiveAt: '', receiveCount: 0 });
        }
        this.setData({
          ble,
          ready,
          statusLabel: this.data.demo ? '模拟演练' : statusLabels[ble.status],
        });
        this.controller?.setReady(ready);
        if (ble.error) this.setData({ error: ble.error });
      }),
    );
    this.subscriptions.push(
      this.transport.onReceive((text) => {
        if (this.destroyed || this.data.demo) return;
        this.setData({
          lastReceive: text.slice(0, 256),
          lastReceiveAt: new Date().toTimeString().slice(0, 8),
          receiveCount: this.data.receiveCount + 1,
        });
        this.addLog('RX', text);
      }),
    );
    this.subscriptions.push(
      onBackground(() => {
        void this.suspend();
      }),
    );
    this.addLog('INFO', 'WL1 main · 待连接。模拟演练不会向设备发送数据。');
  },

  onShow() {
    this.visible = true;
    if (this.data.demo && !this.suspension) {
      const ready = deviceProfiles[this.data.profileIndex].supported;
      this.controller?.setReady(ready);
      this.setData({ ready });
    }
  },

  onHide() {
    void this.suspend();
  },

  onUnload() {
    const shutdown = this.suspend();
    this.destroyed = true;
    this.subscriptions.forEach((unsubscribe) => unsubscribe());
    this.subscriptions = [];
    void shutdown.finally(() => {
      this.controller?.dispose();
      void this.transport?.dispose().catch(() => undefined);
    });
  },

  onResize() {
    this.releaseJoysticks();
    this.joystickRect = null;
    this.legJoystickRect = null;
  },

  async suspend(): Promise<void> {
    if (this.suspension) return this.suspension;
    this.visible = false;
    this.clearJoysticks();
    this.setData({ busy: true });
    const work = async (): Promise<void> => {
      await this.controller?.stop();
      await this.transport?.disconnect();
      this.controller?.setReady(false);
    };
    this.suspension = work()
      .catch((error) => {
        if (!this.destroyed)
          this.setData({ error: error instanceof Error ? error.message : '断开失败，请检查设备' });
      })
      .finally(() => {
        this.suspension = null;
        if (!this.destroyed) {
          const ready =
            this.visible && this.data.demo && deviceProfiles[this.data.profileIndex].supported;
          this.controller?.setReady(ready);
          this.setData({ busy: false, ready });
        }
      });
    return this.suspension;
  },

  async perform(action: () => Promise<void>): Promise<void> {
    if (this.data.busy || this.destroyed || !this.visible) return;
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

  addLog(direction: string, text: string) {
    if (this.destroyed) return;
    const time = new Date().toTimeString().slice(0, 8);
    const entry = { id: ++this.logId, time, direction, text: text.slice(0, 256) };
    this.setData({ logs: [entry, ...this.data.logs].slice(0, 60) });
  },

  switchTab(event: WechatMiniprogram.BaseEvent) {
    this.releaseJoysticks();
    const tab = String(event.currentTarget.dataset.tab);
    if (['control', 'connection', 'console'].includes(tab)) {
      if (tab !== 'control') void this.controller?.stop();
      this.setData({ tab });
    }
  },

  toggleDemo() {
    void this.perform(async () => {
      await this.controller?.stop();
      await this.transport?.disconnect();
      this.controller?.setReady(false);
      if (!this.visible || this.destroyed) return;
      const demo = !this.data.demo;
      const ready = demo && deviceProfiles[this.data.profileIndex].supported;
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
      await this.transport?.selectEndpoint(endpoint);
      this.addLog('INFO', `串口通道 ${endpoint.writeId}；写入成功不代表车端已执行。`);
    });
  },

  toggleArmed() {
    if (this.data.busy || !this.data.ready || !this.visible) return;
    if (this.data.armed) {
      void this.controller?.stop();
      return;
    }
    try {
      this.controller?.arm();
      this.addLog('INFO', '控制已启用。单次握持最多 5 秒；松手归零，腿高保持。');
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : '无法启用控制' });
    }
  },
  stopMotion() {
    this.clearJoysticks();
    void this.controller?.stop();
  },

  clearJoysticks() {
    this.touchId = null;
    this.legTouchId = null;
    this.motionGesture += 1;
    this.legGesture += 1;
    this.joystickRect = null;
    this.legJoystickRect = null;
    this.setData({ knobX: 0, knobY: 0, legKnobX: 0, legKnobY: 0 });
  },

  releaseJoysticks() {
    this.clearJoysticks();
    this.controller?.release();
  },

  onJoystickStart(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.armed || this.touchId !== null || !event.changedTouches.length) return;
    const touch = event.changedTouches[0];
    if (touch.identifier === this.legTouchId) return;
    this.touchId = touch.identifier;
    this.joystickRect = null;
    this.controller?.beginHold();
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
        this.joystickRect = rect;
        this.updateJoystick(touch);
      })
      .exec();
  },
  onJoystickMove(event: WechatMiniprogram.TouchEvent) {
    const touch = event.touches.find((item) => item.identifier === this.touchId);
    if (touch) this.updateJoystick(touch);
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
      [30, 60, 100][this.data.speedModeIndex],
    );
    this.setData({ knobX: Math.round(x), knobY: Math.round(y) });
    this.controller?.move(speed, turn);
  },
  onJoystickEnd(event?: WechatMiniprogram.TouchEvent) {
    if (event && !event.changedTouches.some((touch) => touch.identifier === this.touchId)) return;
    this.touchId = null;
    this.motionGesture += 1;
    this.joystickRect = null;
    this.setData({ knobX: 0, knobY: 0 });
    this.controller?.releaseMotion();
  },
  onLegJoystickStart(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.armed || this.legTouchId !== null || !event.changedTouches.length) return;
    const touch = event.changedTouches[0];
    if (touch.identifier === this.touchId) return;
    this.legTouchId = touch.identifier;
    this.legJoystickRect = null;
    this.legHeightAnchor = this.data.control.height;
    this.controller?.beginPoseHold();
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
        this.legJoystickRect = rect;
        this.updateLegJoystick(touch);
      })
      .exec();
  },
  onLegJoystickMove(event: WechatMiniprogram.TouchEvent) {
    const touch = event.touches.find((item) => item.identifier === this.legTouchId);
    if (touch) this.updateLegJoystick(touch);
  },
  updateLegJoystick(touch: WechatMiniprogram.TouchDetail) {
    const rect = this.legJoystickRect;
    if (!rect || !this.data.armed || !rect.width || !rect.height) return;
    const { x, y, radius } = this.stickOffset(rect, touch);
    const { height, roll } = legJoystickVector(x / radius, y / radius, this.legHeightAnchor);
    this.setData({ legKnobX: Math.round(x), legKnobY: Math.round(y) });
    this.controller?.movePose(height, roll);
  },
  onLegJoystickEnd(event?: WechatMiniprogram.TouchEvent) {
    if (event && !event.changedTouches.some((touch) => touch.identifier === this.legTouchId))
      return;
    this.legTouchId = null;
    this.legGesture += 1;
    this.legJoystickRect = null;
    this.setData({ legKnobX: 0, legKnobY: 0 });
    this.controller?.releasePose();
  },
  onSpeedModeChange(event: ValueEvent) {
    this.onJoystickEnd();
    const index = Number(event.detail.value);
    if (index >= 0 && index <= 2 && Number.isInteger(index))
      this.setData({ speedModeIndex: index });
  },
  onHeightChange(event: ValueEvent) {
    this.controller?.pose(Number(event.detail.value) / 10, this.data.control.roll);
  },
  onRollChange(event: ValueEvent) {
    this.controller?.pose(this.data.control.height, Number(event.detail.value));
  },
  resetPose() {
    this.onLegJoystickEnd();
    this.controller?.pose(wl1Main.initial.height, 0);
  },
  onProfileChange(event: ValueEvent) {
    const index = Number(event.detail.value);
    if (!deviceProfiles[index] || this.data.busy) return;
    void this.perform(async () => {
      await this.controller?.stop();
      if (!this.visible || this.destroyed) return;
      this.controller?.setProfile(deviceProfiles[index]);
      const ready =
        deviceProfiles[index].supported && (this.data.demo || this.data.ble.status === 'ready');
      this.controller?.setReady(ready);
      this.setData({
        profileIndex: index,
        ready,
        error: '',
      });
    });
  },
  clearLogs() {
    this.setData({ logs: [] });
  },
  copyLogs() {
    wx.setClipboardData({
      data: this.data.logs.map((log) => `${log.time} [${log.direction}] ${log.text}`).join('\n'),
      fail: () => this.setData({ error: '复制日志失败' }),
    });
  },
  toggleHelp() {
    this.setData({ helpOpen: !this.data.helpOpen });
  },
});
