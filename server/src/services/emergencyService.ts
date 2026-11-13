import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { pool } from '../db';
import { ConflictError, NotFoundError } from './suggestionService';

/** 随附数据：少送比例、分时需求曲线、货源登记与供货/收货事件（不含任何推荐结果） */
type Scenario = {
  demandMultiplier: number;
  originalArrival: string;
  originalLateArrival: string;
  shortDeliveryRatios: Record<string, number>;
  hourlyProfiles: Record<string, { start: string; end: string; weights: number[] }>;
  vehicle: { freightPerVehicle: number; weightCapKg: number; volumeCapM3: number; maxVehiclesPerSlot: number };
  sources: {
    code: string; supplier: string; skuCode: string; targetSkuCode: string;
    availableBoxes: number; unitsPerBox: number; substitutionRatio: number; arrivalTime: string;
    weightPerBox: number; volumePerBox: number; sourceUnit: string; vehicleSlot: string;
    unitCost?: number; note?: string;
  }[];
  events: { eventType: string; title: string; payload: Record<string, unknown> }[];
};

const scenario: Scenario = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../data/emergency-scenario.json'), 'utf8'),
);

export function emergencyScenario() {
  return scenario;
}

type Db = pg.Pool | pg.PoolClient;

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

/** 品类销售时段（由随附分时曲线定义） */
function windowOf(categoryCode: string): { start: number; end: number; hours: number } {
  const p = scenario.hourlyProfiles[categoryCode];
  if (!p) return { start: 8 * 60, end: 21 * 60, hours: 13 };
  return { start: minutesOf(p.start), end: minutesOf(p.end), hours: p.weights.length };
}

function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

async function costOf(db: Db, storeId: number, categoryId: number, defaultCu: number, defaultCo: number) {
  const over = await db.query('SELECT cu, co FROM cost_params WHERE store_id=$1 AND category_id=$2', [storeId, categoryId]);
  if (over.rows[0]) return { cu: Number(over.rows[0].cu), co: Number(over.rows[0].co) };
  return { cu: defaultCu, co: defaultCo };
}

/** 某货源在给定销售时段下是否被排除（不可换算 / 到货晚于销售时段） */
export function sourceExclusion(
  src: { unitsPerBox: number; arrivalTime: string; delayHours: number },
  categoryCode: string,
): string | null {
  const win = windowOf(categoryCode);
  const arrival = minutesOf(src.arrivalTime) + Math.round(Number(src.delayHours) * 60);
  if (!Number.isFinite(src.unitsPerBox) || Number(src.unitsPerBox) <= 0) {
    return '单位无法换算：未提供整箱规格（每箱份数 ≤ 0），不计入可分配货源';
  }
  if (arrival > win.end) {
    return `到货 ${fmtMinutes(arrival)} 晚于销售时段 ${fmtMinutes(win.start)}–${fmtMinutes(win.end)}，不计作当前补救`;
  }
  return null;
}

async function ensureCase(client: Db, storeId: number, arrivalDate: string) {
  const existing = await client.query(
    'SELECT * FROM emergency_cases WHERE store_id=$1 AND arrival_date=$2',
    [storeId, arrivalDate],
  );
  if (existing.rows[0]) return existing.rows[0];

  const ins = await client.query(
    `INSERT INTO emergency_cases(store_id, arrival_date, demand_multiplier, priorities)
     VALUES($1,$2,$3,'{}'::jsonb) RETURNING *`,
    [storeId, arrivalDate, scenario.demandMultiplier],
  );
  const emergencyCase = ins.rows[0];

  const skus = await client.query('SELECT id, code FROM skus');
  const skuId = (code: string) => skus.rows.find((s: { code: string }) => s.code === code)?.id as number | undefined;

  for (const src of scenario.sources) {
    const from = skuId(src.skuCode);
    const target = skuId(src.targetSkuCode);
    if (!from || !target) continue;
    await client.query(
      `INSERT INTO emergency_sources
         (case_id, code, supplier, sku_id, target_sku_id, available_boxes, units_per_box,
          substitution_ratio, arrival_time, weight_per_box, volume_per_box, source_unit, vehicle_slot,
          unit_cost, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'seed')
       ON CONFLICT (case_id, code) DO NOTHING`,
      [
        emergencyCase.id, src.code, src.supplier, from, target, src.availableBoxes, src.unitsPerBox,
        src.substitutionRatio, src.arrivalTime, src.weightPerBox, src.volumePerBox, src.sourceUnit,
        src.vehicleSlot, src.unitCost ?? 0, src.note ?? null,
      ],
    );
  }
  await refreshExclusions(client, emergencyCase.id);
  return emergencyCase;
}

/** 依据当前整箱规格与（含延误）到达时刻刷新排除标记 */
async function refreshExclusions(db: Db, caseId: number): Promise<void> {
  const r = await db.query(
    `SELECT es.*, c.code AS category_code FROM emergency_sources es
       JOIN skus s ON s.id = es.target_sku_id JOIN categories c ON c.id = s.category_id
      WHERE es.case_id=$1`,
    [caseId],
  );
  for (const row of r.rows) {
    const reason = sourceExclusion(
      { unitsPerBox: Number(row.units_per_box), arrivalTime: row.arrival_time, delayHours: Number(row.delay_hours) },
      row.category_code,
    );
    await db.query(
      'UPDATE emergency_sources SET status=$3, exclude_reason=$4 WHERE id=$1 AND case_id=$2',
      [row.id, caseId, reason ? 'excluded' : 'registered', reason],
    );
  }
}

/**
 * 输入修订号自增：供货减少 / 车辆晚到等输入变化后，旧计算立即失效。
 * preserveAwaiting=true 用于只会追加信息的变化（部分到货、原单晚到提示），此时待确认应急单保留。
 */
async function bumpRevision(
  client: pg.PoolClient,
  caseId: number,
  opts: { preserveAwaiting?: boolean; cancelPrompt?: boolean } = {},
): Promise<number> {
  const upd = await client.query(
    'UPDATE emergency_cases SET input_revision = input_revision + 1 WHERE id=$1 RETURNING input_revision',
    [caseId],
  );
  const revision = Number(upd.rows[0].input_revision);
  // 任何输入修订（供货/车辆/优先级/部分到货）都让旧的候选方案失效；迟到的结果也会被 STALE_INPUT 拒绝
  await client.query(
    `UPDATE emergency_plans SET status='invalidated'
      WHERE case_id=$1 AND input_revision < $2 AND status IN ('optimal','feasible','selected')`,
    [caseId, revision],
  );
  if (!opts.preserveAwaiting) {
    const orders = await client.query(
      `SELECT id FROM emergency_orders WHERE case_id=$1 AND status='awaiting_confirmation'`,
      [caseId],
    );
    for (const o of orders.rows) {
      await client.query(`UPDATE emergency_orders SET status='invalidated' WHERE id=$1`, [o.id]);
      await client.query(
        `UPDATE emergency_commitments SET status='invalidated'
          WHERE order_id=$1 AND status='proposed' AND received_boxes = 0`,
        [o.id],
      );
    }
  }
  if (opts.cancelPrompt) {
    // 原单晚到：只要还有在用的应急单（待确认或已确认），都重新提示是否需要取消
    await client.query(
      `UPDATE emergency_orders SET cancel_prompt=TRUE
        WHERE case_id=$1 AND status IN ('awaiting_confirmation','confirmed')`,
      [caseId],
    );
  }
  return revision;
}

function eventKey(index: number): string {
  const e = scenario.events[index];
  return `${e.eventType}#${index}`;
}

/** 打开（或首次建立）某门店某到货日的应急推演 */
export async function openEmergency(storeId: number, arrivalDate: string) {
  const caseRow = await ensureCase(pool(), storeId, arrivalDate);

  const [skus, sources, receipts, plans, orderRes, eventsApplied, originalOrderRes] = await Promise.all([
    pool().query(
      `SELECT s.id, s.code AS sku_code, s.name AS sku_name, s.unit, s.category_id,
              c.code AS category_code, c.name AS category_name, c.default_cu, c.default_co
         FROM skus s JOIN categories c ON c.id=s.category_id ORDER BY s.id`,
    ),
    pool().query(
      `SELECT es.*, s.code AS sku_code, s.name AS sku_name, ts.code AS target_sku_code, ts.name AS target_sku_name,
              tc.code AS target_category_code
         FROM emergency_sources es
         JOIN skus s ON s.id=es.sku_id
         JOIN skus ts ON ts.id=es.target_sku_id
         JOIN categories tc ON tc.id=ts.category_id
        WHERE es.case_id=$1 ORDER BY es.code`,
      [caseRow.id],
    ),
    pool().query(
      `SELECT er.*, es.code AS source_code, es.target_sku_id, es.units_per_box, es.substitution_ratio
         FROM emergency_receipts er
         JOIN emergency_sources es ON es.id=er.source_id
        WHERE er.case_id=$1 ORDER BY er.id`,
      [caseRow.id],
    ),
    pool().query('SELECT * FROM emergency_plans WHERE case_id=$1 ORDER BY id DESC', [caseRow.id]),
    pool().query('SELECT * FROM emergency_orders WHERE case_id=$1 ORDER BY id DESC LIMIT 1', [caseRow.id]),
    pool().query('SELECT event_key FROM emergency_events WHERE case_id=$1', [caseRow.id]),
    pool().query(
      `SELECT o.*, v.version_no FROM orders o JOIN suggestion_versions v ON v.id=o.version_id
        WHERE o.store_id=$1 AND o.arrival_date=$2`,
      [storeId, arrivalDate],
    ),
  ]);

  const order = originalOrderRes.rows[0] ?? null;
  const orderItems = order
    ? await pool().query(
        `SELECT oi.sku_id, oi.qty, oi.suggested_qty, s.code AS sku_code, s.name AS sku_name, s.unit
           FROM order_items oi JOIN skus s ON s.id=oi.sku_id WHERE oi.order_id=$1 ORDER BY oi.sku_id`,
        [order.id],
      )
    : { rows: [] };

  // 需求基准：到货日最近一版建议量（系统预测），无建议表时取最近窗口还原需求中位；仅作为分时需求的日总量
  const forecastRes = await pool().query(
    `SELECT si.sku_id, si.suggested_qty
       FROM suggestion_items si
       JOIN suggestion_versions v ON v.id=si.version_id
       JOIN suggestion_tables t ON t.id=v.table_id
      WHERE t.store_id=$1 AND t.arrival_date=$2 AND v.version_no = (
              SELECT MAX(v2.version_no) FROM suggestion_versions v2 WHERE v2.table_id=t.id)`,
    [storeId, arrivalDate],
  );
  const forecastBySku = new Map<number, number>(
    forecastRes.rows.map((r: { sku_id: number; suggested_qty: string }) => [r.sku_id, Number(r.suggested_qty)]),
  );
  const medianRes = await pool().query(
    `SELECT sku_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY restored_demand) AS m
       FROM demand_samples
      WHERE store_id=$1 AND business_date < $2::date AND business_date >= ($2::date - 56)
        AND excluded_from_training=FALSE
      GROUP BY sku_id`,
    [storeId, arrivalDate],
  );
  const medianBySku = new Map<number, number>(
    medianRes.rows.map((r: { sku_id: number; m: string | null }) => [r.sku_id, Number(r.m ?? 0)]),
  );

  const priorityMap = (caseRow.priorities ?? {}) as Record<string, number>;
  const skuRows = [];
  for (const s of skus.rows) {
    const cost = await costOf(pool(), storeId, s.category_id, Number(s.default_cu), Number(s.default_co));
    const win = windowOf(s.category_code);
    const profile = scenario.hourlyProfiles[s.category_code];
    const baseDemand = forecastBySku.get(s.id) ?? medianBySku.get(s.id) ?? 0;
    skuRows.push({
      id: s.id, code: s.sku_code, name: s.sku_name, unit: s.unit,
      categoryId: s.category_id, categoryCode: s.category_code, categoryName: s.category_name,
      cu: cost.cu, co: cost.co,
      salesStart: fmtMinutes(win.start), salesEnd: fmtMinutes(win.end),
      priority: Number(priorityMap[String(s.id)] ?? 3),
      shortDeliveryRatio: Number(scenario.shortDeliveryRatios[s.sku_code] ?? 0),
      dailyDemandBase: Math.round(baseDemand * 100) / 100,
      demandSource: forecastBySku.has(s.id) ? 'suggestion' : medianBySku.has(s.id) ? 'restored_median' : 'none',
      hourlyProfile: profile
        ? { start: profile.start, end: profile.end, weights: profile.weights }
        : { start: fmtMinutes(win.start), end: fmtMinutes(win.end), weights: [] as number[] },
    });
  }

  const activeEmergency = (await pool().query(
    'SELECT * FROM emergency_orders WHERE case_id=$1 ORDER BY id DESC LIMIT 1',
    [caseRow.id],
  )).rows[0] ?? null;
  const commitments = activeEmergency
    ? (await pool().query(
        `SELECT ec.*, es.code AS source_code, es.supplier FROM emergency_commitments ec
           JOIN emergency_sources es ON es.id=ec.source_id
          WHERE ec.order_id=$1 ORDER BY es.code`,
        [activeEmergency.id],
      )).rows
    : [];

  const appliedKeys = new Set(eventsApplied.rows.map((r: { event_key: string }) => r.event_key));

  return {
    case: {
      id: caseRow.id, storeId: caseRow.store_id, arrivalDate: caseRow.arrival_date,
      inputRevision: Number(caseRow.input_revision),
      demandMultiplier: Number(caseRow.demand_multiplier),
      originalOrderLate: caseRow.original_order_late,
      priorities: priorityMap,
    },
    scenario: {
      demandMultiplier: Number(caseRow.demand_multiplier),
      originalArrival: scenario.originalArrival,
      originalLateArrival: scenario.originalLateArrival,
      shortDeliveryRatios: scenario.shortDeliveryRatios,
      hourlyProfiles: scenario.hourlyProfiles,
      vehicle: scenario.vehicle,
    },
    originalOrder: order
      ? {
          id: order.id, versionNo: order.version_no, confirmedBy: order.confirmed_by,
          confirmedAt: order.confirmed_at, status: order.status, items: orderItems.rows,
        }
      : null,
    skus: skuRows,
    sources: sources.rows,
    receipts: receipts.rows,
    plans: plans.rows,
    emergencyOrder: activeEmergency,
    commitments,
    events: scenario.events.map((e, i) => ({
      key: eventKey(i), eventType: e.eventType, title: e.title, payload: e.payload, applied: appliedKeys.has(eventKey(i)),
    })),
  };
}

export interface SourceInput {
  code: string; supplier: string; skuCode: string; targetSkuCode: string;
  availableBoxes: number; unitsPerBox: number; substitutionRatio: number; arrivalTime: string;
  weightPerBox: number; volumePerBox: number; sourceUnit: string; vehicleSlot: string;
  unitCost: number; note?: string;
}

/** 登记/更新货源：整箱规格、替代比例、到达时刻、重量、冷藏容积；变化即输入修订号自增 */
export async function registerSource(storeId: number, arrivalDate: string, input: SourceInput, createdBy: string) {
  if (!/^[0-9]{1,2}:[0-9]{2}$/.test(input.arrivalTime)) {
    throw new ConflictError('BAD_REQUEST', '到达时刻格式应为 HH:MM');
  }
  if (input.availableBoxes < 0 || input.substitutionRatio < 0 || input.weightPerBox < 0 || input.volumePerBox < 0) {
    throw new ConflictError('BAD_REQUEST', '可供箱数/替代比例/重量/容积不能为负');
  }
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const caseRow = await ensureCase(client, storeId, arrivalDate);
    const skus = await client.query('SELECT id, code FROM skus WHERE code = ANY($1)', [[input.skuCode, input.targetSkuCode]]);
    const from = skus.rows.find((s: { code: string }) => s.code === input.skuCode)?.id;
    const target = skus.rows.find((s: { code: string }) => s.code === input.targetSkuCode)?.id;
    if (!from || !target) throw new ConflictError('BAD_REQUEST', '货源 SKU 或目标 SKU 不存在');

    await client.query(
      `INSERT INTO emergency_sources
         (case_id, code, supplier, sku_id, target_sku_id, available_boxes, units_per_box, substitution_ratio,
          arrival_time, weight_per_box, volume_per_box, source_unit, vehicle_slot, unit_cost, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (case_id, code) DO UPDATE SET
         supplier=EXCLUDED.supplier, sku_id=EXCLUDED.sku_id, target_sku_id=EXCLUDED.target_sku_id,
         available_boxes=EXCLUDED.available_boxes, units_per_box=EXCLUDED.units_per_box,
         substitution_ratio=EXCLUDED.substitution_ratio, arrival_time=EXCLUDED.arrival_time,
         weight_per_box=EXCLUDED.weight_per_box, volume_per_box=EXCLUDED.volume_per_box,
         source_unit=EXCLUDED.source_unit, vehicle_slot=EXCLUDED.vehicle_slot, note=EXCLUDED.note,
         unit_cost=EXCLUDED.unit_cost, delay_hours=0`,
      [
        caseRow.id, input.code, input.supplier, from, target, Math.floor(input.availableBoxes),
        input.unitsPerBox, input.substitutionRatio, input.arrivalTime, input.weightPerBox,
        input.volumePerBox, input.sourceUnit || '箱', input.vehicleSlot, input.unitCost, input.note ?? null, createdBy,
      ],
    );
    await refreshExclusions(client, caseRow.id);
    const revision = await bumpRevision(client, caseRow.id);
    await client.query('COMMIT');
    return { caseId: caseRow.id, inputRevision: revision };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** 调整商品优先级（1 最低 – 5 最高），重算后用于缺货损失的加权 */
export async function setPriorities(storeId: number, arrivalDate: string, priorities: Record<string, number>) {
  const cleaned: Record<string, number> = {};
  for (const [k, v] of Object.entries(priorities)) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1 && n <= 5) cleaned[k] = n;
  }
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const caseRow = await ensureCase(client, storeId, arrivalDate);
    await client.query(
      'UPDATE emergency_cases SET priorities=$3::jsonb WHERE id=$1 AND store_id=$2',
      [caseRow.id, storeId, JSON.stringify(cleaned)],
    );
    const revision = await bumpRevision(client, caseRow.id, { preserveAwaiting: true });
    await client.query('COMMIT');
    return { caseId: caseRow.id, inputRevision: revision };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 应用随附数据里的供货/收货事件（按事件键，重复应用幂等）。
 * 供货减少、车辆晚到 → 旧计算立即失效；
 * 部分到货 → 先抵扣缺口，重复回执不再增加库存；
 * 原单晚到 → 保留待确认应急单并重新提示是否取消。
 */
export async function applyEvent(storeId: number, arrivalDate: string, key: string) {
  const index = scenario.events.findIndex((_, i) => eventKey(i) === key);
  if (index < 0) throw new NotFoundError('事件不存在');
  const event = scenario.events[index];

  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const caseRow = await ensureCase(client, storeId, arrivalDate);
    const logged = await client.query(
      `INSERT INTO emergency_events(case_id, event_key, event_type, payload)
       VALUES($1,$2,$3,$4) ON CONFLICT (case_id, event_key) DO NOTHING RETURNING id`,
      [caseRow.id, key, event.eventType, JSON.stringify(event.payload)],
    );
    if (!logged.rows[0]) {
      await client.query('COMMIT');
      return { eventType: event.eventType, idempotent: true, inputRevision: Number(caseRow.input_revision) };
    }

    const p = event.payload as Record<string, unknown>;
    let revision = Number(caseRow.input_revision);
    let note = event.title;

    if (event.eventType === 'supply_decrease') {
      const upd = await client.query(
        'UPDATE emergency_sources SET available_boxes=$3 WHERE case_id=$1 AND code=$2',
        [caseRow.id, String(p.sourceCode), Math.max(0, Number(p.availableBoxes))],
      );
      if (!upd.rowCount) throw new NotFoundError('货源不存在');
      await refreshExclusions(client, caseRow.id);
      revision = await bumpRevision(client, caseRow.id);
    } else if (event.eventType === 'vehicle_delay') {
      await client.query(
        'UPDATE emergency_sources SET delay_hours = delay_hours + $3 WHERE case_id=$1 AND vehicle_slot=$2',
        [caseRow.id, String(p.slot), Number(p.delayHours)],
      );
      await refreshExclusions(client, caseRow.id);
      revision = await bumpRevision(client, caseRow.id);
    } else if (event.eventType === 'original_order_late') {
      await client.query('UPDATE emergency_cases SET original_order_late=TRUE WHERE id=$1', [caseRow.id]);
      revision = await bumpRevision(client, caseRow.id, { preserveAwaiting: true, cancelPrompt: true });
    } else if (event.eventType === 'receipt' || event.eventType === 'receipt_duplicate') {
      const source = await client.query(
        'SELECT id, available_boxes FROM emergency_sources WHERE case_id=$1 AND code=$2',
        [caseRow.id, String(p.sourceCode)],
      );
      const src = source.rows[0];
      if (!src) throw new NotFoundError('货源不存在');
      const rec = await client.query(
        `INSERT INTO emergency_receipts(case_id, source_id, receipt_key, boxes, arrival_time)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT (case_id, receipt_key) DO NOTHING RETURNING id`,
        [caseRow.id, src.id, String(p.receiptKey), Number(p.boxes), String(p.arrivalTime)],
      );
      if (!rec.rows[0]) {
        await client.query('COMMIT');
        return {
          eventType: event.eventType, idempotent: true, stockIncreased: false,
          inputRevision: revision, note: '重复收货事件：同一回执已入库，不再增加库存',
        };
      }
      await client.query(
        'UPDATE emergency_sources SET available_boxes = GREATEST(0, available_boxes - $3) WHERE case_id=$1 AND id=$2',
        [caseRow.id, src.id, Number(p.boxes)],
      );
      await client.query(
        `UPDATE emergency_commitments SET received_boxes = received_boxes + $3
          WHERE source_id=$2 AND order_id IN (SELECT id FROM emergency_orders WHERE case_id=$1 AND status IN ('awaiting_confirmation','confirmed'))`,
        [caseRow.id, src.id, Number(p.boxes)],
      );
      await client.query(
        `UPDATE emergency_commitments SET status='shipped'
          WHERE source_id=$2 AND received_boxes > 0 AND order_id IN (SELECT id FROM emergency_orders WHERE case_id=$1 AND status IN ('awaiting_confirmation','confirmed'))`,
        [caseRow.id, src.id],
      );
      revision = await bumpRevision(client, caseRow.id, { preserveAwaiting: true });
      note = '部分到货：先抵扣对应缺口，其余保留待补';
    } else {
      throw new ConflictError('BAD_REQUEST', '未知事件类型');
    }

    await client.query('COMMIT');
    return { eventType: event.eventType, idempotent: false, inputRevision: revision, note };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export interface PlanInput {
  inputRevision: number;
  kind: 'bounded' | 'lower_bound';
  status: 'optimal' | 'feasible' | 'lower_bound';
  objective: Record<string, unknown>;
  allocation: Record<string, number>;
  hourlyGap: unknown;
  vehicleUsage: unknown;
  iterations: number;
  elapsedMs: number;
  nodeLimitHit: boolean;
}

/**
 * 接收浏览器计算出的方案（组合搜索在浏览器完成，这里只核对输入修订号与货源可供量）。
 * 修订号对不上 → 迟到的搜索结果，409 拒绝，绝不覆盖新选择。
 */
export async function submitPlan(storeId: number, arrivalDate: string, plan: PlanInput, createdBy: string) {
  if (plan.inputRevision === undefined || plan.inputRevision === null) {
    throw new ConflictError('BAD_REQUEST', '缺少输入修订号');
  }
  if (!['bounded', 'lower_bound'].includes(plan.kind)) throw new ConflictError('BAD_REQUEST', '方案类型非法');
  const allowed = plan.kind === 'bounded' ? ['optimal', 'feasible'] : ['lower_bound'];
  if (!allowed.includes(plan.status)) throw new ConflictError('BAD_REQUEST', '方案状态与类型不匹配');

  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const caseRow = await ensureCase(client, storeId, arrivalDate);
    if (Number(plan.inputRevision) !== Number(caseRow.input_revision)) {
      throw new ConflictError('STALE_INPUT', '输入已变化，计算结果已过期，请重新计算', {
        currentRevision: Number(caseRow.input_revision),
      });
    }

    const sources = await client.query('SELECT id, code, available_boxes, status FROM emergency_sources WHERE case_id=$1', [caseRow.id]);
    for (const [code, boxesRaw] of Object.entries(plan.allocation ?? {})) {
      const boxes = Number(boxesRaw);
      const src = sources.rows.find((s: { code: string }) => s.code === code);
      if (!src) throw new ConflictError('BAD_REQUEST', `货源 ${code} 不存在`);
      if (!Number.isInteger(boxes) || boxes < 0) throw new ConflictError('BAD_REQUEST', `货源 ${code} 箱数非法`);
      if (boxes > Number(src.available_boxes)) {
        throw new ConflictError('PLAN_EXCEEDS_SUPPLY', `货源 ${code} 分配箱数超过可供箱数`);
      }
      if (src.status === 'excluded' && boxes > 0) {
        throw new ConflictError('PLAN_USES_EXCLUDED', `货源 ${code} 已被排除，不能分配`);
      }
    }

    const ins = await client.query(
      `INSERT INTO emergency_plans
         (case_id, kind, input_revision, status, objective, allocation, hourly_gap, vehicle_usage,
          iterations, elapsed_ms, node_limit_hit, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        caseRow.id, plan.kind, plan.inputRevision, plan.status,
        JSON.stringify(plan.objective ?? {}), JSON.stringify(plan.allocation ?? {}),
        JSON.stringify(plan.hourlyGap ?? {}), JSON.stringify(plan.vehicleUsage ?? {}),
        Math.max(0, Math.round(Number(plan.iterations) || 0)),
        Math.max(0, Math.round(Number(plan.elapsedMs) || 0)),
        Boolean(plan.nodeLimitHit), createdBy,
      ],
    );
    // 同一批货不能同时分给两个方案：同类型上一次的候选方案标记为已被取代
    await client.query(
      `UPDATE emergency_plans SET status='superseded'
        WHERE case_id=$1 AND kind=$2 AND id <> $3 AND status IN ('optimal','feasible','lower_bound')`,
      [caseRow.id, plan.kind, ins.rows[0].id],
    );
    await client.query('COMMIT');
    return { planId: ins.rows[0].id as number };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** 店长选货：把当前最好方案转为待确认应急单（货源承诺 proposed，尚未锁量） */
export async function selectPlan(storeId: number, arrivalDate: string, planId: number, selectedBy: string) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const caseRow = await ensureCase(client, storeId, arrivalDate);
    const planRes = await client.query('SELECT * FROM emergency_plans WHERE id=$1 AND case_id=$2', [planId, caseRow.id]);
    const plan = planRes.rows[0];
    if (!plan) throw new NotFoundError('方案不存在');
    if (Number(plan.input_revision) !== Number(caseRow.input_revision)) {
      throw new ConflictError('STALE_PLAN', '方案基于旧输入，已失效，请重新计算后选择', {
        currentRevision: Number(caseRow.input_revision),
      });
    }
    const active = await client.query(
      `SELECT id, status FROM emergency_orders WHERE case_id=$1 AND status IN ('awaiting_confirmation','confirmed')`,
      [caseRow.id],
    );
    if (active.rows[0]) {
      throw new ConflictError('PLAN_CONFLICT', '已有一张待确认/已确认的应急单，同一批货不能同时分给两个方案', {
        orderId: active.rows[0].id,
      });
    }
    if (plan.kind !== 'bounded' || !['optimal', 'feasible', 'selected'].includes(plan.status)) {
      throw new ConflictError('PLAN_NOT_SELECTABLE', '只有满足共享货量与车辆限制的可行方案可以被选择');
    }

    // 应急单费用 = Σ 分配箱数 × 每箱成本 + 同车合并后运费（按方案车辆占用）
    const srcRows = await client.query(
      `SELECT id, code, unit_cost FROM emergency_sources WHERE case_id=$1`, [caseRow.id],
    );
    const costByCode = new Map<string, number>(
      srcRows.rows.map((r: { code: string; unit_cost: string }) => [r.code, Number(r.unit_cost)]),
    );
    let goodsCost = 0;
    for (const [code, boxesRaw] of Object.entries(plan.allocation as Record<string, number>)) {
      goodsCost += Number(boxesRaw) * (costByCode.get(code) ?? 0);
    }
    const usage = Array.isArray(plan.vehicle_usage) ? (plan.vehicle_usage as { freight?: number }[]) : [];
    const freightCost = usage.reduce((a, u) => a + Number(u.freight ?? 0), 0);
    const totalCost = Math.round((goodsCost + freightCost) * 100) / 100;
    const orderRes = await client.query(
      `INSERT INTO emergency_orders
         (case_id, plan_id, store_id, arrival_date, status, total_cost, selected_by, cancel_prompt)
       VALUES ($1,$2,$3,$4,'awaiting_confirmation',$5,$6,$7) RETURNING id`,
      [caseRow.id, plan.id, storeId, arrivalDate, totalCost, selectedBy, false],
    );
    const orderId = orderRes.rows[0].id as number;

    for (const [code, boxesRaw] of Object.entries(plan.allocation as Record<string, number>)) {
      const boxes = Number(boxesRaw);
      if (boxes <= 0) continue;
      const src = await client.query(
        'SELECT id FROM emergency_sources WHERE case_id=$1 AND code=$2',
        [caseRow.id, code],
      );
      if (!src.rows[0]) {
        throw new ConflictError('SOURCE_MISSING', `选货引用的货源 ${code} 已不存在，请重新计算`);
      }
      await client.query(
        `INSERT INTO emergency_commitments(order_id, source_id, boxes, status)
         VALUES($1,$2,$3,'proposed')`,
        [orderId, src.rows[0].id, boxes],
      );
    }
    await client.query(`UPDATE emergency_plans SET status='selected' WHERE id=$1`, [plan.id]);
    await client.query('COMMIT');
    return { orderId, totalCost };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** 区域负责人确认费用：锁定本次选货数量，货源承诺转为 locked，并从可供箱数中扣除 */
export async function confirmEmergencyOrder(storeId: number, arrivalDate: string, orderId: number, confirmedBy: string) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const caseRow = await ensureCase(client, storeId, arrivalDate);
    const order = await client.query('SELECT * FROM emergency_orders WHERE id=$1 AND case_id=$2', [orderId, caseRow.id]);
    if (!order.rows[0]) throw new NotFoundError('应急单不存在');
    if (order.rows[0].status !== 'awaiting_confirmation') {
      throw new ConflictError('ORDER_STATE', `应急单当前状态为 ${order.rows[0].status}，不能确认费用`);
    }
    const plan = await client.query('SELECT * FROM emergency_plans WHERE id=$1', [order.rows[0].plan_id]);
    if (Number(plan.rows[0].input_revision) !== Number(caseRow.input_revision)) {
      throw new ConflictError('STALE_PLAN', '输入已变化，待确认应急单已失效，请重新计算', {
        currentRevision: Number(caseRow.input_revision),
      });
    }
    const cs = await client.query('SELECT * FROM emergency_commitments WHERE order_id=$1', [orderId]);
    for (const c of cs.rows) {
      await client.query(
        `UPDATE emergency_sources SET available_boxes = GREATEST(0, available_boxes - $3) WHERE id=$2 AND case_id=$1`,
        [caseRow.id, c.source_id, c.boxes],
      );
    }
    await client.query(
      `UPDATE emergency_commitments SET status='locked' WHERE order_id=$1 AND status='proposed'`,
      [orderId],
    );
    await client.query(
      `UPDATE emergency_orders SET status='confirmed', confirmed_by=$2, confirmed_at=now(), cancel_prompt=FALSE WHERE id=$1`,
      [orderId, confirmedBy],
    );
    await client.query(`UPDATE emergency_plans SET status='locked' WHERE id=$1`, [order.rows[0].plan_id]);
    const revision = await bumpRevision(client, caseRow.id);
    await client.query('COMMIT');
    return { orderId, inputRevision: revision, locked: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** 取消应急单：已发货部分不能直接释放；未发货部分释放回可供箱数 */
export async function cancelEmergencyOrder(
  storeId: number, arrivalDate: string, orderId: number, cancelledBy: string, reason: string,
) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const caseRow = await ensureCase(client, storeId, arrivalDate);
    const order = await client.query('SELECT * FROM emergency_orders WHERE id=$1 AND case_id=$2', [orderId, caseRow.id]);
    const o = order.rows[0];
    if (!o) throw new NotFoundError('应急单不存在');
    if (!['awaiting_confirmation', 'confirmed'].includes(o.status)) {
      throw new ConflictError('ORDER_STATE', `应急单当前状态为 ${o.status}，不能取消`);
    }
    const cs = await client.query('SELECT * FROM emergency_commitments WHERE order_id=$1', [o.id]);
    let shippedBoxes = 0;
    let releasedBoxes = 0;
    for (const c of cs.rows) {
      if (Number(c.received_boxes) > 0) {
        // 已发货/部分到货的承诺保留为 shipped，不直接释放
        shippedBoxes += Number(c.received_boxes);
        await client.query(
          `UPDATE emergency_commitments SET status='shipped' WHERE id=$1`,
          [c.id],
        );
      } else {
        releasedBoxes += Number(c.boxes);
        await client.query(
          `UPDATE emergency_commitments SET status='released' WHERE id=$1`,
          [c.id],
        );
        if (o.status === 'confirmed') {
          await client.query(
            `UPDATE emergency_sources SET available_boxes = available_boxes + $3 WHERE id=$2 AND case_id=$1`,
            [caseRow.id, c.source_id, c.boxes],
          );
        }
      }
    }
    await client.query(
      `UPDATE emergency_orders SET status='cancelled', cancelled_by=$2, cancelled_at=now(),
         cancel_reason=$3, cancel_prompt=FALSE WHERE id=$1`,
      [o.id, cancelledBy, reason],
    );
    await client.query(`UPDATE emergency_plans SET status='superseded' WHERE id=$1`, [o.plan_id]);
    const revision = await bumpRevision(client, caseRow.id);
    await client.query('COMMIT');
    return {
      orderId: o.id, status: 'cancelled', shippedBoxes, releasedBoxes,
      inputRevision: revision,
      note: shippedBoxes > 0 ? '已发货部分保留、不直接释放；其余未发货承诺已释放' : '未发货承诺已全部释放',
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
