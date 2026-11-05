import {
  getProduct,
  products,
  readProductPreferences,
  setAutoEnter,
} from '../../services/products';

Page({
  data: {
    products,
    lastProductId: '',
    autoEnter: true,
    openingId: '',
    error: '',
    storageNotice: '',
  },
  visible: true,
  destroyed: false,
  pendingProductId: '',
  navigationEpoch: 0,

  onLoad(options: Record<string, string | undefined> = {}) {
    const preferences = readProductPreferences();
    this.setData(preferences);
    // Explicit switching must stay on the chooser, even with memory enabled.
    if (options.choose !== '1' && preferences.autoEnter && preferences.lastProductId) {
      this.enterProduct(preferences.lastProductId);
    }
  },

  onShow() {
    this.visible = true;
    if (!this.pendingProductId) this.setData({ openingId: '' });
  },

  onHide() {
    this.visible = false;
    this.navigationEpoch += 1;
    this.pendingProductId = '';
  },

  onUnload() {
    this.onHide();
    this.destroyed = true;
  },

  openProduct(event: WechatMiniprogram.BaseEvent) {
    const product = getProduct(event.currentTarget.dataset.id);
    if (product) this.enterProduct(product.id);
  },

  enterProduct(id: string) {
    const product = getProduct(id);
    if (!product || this.pendingProductId || !this.visible || this.destroyed) return;
    this.pendingProductId = id;
    const epoch = ++this.navigationEpoch;
    this.setData({ openingId: id, error: '' });
    const failed = () => {
      if (epoch !== this.navigationEpoch) return;
      this.pendingProductId = '';
      if (!this.visible || this.destroyed) return;
      this.setData({ openingId: '', error: '暂时无法打开遥控台，请点击卡片重试。' });
    };
    try {
      wx.redirectTo({ url: product.route, fail: failed });
    } catch {
      failed();
    }
  },

  toggleAutoEnter(event: WechatMiniprogram.CustomEvent<{ value: boolean }>) {
    if (!this.visible || this.destroyed || this.pendingProductId) return;
    const autoEnter = event.detail.value;
    if (setAutoEnter(autoEnter)) {
      this.setData({ autoEnter, storageNotice: '' });
    } else {
      this.setData({
        autoEnter: this.data.autoEnter,
        storageNotice: '偏好未能保存，请稍后重试。仍可正常选择产品。',
      });
    }
  },
});
