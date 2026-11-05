/** Product navigation is separate from firmware/transport profiles. */
export interface Product {
  id: string;
  name: string;
  model: string;
  description: string;
  route: string;
  image: string;
  tags: readonly string[];
}

export const products: readonly Product[] = [
  {
    id: 'wl1',
    name: '轮腿小车',
    model: 'WL1',
    description: '轮式疾行，双腿随心。探索每一种移动可能。',
    route: '/pages/wl1/index',
    image: '/assets/products/wl1.png',
    tags: ['双摇杆遥控', '姿态调节', '运行调参'],
  },
];

export interface ProductPreferences {
  lastProductId: string;
  autoEnter: boolean;
}

const preferencesKey = 'cf-studio-products-v1';

export function getProduct(id: unknown): Product | null {
  return products.find((product) => product.id === id) ?? null;
}

export function readProductPreferences(): ProductPreferences {
  const defaults: ProductPreferences = { lastProductId: '', autoEnter: true };
  try {
    const stored: unknown = wx.getStorageSync(preferencesKey);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return defaults;
    const value = stored as Partial<ProductPreferences>;
    return {
      lastProductId: getProduct(value.lastProductId)?.id ?? '',
      autoEnter: typeof value.autoEnter === 'boolean' ? value.autoEnter : true,
    };
  } catch {
    // Unavailable storage must never prevent manual product selection.
    return defaults;
  }
}

function savePreferences(preferences: ProductPreferences): boolean {
  try {
    wx.setStorageSync(preferencesKey, preferences);
    return true;
  } catch {
    return false;
  }
}

export function rememberProduct(id: string): boolean {
  if (!getProduct(id)) return false;
  return savePreferences({ ...readProductPreferences(), lastProductId: id });
}

export function setAutoEnter(autoEnter: boolean): boolean {
  return savePreferences({ ...readProductPreferences(), autoEnter });
}
