/**
 * 配送异常应急订货：浏览器端组合搜索 + 资源占用核对（不依赖任何预写推荐结果）。
 *
 * 计算口径：
 * 1. 分时需求：页面读取的分时需求按品类曲线摊到各销售小时（日总量 = 到货日建议量 / 还原需求中位）；
 * 2. 原确认订单少送：(1 − 少送比例) 的货会到；原单晚到时只有迟到时刻之后可售；
 * 3. 逐时缺口 = 该小时需求 − 该小时可用量（原单 + 应急货源 + 已到货回执，按各自到货时刻铺开）；
 * 4. 货源按整箱分配：一箱可覆盖的份数 = 每箱份数 × 替代比例；
 *    替代货源覆盖的是「目标商品」的缺口，同一缺口不会被原商品与替代货源重复计数；
 * 5. 同一批货不能同时分给两个方案：方案本身是一组货源箱数决策，每箱只出现一次；
 * 6. 共享车辆限制：每个车次（AM/MID/PM/EVE）最多 maxVehiclesPerSlot 辆，单车重量与冷藏容积上限；
 *    同车次货源合并装车，超过单车容量才加车（并受车数上限约束）。
 *
 * 目标 = 缺货损失（按商品优先级加权）× Cu + 剩余鲜货报损 × Co + 同车合并后的车次运费。
 * 「逐件挑最便宜」很快，但各单品各自最优会争用同一车次；这里分批（按到达车次）搜索
 * 满足共享货量与车辆限制的组合。搜索因节点/时间上限提前停止时只能称为「已找到的可行方案」。
 */

export interface SolverSku {
  id: number; code: string; name: string; unit: string;
  cu: number; co: number; categoryCode: string;
  salesStart: string; salesEnd: string; priority: number;
  shortDeliveryRatio: number; dailyDemandBase: number; demandSource?: string;
  hourlyProfile: { start: string; end: string; weights: number[] };
}

export interface SolverSource {
  code: string; supplier: string; skuCode: string; targetSkuCode: string; targetSkuId: number;
  availableBoxes: number; unitsPerBox: number; substitutionRatio: number; arrivalTime: string;
  weightPerBox: number; volumePerBox: number; vehicleSlot: string;
  status: string; excludeReason: string | null; delayHours: number; unitCost?: number;
}

export interface SolverReceipt {
  targetSkuId: number; coveredUnits: number; arrivalTime: string; receiptKey: string;
}

export interface SolverVehicle {
  freightPerVehicle: number; weightCapKg: number; volumeCapM3: number;
  maxVehiclesPerSlot: number; slots: string[];
}

export interface SolverInput {
  skus: SolverSku[];
  sources: SolverSource[];
  /** 已部分到货的货量：先抵扣对应缺口，其余保留待补（不占本次车次） */
  receipts?: SolverReceipt[];
  originalOrder: null | {
    arrivalTime: string; lateArrivalTime: string | null;
    items: { sku_id: number; qty: number }[];
  };
  vehicle: SolverVehicle;
  priorities: Record<string, number>;
}

export interface SolveOptions {
  nodeLimit?: number;
  timeLimitMs?: number;
}

export interface VehicleSlotUsage {
  slot: string; vehicles: number; weightKg: number; volumeM3: number;
  freight: number; overCapacity: boolean;
}

export interface EmergencyHourGap {
  hour: number; label: string; demand: number; covered: number; gap: number;
}

export interface EmergencySkuGap {
  skuId: number; skuCode: string; skuName: string; priority: number;
  demandUnits: number; originalAvailable: number; emergencyCovered: number;
  coveredUnits: number; shortUnits: number; overCoveredUnits: number;
  stockoutLoss: number; wasteLoss: number; hours: EmergencyHourGap[];
}

export interface SolveResult {
  kind: 'bounded' | 'lower_bound';
  status: 'optimal' | 'feasible' | 'lower_bound';
  allocation: Record<string, number>;
  objective: {
    total: number; stockoutLoss: number; wasteLoss: number; freight: number;
    stockoutUnits: number; heavyGapUnits: number;
  };
  hourlyGap: EmergencySkuGap[];
  vehicleUsage: VehicleSlotUsage[];
  iterations: number; elapsedMs: number; nodeLimitHit: boolean;
  notes: string[];
}

const EPS = 1e-9;

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((x) => Number(x));
  return (h || 0) * 60 + (m || 0);
}
function fmtHour(min: number): string {
  const h = Math.floor(min / 60);
  return `${String(h).padStart(2, '0')}:00`;
}
function round2(n: number): number { return Math.round(n * 100) / 100; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }

export function priorityWeight(priority: number, direction: 'loss' | 'waste'): number {
  const p = Math.max(1, Math.min(5, priority));
  // 缺货损失：高优先级罚得更重；报损：低优先级货更不该压库
  return direction === 'loss' ? 1 + (p - 3) * 0.15 : Math.max(0.6, 1 + (3 - p) * 0.1);
}

interface HourBucket { startMin: number; endMin: number; label: string; weight: number }

function hourBuckets(profile: { start: string; end: string; weights: number[] }): HourBucket[] {
  const startMin = minutesOf(profile.start);
  const endMin = minutesOf(profile.end);
  const span = Math.max(60, endMin - startMin);
  const n = profile.weights.length > 0 ? profile.weights.length : Math.round(span / 60);
  const weights = profile.weights.length > 0 ? profile.weights : Array.from({ length: n }, () => 1);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const buckets: HourBucket[] = [];
  for (let i = 0; i < n; i++) {
    const s = startMin + (i * span) / n;
    const e = startMin + ((i + 1) * span) / n;
    buckets.push({ startMin: s, endMin: e, label: `${fmtHour(s)}-${fmtHour(e)}`, weight: weights[i] / sum });
  }
  return buckets;
}

/** 到货时刻之前不可售；把 units 按各桶可售权重铺开 */
function spread(arrivalMin: number, units: number, buckets: HourBucket[]): number[] {
  const out = buckets.map(() => 0);
  if (units <= 0 || buckets.length === 0) return out;
  const eligible = buckets.map((b) => {
    if (arrivalMin <= b.startMin) return b.weight;
    if (arrivalMin >= b.endMin) return 0;
    return b.weight * (b.endMin - arrivalMin) / (b.endMin - b.startMin);
  });
  const sum = eligible.reduce((a, b) => a + b, 0);
  if (sum <= 0) { out[out.length - 1] = units; return out; }
  for (let i = 0; i < buckets.length; i++) out[i] = (units * eligible[i]) / sum;
  return out;
}

interface Candidate {
  code: string;
  skuId: number;
  covPerBox: number;  // 每箱覆盖份数 = 每箱份数 × 替代比例
  weightPerBox: number;
  volumePerBox: number;
  slot: string;
  arrivalMin: number;
  maxBoxes: number;   // min(可供箱数, 覆盖该 SKU 缺口所需的箱数上限)
  /** 每箱边际价值密度（用于搜索排序） */
  valueDensity: number;
}

interface Prep {
  candidates: Candidate[];
  buckets: Map<number, HourBucket[]>;
  demand: Map<number, number>;
  origUnits: Map<number, number>;
  origArrival: Map<number, number>;
  receipts: { skuId: number; units: number; arrivalMin: number }[];
  notes: string[];
}

function prepare(input: SolverInput): Prep {
  const notes: string[] = [];
  const buckets = new Map<number, HourBucket[]>();
  const demand = new Map<number, number>();
  const origUnits = new Map<number, number>();
  const origArrival = new Map<number, number>();

  const late = input.originalOrder?.lateArrivalTime ?? null;
  for (const s of input.skus) {
    const bs = hourBuckets(s.hourlyProfile);
    buckets.set(s.id, bs);
    const item = input.originalOrder?.items.find((i) => i.sku_id === s.id);
    const orderedQty = item ? Number(item.qty) : 0;
    const d = Math.max(0, Number(s.dailyDemandBase) || 0);
    demand.set(s.id, d);
    const baseArrival = minutesOf(s.salesStart);
    const arr = late ? Math.max(baseArrival, minutesOf(late)) : baseArrival;
    origArrival.set(s.id, arr);
    const ratio = Math.min(1, Math.max(0, Number(s.shortDeliveryRatio)));
    // 原单实际到货 = 订货量 × (1 − 少送比例)；晚到部分只在其后的时段可售
    const delivered = orderedQty * (1 - ratio);
    const end = minutesOf(s.salesEnd);
    let usable = 0;
    for (const b of bs) {
      if (arr <= b.startMin) usable += b.weight;
      else if (arr < b.endMin) usable += b.weight * (b.endMin - arr) / (b.endMin - b.startMin);
    }
    origUnits.set(s.id, arr >= end ? 0 : delivered * usable);
    if (ratio > 0 && orderedQty > 0) {
      notes.push(`${s.name}：原单 ${orderedQty}${s.unit} 少送 ${Math.round(ratio * 100)}%，实际到货约 ${Math.round(delivered * 10) / 10}${s.unit}`);
    }
  }

  const receipts: Prep['receipts'] = [];
  for (const r of input.receipts ?? []) {
    const sku = input.skus.find((s) => s.id === r.targetSkuId);
    if (!sku || r.coveredUnits <= 0) continue;
    receipts.push({ skuId: r.targetSkuId, units: r.coveredUnits, arrivalMin: minutesOf(r.arrivalTime) });
  }

  const candidates: Candidate[] = [];
  for (const src of input.sources) {
    const target = input.skus.find((s) => s.id === src.targetSkuId);
    if (!target) continue;
    if (src.status === 'excluded') {
      notes.push(`货源 ${src.code}（${src.supplier}）已排除：${src.excludeReason ?? '不满足登记规则'}`);
      continue;
    }
    if (!Number.isFinite(src.unitsPerBox) || src.unitsPerBox <= 0) {
      notes.push(`货源 ${src.code} 单位无法换算，已排除`);
      continue;
    }
    if (src.availableBoxes <= 0) continue;
    const arrivalMin = minutesOf(src.arrivalTime) + Math.round(Number(src.delayHours) * 60);
    if (arrivalMin >= minutesOf(target.salesEnd)) {
      notes.push(`货源 ${src.code} 到货 ${src.arrivalTime}（含延误 ${src.delayHours}h）晚于 ${target.name} 销售时段，已排除`);
      continue;
    }
    const covPerBox = src.unitsPerBox * Math.max(0, src.substitutionRatio);
    if (covPerBox <= 0) {
      notes.push(`货源 ${src.code} 替代比例为 0，覆盖 0 份需求，已排除`);
      continue;
    }
    const need = Math.max(0, (demand.get(target.id) ?? 0) - (origUnits.get(target.id) ?? 0));
    // 多订一箱超出缺口只会增加报损，因此每货源箱数上限 = ceil(需要份数 / 每箱覆盖)
    const usefulBoxes = need > 0 ? Math.ceil(need / covPerBox) : 0;
    const maxBoxes = Math.min(Math.floor(src.availableBoxes), usefulBoxes);
    if (maxBoxes <= 0) continue;
    const resource = src.weightPerBox / Math.max(EPS, input.vehicle.weightCapKg)
      + src.volumePerBox / Math.max(EPS, input.vehicle.volumeCapM3);
    const wLoss = priorityWeight(input.priorities[String(target.id)] ?? target.priority, 'loss');
    candidates.push({
      code: src.code, skuId: target.id, covPerBox,
      weightPerBox: src.weightPerBox, volumePerBox: src.volumePerBox,
      slot: src.vehicleSlot, arrivalMin, maxBoxes,
      valueDensity: (target.cu * wLoss * covPerBox) / Math.max(EPS, resource),
    });
  }
  return { candidates, buckets, demand, origUnits, origArrival, receipts, notes };
}

function vehiclesForSlot(v: SolverVehicle, weightKg: number, volumeM3: number): { vehicles: number; over: boolean } {
  if (weightKg <= EPS && volumeM3 <= EPS) return { vehicles: 0, over: false };
  const need = Math.max(
    1,
    Math.ceil(weightKg / Math.max(EPS, v.weightCapKg)),
    Math.ceil(volumeM3 / Math.max(EPS, v.volumeCapM3)),
  );
  return { vehicles: need, over: need > v.maxVehiclesPerSlot };
}

interface Evaluation {
  skuGaps: EmergencySkuGap[];
  stockoutLoss: number; wasteLoss: number; stockoutUnits: number; heavyGapUnits: number;
  vehicleUsage: VehicleSlotUsage[]; freight: number;
  gapUnitsBySku: Map<number, number>;
}

function evaluate(input: SolverInput, prep: Prep, allocation: Map<string, number>): Evaluation {
  const emBySku = new Map<number, number>();
  const emHourBySku = new Map<number, number[]>();
  const slotWeight = new Map<string, number>();
  const slotVolume = new Map<string, number>();

  const addEm = (skuId: number, units: number, arrivalMin: number) => {
    const bs = prep.buckets.get(skuId) ?? [];
    const vals = spread(arrivalMin, units, bs);
    const hourArr = emHourBySku.get(skuId) ?? bs.map(() => 0);
    for (let i = 0; i < bs.length; i++) hourArr[i] += vals[i];
    emHourBySku.set(skuId, hourArr);
    emBySku.set(skuId, (emBySku.get(skuId) ?? 0) + units);
  };

  // 已到货回执先抵扣对应缺口（不占本次车次）
  for (const r of prep.receipts) addEm(r.skuId, r.units, r.arrivalMin);

  for (const c of prep.candidates) {
    const boxes = allocation.get(c.code) ?? 0;
    if (boxes <= 0) continue;
    addEm(c.skuId, boxes * c.covPerBox, c.arrivalMin);
    slotWeight.set(c.slot, (slotWeight.get(c.slot) ?? 0) + boxes * c.weightPerBox);
    slotVolume.set(c.slot, (slotVolume.get(c.slot) ?? 0) + boxes * c.volumePerBox);
  }

  let stockoutLoss = 0;
  let wasteLoss = 0;
  let stockoutUnits = 0;
  let heavyGapUnits = 0;
  const skuGaps: EmergencySkuGap[] = [];
  const gapUnitsBySku = new Map<number, number>();

  for (const sku of input.skus) {
    const d = prep.demand.get(sku.id) ?? 0;
    const orig = prep.origUnits.get(sku.id) ?? 0;
    const em = emBySku.get(sku.id) ?? 0;
    const priority = Math.max(1, Math.min(5, input.priorities[String(sku.id)] ?? sku.priority));
    const wLoss = priorityWeight(priority, 'loss');
    const wWaste = priorityWeight(priority, 'waste');

    const bs = prep.buckets.get(sku.id) ?? [];
    const demandHour = bs.map((b) => d * b.weight);
    const origHour = spread(prep.origArrival.get(sku.id) ?? minutesOf(sku.salesStart), orig, bs);
    const emHour = emHourBySku.get(sku.id) ?? bs.map(() => 0);
    const hours = bs.map((b, i) => {
      const coveredH = origHour[i] + emHour[i];
      return {
        hour: i + 1, label: b.label,
        demand: round2(demandHour[i]), covered: round2(coveredH),
        gap: round2(Math.max(0, demandHour[i] - coveredH)),
      };
    });
    // 逐时缺口总量（份）：逐小时看，原单+应急覆盖不足的部分
    const gapTotal = bs.reduce((acc, _b, i) => acc + Math.max(0, demandHour[i] - origHour[i] - emHour[i]), 0);
    const needTotal = bs.reduce((acc, _b, i) => acc + Math.max(0, demandHour[i] - origHour[i]), 0);
    const overTotal = Math.max(0, em - needTotal);
    const skuStockout = gapTotal * sku.cu * wLoss;
    const skuWaste = overTotal * sku.co * wWaste;

    stockoutLoss += skuStockout;
    wasteLoss += skuWaste;
    stockoutUnits += gapTotal;
    heavyGapUnits += gapTotal * priority;
    gapUnitsBySku.set(sku.id, gapTotal);
    skuGaps.push({
      skuId: sku.id, skuCode: sku.code, skuName: sku.name, priority,
      demandUnits: round2(d), originalAvailable: round2(orig), emergencyCovered: round2(em),
      coveredUnits: round2(Math.min(orig + em, d)), shortUnits: round2(gapTotal),
      overCoveredUnits: round2(overTotal),
      stockoutLoss: round2(skuStockout), wasteLoss: round2(skuWaste), hours,
    });
  }

  const vehicleUsage: VehicleSlotUsage[] = input.vehicle.slots.map((slot) => {
    const w = slotWeight.get(slot) ?? 0;
    const v = slotVolume.get(slot) ?? 0;
    const { vehicles, over } = vehiclesForSlot(input.vehicle, w, v);
    return {
      slot, vehicles, weightKg: round2(w), volumeM3: round3(v),
      freight: vehicles * input.vehicle.freightPerVehicle, overCapacity: over,
    };
  });
  const freight = vehicleUsage.reduce((a, u) => a + u.freight, 0);
  return { skuGaps, stockoutLoss, wasteLoss, stockoutUnits, heavyGapUnits, vehicleUsage, freight, gapUnitsBySku };
}

/**
 * 忽略共享限制时的「逐件最低成本」对照：各商品独立按每箱覆盖价值/占车资源挑货源，
 * 不看其他商品争用同一车次、不做车数上限校验，所有箱数按总量合并算最少车次（最乐观）。
 * 因此它是真实最优成本的下界。
 */
export function computeIndependentLowerCost(input: SolverInput): {
  total: number; stockoutLoss: number; wasteLoss: number; freight: number;
  allocation: Record<string, number>; vehicleUsage: VehicleSlotUsage[]; feasible: boolean;
} {
  const prep = prepare(input);
  const allocation = new Map<string, number>();
  for (const sku of input.skus) {
    const opts = prep.candidates.filter((c) => c.skuId === sku.id).sort((a, b) => b.valueDensity - a.valueDensity);
    for (const c of opts) {
      let taken = 0;
      while (taken < c.maxBoxes) {
        const before = evaluate(input, prep, allocation).gapUnitsBySku.get(sku.id) ?? 0;
        if (before <= 0.01) break;
        allocation.set(c.code, (allocation.get(c.code) ?? 0) + 1);
        const after = evaluate(input, prep, allocation).gapUnitsBySku.get(sku.id) ?? 0;
        if (after >= before - 0.01) {
          // 这箱没减少该商品缺口（会变成报损）→ 撤回
          const cur = (allocation.get(c.code) ?? 1) - 1;
          if (cur <= 0) allocation.delete(c.code); else allocation.set(c.code, cur);
          break;
        }
        taken++;
      }
    }
  }
  const ev = evaluate(input, prep, allocation);
  let totalWeight = 0;
  let totalVolume = 0;
  for (const c of prep.candidates) {
    const b = allocation.get(c.code) ?? 0;
    totalWeight += b * c.weightPerBox;
    totalVolume += b * c.volumePerBox;
  }
  const pooledVehicles = totalWeight <= EPS && totalVolume <= EPS
    ? 0
    : Math.max(1, Math.ceil(totalWeight / Math.max(EPS, input.vehicle.weightCapKg)),
               Math.ceil(totalVolume / Math.max(EPS, input.vehicle.volumeCapM3)));
  const freight = pooledVehicles * input.vehicle.freightPerVehicle;
  const vehicleUsage: VehicleSlotUsage[] = [{
    slot: '合并装车（忽略车次限制）', vehicles: pooledVehicles,
    weightKg: round2(totalWeight), volumeM3: round3(totalVolume), freight, overCapacity: false,
  }];
  return {
    total: round2(ev.stockoutLoss + ev.wasteLoss + freight),
    stockoutLoss: round2(ev.stockoutLoss), wasteLoss: round2(ev.wasteLoss), freight,
    allocation: Object.fromEntries([...allocation].filter(([, b]) => b > 0)),
    vehicleUsage, feasible: true,
  };
}

/**
 * 分批搜索：按到达车次分批，批内枚举该车次货源的箱数组合，批间逐批推进并累计核对
 * 共享车次/单车重量与冷藏容积；用乐观下界（无法避免的缺货损失 + 已发生报损 + 运费）
 * 做 branch & bound 剪枝。全部分支枚举完毕 → optimal；触及节点/时间上限 → feasible。
 */
export function solveEmergency(input: SolverInput, options: SolveOptions = {}): {
  bounded: SolveResult; independent: ReturnType<typeof computeIndependentLowerCost>;
} {
  const started = performance.now();
  const nodeLimit = Math.max(1, options.nodeLimit ?? 400000);
  const timeLimitMs = Math.max(50, options.timeLimitMs ?? 2000);
  const prep = prepare(input);

  // 按车次分批（同批共享车次与单车容量），批内按价值密度从高到低
  const bySlot = new Map<string, Candidate[]>();
  for (const c of prep.candidates.slice().sort((a, b) => b.valueDensity - a.valueDensity)) {
    const list = bySlot.get(c.slot);
    if (list) list.push(c); else bySlot.set(c.slot, [c]);
  }
  const batches = [...bySlot.values()];

  // 后缀可覆盖量（按商品），用于乐观下界
  const suffix: Map<number, number>[] = new Array(batches.length + 1);
  suffix[batches.length] = new Map();
  for (let b = batches.length - 1; b >= 0; b--) {
    const m = new Map(suffix[b + 1]);
    for (const c of batches[b]) m.set(c.skuId, (m.get(c.skuId) ?? 0) + c.maxBoxes * c.covPerBox);
    suffix[b] = m;
  }

  const allocation = new Map<string, number>();
  const slotW = new Map<string, number>();
  const slotV = new Map<string, number>();
  let best: { total: number; alloc: Map<string, number>; ev: Evaluation } | null = null;
  let iterations = 0;
  let nodeLimitHit = false;
  let timeLimitHit = false;

  function unavoidableStockout(batchIndex: number, ev: Evaluation): number {
    const suff = suffix[Math.min(batchIndex, batches.length)];
    let loss = 0;
    for (const sku of input.skus) {
      const gap = ev.gapUnitsBySku.get(sku.id) ?? 0;
      const add = suff.get(sku.id) ?? 0;
      const remaining = Math.max(0, gap - add);
      const w = priorityWeight(input.priorities[String(sku.id)] ?? sku.priority, 'loss');
      loss += remaining * sku.cu * w;
    }
    return loss;
  }

  function considerLeaf(ev: Evaluation) {
    if (ev.vehicleUsage.some((u) => u.overCapacity)) return;
    const total = ev.stockoutLoss + ev.wasteLoss + ev.freight;
    if (!best || total < best.total - EPS) best = { total, alloc: new Map(allocation), ev };
  }

  function dfs(batchIndex: number): void {
    if (nodeLimitHit || timeLimitHit) return;
    if (performance.now() - started > timeLimitMs) { timeLimitHit = true; return; }

    if (batchIndex >= batches.length) {
      considerLeaf(evaluate(input, prep, allocation));
      return;
    }

    const batch = batches[batchIndex];
    const recurse = (i: number) => {
      if (nodeLimitHit || timeLimitHit) return;
      if (++iterations > nodeLimit) { nodeLimitHit = true; return; }
      if (performance.now() - started > timeLimitMs) { timeLimitHit = true; return; }
      if (i >= batch.length) {
        const ev = evaluate(input, prep, allocation);
        if (ev.vehicleUsage.some((u) => u.overCapacity)) return;
        considerLeaf(ev);
        if (batchIndex + 1 < batches.length) {
          // 乐观剪枝：当前节点下界已 ≥ 已知最好 → 后续批次不可能更优
          if (best) {
            const lb = ev.wasteLoss + ev.freight + unavoidableStockout(batchIndex + 1, ev);
            if (lb >= best.total - EPS) return;
          }
          dfs(batchIndex + 1);
        }
        return;
      }
      const c = batch[i];
      for (let boxes = c.maxBoxes; boxes >= 0; boxes--) {
        const w = (slotW.get(c.slot) ?? 0) + boxes * c.weightPerBox;
        const v = (slotV.get(c.slot) ?? 0) + boxes * c.volumePerBox;
        if (vehiclesForSlot(input.vehicle, w, v).over) continue;
        if (boxes > 0) allocation.set(c.code, boxes); else allocation.delete(c.code);
        slotW.set(c.slot, w);
        slotV.set(c.slot, v);
        recurse(i + 1);
        if (boxes > 0) allocation.delete(c.code);
        slotW.set(c.slot, (slotW.get(c.slot) ?? 0) - boxes * c.weightPerBox);
        slotV.set(c.slot, (slotV.get(c.slot) ?? 0) - boxes * c.volumePerBox);
        if (nodeLimitHit || timeLimitHit) return;
      }
    };
    recurse(0);
  }

  dfs(0);

  if (!best) {
    const ev = evaluate(input, prep, new Map());
    best = { total: ev.stockoutLoss + ev.wasteLoss + ev.freight, alloc: new Map(), ev };
  }
  const chosen = best as { total: number; alloc: Map<string, number>; ev: Evaluation };
  const allocationOut: Record<string, number> = {};
  for (const [code, boxes] of chosen.alloc) if (boxes > 0) allocationOut[code] = boxes;

  const exhausted = !nodeLimitHit && !timeLimitHit;
  const notes = prep.notes.slice();
  if (nodeLimitHit) {
    notes.push(`搜索达到节点上限（${iterations} 次），仅证明「已找到的可行方案」，未穷尽搜索空间，不能称为最优`);
  } else if (timeLimitHit) {
    notes.push(`搜索达到时间上限（${Math.round(timeLimitMs)}ms），仅证明「已找到的可行方案」，未穷尽搜索空间，不能称为最优`);
  }

  const bounded: SolveResult = {
    kind: 'bounded',
    status: exhausted ? 'optimal' : 'feasible',
    allocation: allocationOut,
    objective: {
      total: round2(chosen.total),
      stockoutLoss: round2(chosen.ev.stockoutLoss),
      wasteLoss: round2(chosen.ev.wasteLoss),
      freight: round2(chosen.ev.freight),
      stockoutUnits: round2(chosen.ev.stockoutUnits),
      heavyGapUnits: round2(chosen.ev.heavyGapUnits),
    },
    hourlyGap: chosen.ev.skuGaps,
    vehicleUsage: chosen.ev.vehicleUsage,
    iterations,
    elapsedMs: Math.round(performance.now() - started),
    nodeLimitHit: !exhausted,
    notes,
  };
  return { bounded, independent: computeIndependentLowerCost(input) };
}
