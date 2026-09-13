export interface ControlState {
  speed: number;
  turn: number;
  roll: number;
  height: number;
}

export interface DeviceProfile {
  id: string;
  name: string;
  supported: boolean;
  intervalMs: number;
  initial: ControlState;
  normalize(input: ControlState): ControlState;
  encode(input: ControlState): string;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) throw new Error('控制参数必须为有限数值');
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeWl1(input: ControlState): ControlState {
  return {
    speed: Math.round(clamp(input.speed, -100, 100)),
    turn: Math.round(clamp(input.turn, -100, 100)),
    roll: Math.round(clamp(input.roll, -18, 18)),
    height: Math.round(clamp(input.height, 44.5, 78.5) * 10) / 10,
  };
}

export function encodeWl1(input: ControlState): string {
  const state = normalizeWl1(input);
  // UART idle delimits frames. No LF: worst case is exactly 20 ASCII bytes.
  // Speed sign follows tele_firmware; car parser accepts integer float tokens.
  const frame = `R ${state.turn} ${-state.speed || 0} ${state.roll} ${state.height.toFixed(1)}`;
  if (frame.length > 20) throw new Error('遥控帧超过单包长度');
  return frame;
}

export function encodeWl1SoftEngine(input: ControlState): string {
  return `@${encodeWl1(input)}\n`;
}

export const wl1Main: DeviceProfile = {
  id: 'wl1-main',
  name: 'WL1 · main',
  supported: true,
  intervalMs: 100,
  initial: { speed: 0, turn: 0, roll: 0, height: 44.5 },
  normalize: normalizeWl1,
  encode: encodeWl1,
};

/** New products supply a profile; transport and scheduling remain independent. */
export const deviceProfiles: readonly DeviceProfile[] = [
  wl1Main,
  {
    ...wl1Main,
    id: 'wl1-softengine',
    name: 'WL1 · SoftEngine',
    supported: true,
    encode: encodeWl1SoftEngine,
  },
];

export function neutral(input: ControlState): ControlState {
  return { ...input, speed: 0, turn: 0, roll: 0 };
}

export function joystickVector(
  x: number,
  y: number,
  limit: number,
): { speed: number; turn: number } {
  const magnitude = Math.sqrt(x * x + y * y);
  if (!Number.isFinite(magnitude) || magnitude < 0.12) return { speed: 0, turn: 0 };
  const scale = (Math.min(1, magnitude) - 0.12) / 0.88;
  const cap = clamp(limit, 0, 100);
  return {
    speed: Math.round((-y / magnitude) * scale * cap),
    turn: Math.round((x / magnitude) * scale * cap),
  };
}

/** Relative height avoids a sudden leg jump when the right stick is first touched. */
export function legJoystickVector(
  x: number,
  y: number,
  anchorHeight: number,
): { height: number; roll: number } {
  const axis = (value: number): number => {
    const bounded = clamp(value, -1, 1);
    return Math.abs(bounded) <= 0.12 ? 0 : (Math.sign(bounded) * (Math.abs(bounded) - 0.12)) / 0.88;
  };
  return {
    height: Math.round(clamp(anchorHeight - axis(y) * 17, 44.5, 78.5) * 10) / 10,
    roll: Math.round(axis(x) * 18) || 0,
  };
}
