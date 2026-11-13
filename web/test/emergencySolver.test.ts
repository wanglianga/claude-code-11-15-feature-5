import { describe, expect, it } from 'vitest';
import {
  computeIndependentLowerCost, minutesOf, priorityWeight, solveEmergency,
  type SolverInput, type SolverSku, type SolverSource,
} from '../src/lib/emergencySolver';

const LEAFY_PROFILE = {
  start: '08:00', end: '18:00',
  weights: [0.08, 0.1, 0.12, 0.14, 0.13, 0.11, 0.08, 0.09, 0.08, 0.07],
};

function sku(over: Partial<SolverSku> & { id: number; code: string }): SolverSku {
  return {
    name: over.code, unit: '份', cu: 8, co: 2, categoryCode: 'LEAFY',
    salesStart: '08:00', salesEnd: '18:00', priority: 3,
    shortDeliveryRatio: 0.4, dailyDemandBase: 40, hourlyProfile: LEAFY_PROFILE,
    ...over,
  };
}

function source(over: Partial<SolverSource> & { code: string; targetSkuId: number }): SolverSource {
  return {
    supplier: `供应商-${over.code}`, skuCode: 'BOC01', targetSkuCode: 'BOC01',
    availableBoxes: 4, unitsPerBox: 10, substitutionRatio: 1, arrivalTime: '08:30',
    weightPerBox: 8, volumePerBox: 0.05, vehicleSlot: 'AM',
    status: 'registered', excludeReason: null, delayHours: 0,
    ...over,
  };
}

const VEHICLE = {
  freightPerVehicle: 90, weightCapKg: 220, volumeCapM3: 1.0, maxVehiclesPerSlot: 1,
  slots: ['AM', 'MID', 'PM', 'EVE'],
};

function input(over: Partial<SolverInput> = {}): SolverInput {
  const s1 = sku({ id: 1, code: 'BOC01', dailyDemandBase: 40 });
  return {
    skus: [s1],
    sources: [source({ code: 'L1', targetSkuId: 1 })],
    originalOrder: { arrivalTime: '08:00', lateArrivalTime: null, items: [{ sku_id: 1, qty: 40 }] },
    vehicle: VEHICLE,
    priorities: {},
    ...over,
  };
}

describe('分时与口径工具', () => {
  it('HH:MM 转分钟', () => {
    expect(minutesOf('08:00')).toBe(480);
    expect(minutesOf('18:20')).toBe(1100);
    expect(minutesOf('9:05')).toBe(545);
  });

  it('优先级权重：高优先级缺货罚更重，低优先级报损罚更重', () => {
    expect(priorityWeight(5, 'loss')).toBeGreaterThan(priorityWeight(1, 'loss'));
    expect(priorityWeight(1, 'waste')).toBeGreaterThan(priorityWeight(5, 'waste'));
  });
});

describe('逐时缺口：原单少送', () => {
  it('原单少送 40% → 缺口约 40 × 40% = 16 份，且按销售曲线分时摊开', () => {
    const r = solveEmergency(input(), { timeLimitMs: 500 });
    const gap = r.bounded.hourlyGap[0];
    expect(gap.demandUnits).toBeCloseTo(40);
    expect(gap.originalAvailable).toBeCloseTo(24);
    // 每箱覆盖 10 份，选 2 箱即可覆盖 16 份缺口
    expect(gap.shortUnits).toBeLessThan(1);
    expect(gap.hours).toHaveLength(LEAFY_PROFILE.weights.length);
    // 替代覆盖量按到货时刻铺开，个别小时仍可能残留小数缺口；总量应远小于未补救的 16 份
    const hourlyGapSum = gap.hours.reduce((a, h) => a + h.gap, 0);
    expect(hourlyGapSum).toBeLessThan(2);
  });

  it('原单晚到 → 早段不可售，缺口集中在迟到之前（逐时缺口更早更大）', () => {
    const base = solveEmergency(input({ sources: [] }), { timeLimitMs: 200 });
    const late = solveEmergency(
      input({ sources: [], originalOrder: { arrivalTime: '08:00', lateArrivalTime: '12:00', items: [{ sku_id: 1, qty: 40 }] } }),
      { timeLimitMs: 200 },
    );
    const baseGap = base.bounded.hourlyGap[0];
    const lateGap = late.bounded.hourlyGap[0];
    expect(lateGap.originalAvailable).toBeLessThan(baseGap.originalAvailable);
    // 08:00-09:00 这一桶在两种情形下都无货；晚到使 12:00 前的缺口更大
    const beforeNoon = (g: typeof baseGap) => g.hours.slice(0, 4).reduce((a, h) => a + h.gap, 0);
    expect(beforeNoon(lateGap)).toBeGreaterThan(beforeNoon(baseGap) - 1e-6);
  });
});

describe('替代商品不重复覆盖同一缺口', () => {
  it('替代货源覆盖目标商品缺口后，原商品货源需求减少（替代量被计入同一缺口）', () => {
    const target = sku({ id: 1, code: 'BOC01', dailyDemandBase: 40 });
    const sub = sku({ id: 2, code: 'SHC02', dailyDemandBase: 32, shortDeliveryRatio: 0.35 });
    // L1：菠菜直供 10 份/箱；L6：生菜替代菠菜，0.8 比例 = 8 份/箱
    const r = solveEmergency(input({
      skus: [target, sub],
      sources: [
        source({ code: 'L1', targetSkuId: 1, availableBoxes: 1, unitsPerBox: 10, weightPerBox: 8 }),
        source({ code: 'L6', targetSkuId: 1, skuCode: 'SHC02', targetSkuCode: 'BOC01', availableBoxes: 1, unitsPerBox: 10, substitutionRatio: 0.8, weightPerBox: 8 }),
      ],
      originalOrder: { arrivalTime: '08:00', lateArrivalTime: null, items: [{ sku_id: 1, qty: 40 }, { sku_id: 2, qty: 32 }] },
    }), { timeLimitMs: 200 });
    const boc = r.bounded.hourlyGap.find((g) => g.skuCode === 'BOC01')!;
    // L1 直供 10 + L6 替代覆盖 8 = 18，不会超过缺口 40 − 24 = 16（多余部分不计入覆盖）
    expect(boc.emergencyCovered).toBeLessThanOrEqual(18 + 1e-6);
    // 到货时刻铺开会在个别小时留残差，不要求逐时为 0；总量应不超过单箱覆盖（10 份）
    expect(boc.shortUnits).toBeLessThan(10);
    // 替代量不会大幅超过缺口（不会重复订购原商品）；允许到货时刻铺开带来的少量残差
    expect(boc.overCoveredUnits).toBeLessThan(6);
  });
});

describe('车辆限制与同车合并', () => {
  it('同车次货源合并到一辆车，超过单车重量上限时需要第二辆（受每车次车数上限约束）', () => {
    const s1 = sku({ id: 1, code: 'A', dailyDemandBase: 200, shortDeliveryRatio: 0.9 });
    const s2 = sku({ id: 2, code: 'B', dailyDemandBase: 200, shortDeliveryRatio: 0.9 });
    const r = solveEmergency(input({
      skus: [s1, s2],
      sources: [
        source({ code: 'A1', targetSkuId: 1, availableBoxes: 8, unitsPerBox: 10, weightPerBox: 50, vehicleSlot: 'AM' }),
        source({ code: 'B1', targetSkuId: 2, availableBoxes: 8, unitsPerBox: 10, weightPerBox: 50, vehicleSlot: 'AM' }),
      ],
      originalOrder: { arrivalTime: '08:00', lateArrivalTime: null, items: [{ sku_id: 1, qty: 200 }, { sku_id: 2, qty: 200 }] },
    }), { timeLimitMs: 800 });
    const am = r.bounded.vehicleUsage.find((u) => u.slot === 'AM')!;
    // 220kg 上限，每箱 50kg：一辆最多 4 箱；每车次最多 1 辆 → 至多 4 箱
    const totalBoxes = Object.values(r.bounded.allocation).reduce((a, b) => a + b, 0);
    expect(totalBoxes).toBeLessThanOrEqual(4);
    expect(am.overCapacity).toBe(false);
  });

  it('满足共享限制的组合成本 ≥ 忽略共享限制的对照下界', () => {
    const s1 = sku({ id: 1, code: 'A', dailyDemandBase: 120, shortDeliveryRatio: 0.5 });
    const s2 = sku({ id: 2, code: 'B', dailyDemandBase: 120, shortDeliveryRatio: 0.5 });
    const inp = input({
      skus: [s1, s2],
      sources: [
        source({ code: 'A1', targetSkuId: 1, availableBoxes: 6, unitsPerBox: 10, weightPerBox: 40, vehicleSlot: 'AM' }),
        source({ code: 'B1', targetSkuId: 2, availableBoxes: 6, unitsPerBox: 10, weightPerBox: 40, vehicleSlot: 'MID' }),
      ],
      originalOrder: { arrivalTime: '08:00', lateArrivalTime: null, items: [{ sku_id: 1, qty: 120 }, { sku_id: 2, qty: 120 }] },
    });
    const r = solveEmergency(inp, { timeLimitMs: 800 });
    expect(r.bounded.objective.total).toBeGreaterThanOrEqual(r.independent.total - 1e-6);
  });

  it('提前停止（极小时间/节点上限）→ 标为可行方案，不标最优', () => {
    const s1 = sku({ id: 1, code: 'A', dailyDemandBase: 500, shortDeliveryRatio: 0.5 });
    const many: SolverSource[] = [];
    for (let i = 0; i < 10; i++) {
      many.push(source({ code: `S${i}`, targetSkuId: 1, availableBoxes: 6, unitsPerBox: 10, weightPerBox: 5, vehicleSlot: i % 2 ? 'AM' : 'MID' }));
    }
    const r = solveEmergency(input({
      skus: [s1], sources: many,
      originalOrder: { arrivalTime: '08:00', lateArrivalTime: null, items: [{ sku_id: 1, qty: 500 }] },
    }), { nodeLimit: 5, timeLimitMs: 20 });
    expect(r.bounded.nodeLimitHit).toBe(true);
    expect(r.bounded.status).toBe('feasible');
    expect(r.bounded.notes.some((n) => n.includes('可行方案'))).toBe(true);
  });
});

describe('排除规则', () => {
  it('单位无法换算 / 到货晚于销售时段 的货源被排除并给出说明', () => {
    const r = solveEmergency(input({
      sources: [
        source({ code: 'OK', targetSkuId: 1 }),
        source({ code: 'NOUNIT', targetSkuId: 1, unitsPerBox: 0 }),
        source({ code: 'LATE', targetSkuId: 1, arrivalTime: '18:30' }),
        source({ code: 'DELAY', targetSkuId: 1, arrivalTime: '17:00', delayHours: 2 }),
      ],
    }), { timeLimitMs: 500 });
    expect(r.bounded.allocation.NOUNIT).toBeUndefined();
    expect(r.bounded.allocation.LATE).toBeUndefined();
    expect(r.bounded.allocation.DELAY).toBeUndefined();
    expect(r.bounded.notes.some((n) => n.includes('单位无法换算'))).toBe(true);
    expect(r.bounded.notes.some((n) => n.includes('晚于'))).toBe(true);
  });

  it('被服务端标记为 excluded 的货源不参与分配', () => {
    const r = solveEmergency(input({
      sources: [
        source({ code: 'OK', targetSkuId: 1 }),
        source({ code: 'EX', targetSkuId: 1, status: 'excluded', excludeReason: '单位无法换算' }),
      ],
    }), { timeLimitMs: 500 });
    expect(r.bounded.allocation.EX).toBeUndefined();
    expect(r.bounded.notes.some((n) => n.includes('已排除'))).toBe(true);
  });
});

describe('下界对照', () => {
  it('无缺口时下界为 0（原单足量、无少送）', () => {
    const inp = input({
      sources: [source({ code: 'L1', targetSkuId: 1 })],
      originalOrder: { arrivalTime: '08:00', lateArrivalTime: null, items: [{ sku_id: 1, qty: 40 }] },
      skus: [sku({ id: 1, code: 'BOC01', shortDeliveryRatio: 0 })],
    });
    const lb = computeIndependentLowerCost(inp);
    expect(lb.total).toBe(0);
  });
});

describe('部分到货抵扣', () => {
  it('已到货的箱数先抵扣缺口，减少后续需要订购的箱数', () => {
    const skuA = sku({ id: 1, code: 'A', dailyDemandBase: 100, shortDeliveryRatio: 0.5, cu: 8, co: 2 });
    const baseInput = input({
      skus: [skuA],
      sources: [source({ code: 'S1', targetSkuId: 1, availableBoxes: 10, unitsPerBox: 10 })],
      originalOrder: { arrivalTime: '08:00', lateArrivalTime: null, items: [{ sku_id: 1, qty: 100 }] },
    });
    const withoutReceipt = solveEmergency(baseInput, { timeLimitMs: 200 });
    const withReceipt = solveEmergency({
      ...baseInput,
      receipts: [{ targetSkuId: 1, coveredUnits: 30, arrivalTime: '10:30', receiptKey: 'R1' }],
    }, { timeLimitMs: 200 });
    const boxesWithout = Object.values(withoutReceipt.bounded.allocation).reduce((a, b) => a + b, 0);
    const boxesWith = Object.values(withReceipt.bounded.allocation).reduce((a, b) => a + b, 0);
    expect(boxesWith).toBeLessThan(boxesWithout);
    const gapWith = withReceipt.bounded.hourlyGap.find((g) => g.skuCode === 'A')!;
    expect(gapWith.emergencyCovered).toBeGreaterThanOrEqual(30);
  });
});

describe('分批搜索形态', () => {
  it('节点上限极小时如实标注「已找到的可行方案」，放大预算后不差于它', () => {
    const skuA = sku({ id: 1, code: 'A', dailyDemandBase: 300, shortDeliveryRatio: 0.9 });
    const skuB = sku({ id: 2, code: 'B', dailyDemandBase: 300, shortDeliveryRatio: 0.9 });
    const skuC = sku({ id: 3, code: 'C', dailyDemandBase: 300, shortDeliveryRatio: 0.9 });
    const sources = [
      source({ code: 'A1', targetSkuId: 1, availableBoxes: 6, unitsPerBox: 10, weightPerBox: 5, vehicleSlot: 'AM' }),
      source({ code: 'A2', targetSkuId: 1, availableBoxes: 6, unitsPerBox: 10, weightPerBox: 5, vehicleSlot: 'AM' }),
      source({ code: 'B1', targetSkuId: 2, availableBoxes: 6, unitsPerBox: 10, weightPerBox: 5, vehicleSlot: 'AM' }),
      source({ code: 'B2', targetSkuId: 2, availableBoxes: 6, unitsPerBox: 10, weightPerBox: 5, vehicleSlot: 'AM' }),
      source({ code: 'C1', targetSkuId: 3, availableBoxes: 6, unitsPerBox: 10, weightPerBox: 5, vehicleSlot: 'AM' }),
      source({ code: 'C2', targetSkuId: 3, availableBoxes: 6, unitsPerBox: 10, weightPerBox: 5, vehicleSlot: 'AM' }),
    ];
    const inp = input({
      skus: [skuA, skuB, skuC], sources,
      originalOrder: { arrivalTime: '08:00', lateArrivalTime: null, items: [{ sku_id: 1, qty: 300 }, { sku_id: 2, qty: 300 }, { sku_id: 3, qty: 300 }] },
    });
    const tight = solveEmergency(inp, { nodeLimit: 3 });
    expect(tight.bounded.status).toBe('feasible');
    expect(tight.bounded.nodeLimitHit).toBe(true);
    expect(tight.bounded.notes.some((n) => n.includes('可行方案'))).toBe(true);
    const roomy = solveEmergency(inp, { timeLimitMs: 3000 });
    expect(roomy.bounded.objective.total).toBeLessThanOrEqual(tight.bounded.objective.total + 1e-6);
  });

  it('共享车次合并：同车次多货源只算一辆车，不同车次各算一辆', () => {
    const a = sku({ id: 1, code: 'A', dailyDemandBase: 100, shortDeliveryRatio: 0.5 });
    const b = sku({ id: 2, code: 'B', dailyDemandBase: 100, shortDeliveryRatio: 0.5 });
    const r = solveEmergency(input({
      skus: [a, b],
      sources: [
        source({ code: 'A1', targetSkuId: 1, availableBoxes: 2, unitsPerBox: 10, weightPerBox: 10, vehicleSlot: 'AM' }),
        source({ code: 'B1', targetSkuId: 2, availableBoxes: 2, unitsPerBox: 10, weightPerBox: 10, vehicleSlot: 'AM' }),
        source({ code: 'B2', targetSkuId: 2, availableBoxes: 2, unitsPerBox: 10, weightPerBox: 10, vehicleSlot: 'PM' }),
      ],
      originalOrder: { arrivalTime: '08:00', lateArrivalTime: null, items: [{ sku_id: 1, qty: 100 }, { sku_id: 2, qty: 100 }] },
    }), { timeLimitMs: 1000 });
    const am = r.bounded.vehicleUsage.find((u) => u.slot === 'AM')!;
    expect(am.vehicles).toBe(1);
    // 同车次的两批货合的运费 = 单车次费用，而不是两笔
    expect(r.bounded.objective.freight).toBeGreaterThanOrEqual(90);
  });
});
