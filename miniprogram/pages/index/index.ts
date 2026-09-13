import { RemoteController } from '../../control/controller';
import { deviceProfiles, joystickVector, legJoystickVector, wl1Main } from '../../devices/profiles';
import { parseTuningValue, tuningGroups } from '../../devices/tuning';
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
const panelSettingsKey = 'wl1-control-panel-v1';
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
    control: { ...wl1Main.initial },
    speedModes: ['标准 · 60 RPM', '全量程 · 100 RPM', '超级模式 · 150 RPM'],
    speedModeIndex: 1,
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
    panelModeIndex: 0,
    tuningGroupIndex: 0,
    tuningGroups: createTuningGroups(wl1Main.id),
    tuningBusy: '',
    tuningMessage: '',
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
  tuningEpoch: 0,

  onLoad() {
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
        if (ready !== this.data.ready || ble.deviceId !== this.data.ble.deviceId)
          this.resetTuning();
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
      this.resetTuning();
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
      this.addLog('INFO', '控制已启用。摇杆握持不限时；松手归零，腿高保持。');
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
      [60, 100, 150][this.data.speedModeIndex],
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
      this.resetTuning();
    });
  },

  resetTuning() {
    this.tuningEpoch += 1;
    this.setData({
      tuningGroups: createTuningGroups(deviceProfiles[this.data.profileIndex].id),
      tuningBusy: '',
      tuningMessage: '',
    });
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
    if (!parameter || parameter.unavailable || this.data.tuningBusy === id) return;
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
  restoreAutoAngleKp() {
    void this.performTuning('angle-auto', () => this.controller!.restoreAutoAngleKp());
  },
  async performTuning(id: string, action: () => Promise<void>) {
    if (
      this.destroyed ||
      !this.visible ||
      this.data.busy ||
      this.data.tuningBusy ||
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
