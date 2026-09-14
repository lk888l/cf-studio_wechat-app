export interface TuningParameter {
  id: string;
  label: string;
  command: string;
  minimum: number;
  maximum: number;
  step: number;
  digits: number;
  initial: number;
  unavailable: string;
}

export interface TuningGroup {
  id: string;
  name: string;
  note: string;
  parameters: TuningParameter[];
}

function parameter(
  id: string,
  label: string,
  command: string,
  minimum: number,
  maximum: number,
  step: number,
  digits: number,
  initial: number,
  unavailable = '',
): TuningParameter {
  return { id, label, command, minimum, maximum, step, digits, initial, unavailable };
}

/** Audited main 9b58e9e and SoftEngine 0677c64; bounds reference VOFA, not MCU limits. */
export function tuningGroups(profileId: string): TuningGroup[] {
  if (!['wl1-main', 'wl1-softengine'].includes(profileId)) return [];
  const soft = profileId === 'wl1-softengine';
  return [
    {
      id: 'balance',
      name: '重心标定与电机输出死区',
      note: '俯仰偏置以最低腿高 44.5 mm 为基准；电机死区同时作用于左右轮，0 表示关闭补偿。调节前请架空车轮。',
      parameters: [
        parameter('angle-bias', '俯仰偏置 / °', 'anglebias', -20, 20, 0.1, 1, soft ? 7 : 12.6),
        parameter('motor-deadzone', '电机输出死区 / PWM', 'deadzone', 0, 1000, 1, 0, 0),
      ],
    },
    {
      id: 'angle',
      name: '俯仰环',
      note: soft
        ? '发送 Kp 后转为手动；可恢复随腿高自动计算。'
        : 'Kp 随腿高自动计算，手动写入会被覆盖；可调 Ki、Kd。',
      parameters: [
        parameter(
          'angle-p',
          '比例 Kp',
          'anglepid -p',
          0,
          150,
          0.1,
          1,
          70,
          soft ? '' : '固件自动计算',
        ),
        parameter('angle-i', '积分 Ki', 'anglepid -i', 0, 1, 0.1, 1, 0),
        parameter('angle-d', '微分 Kd', 'anglepid -d', -107, 100, 0.1, 1, 60),
      ],
    },
    {
      id: 'velocity',
      name: '速度环',
      note: '平均轮速 → 俯仰目标。滑块调节，输入框可精确填写。',
      parameters: [
        parameter('velocity-p', '比例 Kp', 'velocitypid -p', 0, 10, 0.01, 2, 0.05),
        parameter(
          'velocity-i',
          '积分 Ki',
          'velocitypid -i',
          0,
          soft ? 100 : 9.999,
          0.001,
          3,
          0.008,
        ),
        parameter('velocity-d', '微分 Kd', 'velocitypid -d', 0, 100, 0.01, 2, 0),
      ],
    },
    {
      id: 'difference',
      name: '转向环',
      note: '左右轮速差 → 差速输出。修改不会覆盖摇杆目标。',
      parameters: [
        parameter('difference-p', '比例 Kp', 'differpid -p', -50, 50, 0.1, 1, 2),
        parameter('difference-i', '积分 Ki', 'differpid -i', 0, 1, 0.001, 3, 0.001),
        parameter('difference-d', '微分 Kd', 'differpid -d', 0, 100, 0.1, 1, 0),
      ],
    },
    {
      id: 'roll',
      name: '横滚环',
      note: soft ? '横滚误差 → 左右腿高补偿。' : 'main 的 -p 误写 Ki，故仅开放正确的 Ki 接口。',
      parameters: [
        parameter(
          'roll-p',
          '比例 Kp',
          'rollpid -p',
          -100,
          100,
          0.1,
          1,
          0,
          soft ? '' : '当前固件不支持',
        ),
        parameter('roll-i', '积分 Ki', 'rollpid -i', -10, 10, 0.1, 1, -0.4),
        ...(soft ? [parameter('roll-d', '微分 Kd', 'rollpid -d', -100, 100, 0.1, 1, 0)] : []),
      ],
    },
  ];
}

export function parseTuningValue(parameter: TuningParameter, input: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(input.trim()))
    throw new Error('请输入完整的十进制数值');
  const value = Number(input);
  if (!Number.isFinite(value) || value < parameter.minimum || value > parameter.maximum)
    throw new Error(`${parameter.label} 范围为 ${parameter.minimum}～${parameter.maximum}`);
  const rounded = Number(value.toFixed(parameter.digits));
  if (rounded !== value) throw new Error(`${parameter.label} 最多保留 ${parameter.digits} 位小数`);
  return rounded;
}

export function encodeTuning(profileId: string, id: string, input: string): string {
  const parameter = tuningGroups(profileId)
    .flatMap((group) => group.parameters)
    .find((item) => item.id === id);
  if (!parameter) throw new Error('当前固件不支持此参数');
  if (parameter.unavailable) throw new Error(parameter.unavailable);
  const value = parseTuningValue(parameter, input);
  // Trim insignificant zeroes so even velocitypid fits one legacy GATT write.
  const command = `${parameter.command} ${value || 0}`;
  return frameTuning(profileId, command);
}

function frameTuning(profileId: string, command: string): string {
  if (profileId === 'wl1-softengine') return `@${command}\n`;
  if (profileId !== 'wl1-main' || command.length > 20) throw new Error('调参命令超出固件单包限制');
  return command;
}

export function encodeAutoAngleKp(profileId: string): string {
  if (profileId !== 'wl1-softengine') throw new Error('仅 SoftEngine 支持恢复自动 Kp');
  return frameTuning(profileId, 'anglepid -auto');
}
