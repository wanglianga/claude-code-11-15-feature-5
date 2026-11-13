import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import type { Express } from 'express';

/**
 * 端到端集成测试：独立测试库 ccdev_test，覆盖
 * 幂等并表 / 版本不可变 / 确认-修订落库先后裁定 / 复盘归因口径 / 报损窗口 / 盘点差异剔除。
 */

const ADMIN_URL = 'postgres://ccdev:ccdev@127.0.0.1:5432/ccdev';
process.env.DATABASE_URL = 'postgres://ccdev:ccdev@127.0.0.1:5432/ccdev_test';

let app: Express;
let db: typeof import('../src/db');
let hqToken = '';
let store1Token = '';
let store2Token = '';
let store1 = 0;
let skuBo = 0;
let arrival = '';
let today = '';
let addDays: (date: string, days: number) => string;

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  await admin.query('DROP DATABASE IF EXISTS ccdev_test WITH (FORCE)');
  await admin.query('CREATE DATABASE ccdev_test');
  await admin.end();

  db = await import('../src/db');
  await db.migrate();
  const pool = db.pool();

  // 最小确定性夹具
  const s = await pool.query(
    `INSERT INTO stores (code, name) VALUES ('T01','测试一店'),('T02','测试二店') RETURNING id`,
  );
  store1 = s.rows[0].id;
  const c = await pool.query(
    `INSERT INTO categories (code, name, default_cu, default_co) VALUES
       ('LEAFY','叶菜',8,2),('ROOT','根茎',2,2) RETURNING id, code`,
  );
  const leafy = c.rows.find((r) => r.code === 'LEAFY').id;
  const sku = await pool.query(
    `INSERT INTO skus (category_id, code, name, unit, min_order_unit, price, cost)
     VALUES ($1,'BOC','菠菜','份',1,6.5,2.5) RETURNING id`,
    [leafy],
  );
  skuBo = sku.rows[0].id;

  const { hashPassword } = await import('../src/auth');
  await pool.query(
    `INSERT INTO users (username, password_hash, role, store_id) VALUES
       ('hq', $1, 'hq', NULL), ('store1', $2, 'manager', $3), ('store2', $2, 'manager', $4)`,
    [hashPassword('hq123456'), hashPassword('store123456'), store1, s.rows[1].id],
  );

  // 8 个有效还原样本：[10,12,...,24]，τ=0.8 → 经验分位 21.2 → 向上取整 22
  const dates = await import('../src/lib/dates');
  const todayStr = dates.todayStr;
  addDays = dates.addDays;
  today = todayStr();
  arrival = addDays(today, 1);
  const vals = [10, 12, 14, 16, 18, 20, 22, 24];
  for (let i = 0; i < vals.length; i++) {
    await pool.query(
      `INSERT INTO demand_samples
         (store_id, sku_id, business_date, open_hours, sales_qty, stockout_flag,
          in_stock_hours, in_stock_rate, restored_demand, is_censored, degraded, source)
       VALUES ($1,$2,$3,13,$4,false,13,$5,$6,false,false,'seed')`,
      [store1, skuBo, addDays(today, -(i + 1)), vals[i], vals[i] / 13, vals[i]],
    );
  }

  const appMod = await import('../src/app');
  app = appMod.createApp();

  hqToken = (await request(app).post('/api/auth/login').send({ username: 'hq', password: 'hq123456' })).body.token;
  store1Token = (await request(app).post('/api/auth/login').send({ username: 'store1', password: 'store123456' })).body.token;
  store2Token = (await request(app).post('/api/auth/login').send({ username: 'store2', password: 'store123456' })).body.token;
  expect(hqToken).toBeTruthy();
}, 30000);

afterAll(async () => {
  await db.closePool();
});

describe('建议生成：临界分位 + 向上取整 + 幂等并表', () => {
  it('首版建议：τ=0.8，经验分位 21.2 → 建议 22（最小订货单位 1）', async () => {
    const res = await request(app)
      .post('/api/suggestions/generate')
      .set(auth(hqToken))
      .send({ storeId: store1, arrivalDate: arrival, idempotencyKey: 'it-gen-1' });
    expect(res.status).toBe(200);
    expect(res.body.versionNo).toBe(1);

    const detail = await request(app)
      .get(`/api/suggestions?storeId=${store1}&arrivalDate=${arrival}`)
      .set(auth(hqToken));
    const item = detail.body.items.find((i: { sku_id: number }) => i.sku_id === skuBo);
    expect(Number(item.quantile)).toBeCloseTo(0.8);
    expect(Number(item.raw_qty)).toBeCloseTo(21.2);
    expect(Number(item.suggested_qty)).toBe(22);
    expect(detail.body.currentVersion.feature_snapshot.baseline).toBe('restored_demand');
  });

  it('同一幂等键重复提交 → 并成一张表，不产生新版本', async () => {
    const res = await request(app)
      .post('/api/suggestions/generate')
      .set(auth(hqToken))
      .send({ storeId: store1, arrivalDate: arrival, idempotencyKey: 'it-gen-1' });
    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.versionNo).toBe(1);
    const v = await db.pool().query('SELECT COUNT(*)::int n FROM suggestion_versions');
    expect(v.rows[0].n).toBe(1);
  });

  it('降温事件触发重算 → 新修订版本 v2，v1 原样保留（不可变）', async () => {
    const res = await request(app)
      .post('/api/suggestions/generate')
      .set(auth(hqToken))
      .send({
        storeId: store1, arrivalDate: arrival, idempotencyKey: 'it-gen-2',
        triggerEvent: 'temp_drop', features: { tempDrop: true },
      });
    expect(res.status).toBe(200);
    expect(res.body.versionNo).toBe(2);

    const detail = await request(app)
      .get(`/api/suggestions?storeId=${store1}&arrivalDate=${arrival}`)
      .set(auth(hqToken));
    expect(detail.body.versions).toHaveLength(2);
    const v1 = detail.body.versions.find((v: { version_no: number }) => v.version_no === 1);
    expect(v1.status).toBe('superseded');
    // v2: 21.2 × 0.9 = 19.08 → 20
    const item = detail.body.items.find((i: { sku_id: number }) => i.sku_id === skuBo);
    expect(Number(item.suggested_qty)).toBe(20);
    // v1 内容未被改写
    const v1Detail = await request(app)
      .get(`/api/suggestions/versions/${v1.id}`).set(auth(hqToken));
    expect(Number(v1Detail.body.items[0].suggested_qty)).toBe(22);
  });
});

describe('确认与修订：按落库先后裁定', () => {
  it('基于旧版本确认 → 409 VERSION_CONFLICT', async () => {
    const detail = await request(app)
      .get(`/api/suggestions?storeId=${store1}&arrivalDate=${arrival}`).set(auth(store1Token));
    const v1 = detail.body.versions.find((v: { version_no: number }) => v.version_no === 1);
    const res = await request(app)
      .post(`/api/versions/${v1.id}/confirm`)
      .set(auth(store1Token))
      .send({ idempotencyKey: 'it-order-1', items: [{ skuId: skuBo, qty: 22 }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('基于最新版本确认 → 成功，版本锁定', async () => {
    const detail = await request(app)
      .get(`/api/suggestions?storeId=${store1}&arrivalDate=${arrival}`).set(auth(store1Token));
    const res = await request(app)
      .post(`/api/versions/${detail.body.currentVersion.id}/confirm`)
      .set(auth(store1Token))
      .send({ idempotencyKey: 'it-order-1', items: [{ skuId: skuBo, qty: 20, reasonCode: '降温减量' }] });
    expect(res.status).toBe(200);
    expect(res.body.orderId).toBeTruthy();
  });

  it('确认已落库后总部修订 → 409 REVISION_CONFLICT', async () => {
    const res = await request(app)
      .post('/api/suggestions/generate')
      .set(auth(hqToken))
      .send({ storeId: store1, arrivalDate: arrival, idempotencyKey: 'it-gen-3', triggerEvent: 'promo_cancelled' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REVISION_CONFLICT');
  });

  it('同一幂等键重复确认 → 幂等返回原订单；新键重复确认 → 409', async () => {
    const detail = await request(app)
      .get(`/api/suggestions?storeId=${store1}&arrivalDate=${arrival}`).set(auth(store1Token));
    const again = await request(app)
      .post(`/api/versions/${detail.body.currentVersion.id}/confirm`)
      .set(auth(store1Token))
      .send({ idempotencyKey: 'it-order-1', items: [{ skuId: skuBo, qty: 20 }] });
    expect(again.status).toBe(200);
    expect(again.body.idempotent).toBe(true);

    const dup = await request(app)
      .post(`/api/versions/${detail.body.currentVersion.id}/confirm`)
      .set(auth(store1Token))
      .send({ idempotencyKey: 'it-order-2', items: [{ skuId: skuBo, qty: 20 }] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ALREADY_CONFIRMED');
    const n = await db.pool().query('SELECT COUNT(*)::int n FROM orders');
    expect(n.rows[0].n).toBe(1);
  });

  it('门店账号不能操作他店数据', async () => {
    const res = await request(app)
      .get(`/api/suggestions?storeId=${store1}&arrivalDate=${arrival}`)
      .set(auth(store2Token));
    expect(res.status).toBe(403);
  });
});

describe('收市复盘：观测需求口径归因 + 样本回流', () => {
  let reviewId = 0;

  it('创建复盘（幂等），归因基准固定为观测需求', async () => {
    const orders = await request(app)
      .get(`/api/orders?storeId=${store1}&arrivalDate=${arrival}`).set(auth(hqToken));
    const orderId = orders.body.orders[0].id;
    const r1 = await request(app).post(`/api/orders/${orderId}/review`).set(auth(hqToken));
    expect(r1.status).toBe(200);
    reviewId = r1.body.reviewId;
    const r2 = await request(app).post(`/api/orders/${orderId}/review`).set(auth(hqToken));
    expect(r2.body.idempotent).toBe(true);
    expect(r2.body.reviewId).toBe(reviewId);
  });

  it('售罄日录入：按有货速率外推观测需求，缺货损失按版本快照 Cu 归因', async () => {
    // 实销 15，15:30 售罄 → 有货 7.5h，速率 2 → 观测需求 26，缺货损失 11×Cu8=88
    const res = await request(app)
      .post(`/api/reviews/${reviewId}/entry`)
      .set(auth(hqToken))
      .send({ skuId: skuBo, actualSales: 15, stockoutFlag: true, selloutTime: '15:30', wasteQty: 2 });
    expect(res.status).toBe(200);
    const reviews = await request(app)
      .get(`/api/reviews?storeId=${store1}&arrivalDate=${arrival}`).set(auth(hqToken));
    const review = reviews.body.reviews[0];
    expect(review.baseline).toBe('restored_demand');
    const item = review.items.find((i: { sku_id: number }) => i.sku_id === skuBo);
    expect(Number(item.restored_demand)).toBeCloseTo(26);
    expect(Number(item.stockout_loss_qty)).toBeCloseTo(11);
    expect(Number(item.stockout_loss_amount)).toBeCloseTo(88);
    expect(Number(item.waste_cost)).toBeCloseTo(4); // 2 × Co2
  });

  it('当日样本回流需求还原（截断观测形态）', async () => {
    const s = await db.pool().query(
      'SELECT * FROM demand_samples WHERE store_id=$1 AND sku_id=$2 AND business_date=$3',
      [store1, skuBo, arrival],
    );
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].source).toBe('review_reflow');
    expect(s.rows[0].is_censored).toBe(true);
    expect(Number(s.rows[0].restored_demand)).toBeCloseTo(26);
    expect(s.rows[0].excluded_from_training).toBe(false);
  });
});

describe('报损补录窗口与盘点差异剔除', () => {
  let reviewId = 0;
  beforeAll(async () => {
    const r = await db.pool().query('SELECT id FROM reviews LIMIT 1');
    reviewId = r.rows[0].id;
  });

  it('窗口内补录 → 结转重算（报损量与金额累加重算）', async () => {
    const res = await request(app)
      .post('/api/waste-records')
      .set(auth(hqToken))
      .send({ storeId: store1, skuId: skuBo, businessDate: arrival, qty: 3 });
    expect(res.body.withinWindow).toBe(true);
    expect(res.body.disposition).toBe('recalc');
    const item = await db.pool().query(
      'SELECT waste_qty, waste_cost FROM review_items WHERE review_id=$1 AND sku_id=$2',
      [reviewId, skuBo],
    );
    expect(Number(item.rows[0].waste_qty)).toBe(5);       // 2 + 3
    expect(Number(item.rows[0].waste_cost)).toBeCloseTo(10); // 5 × Co2
  });

  it('过窗补录 → 单独存档注明出处，复盘归因保持原样', async () => {
    const late = new Date(`${arrival}T00:00:00`);
    late.setDate(late.getDate() + 2); // 窗口（次日 12:00）之后
    const res = await request(app)
      .post('/api/waste-records')
      .set(auth(hqToken))
      .send({ storeId: store1, skuId: skuBo, businessDate: arrival, qty: 4, recordedAt: late.toISOString() });
    expect(res.body.withinWindow).toBe(false);
    expect(res.body.disposition).toBe('archived');
    const item = await db.pool().query(
      'SELECT waste_qty FROM review_items WHERE review_id=$1 AND sku_id=$2',
      [reviewId, skuBo],
    );
    expect(Number(item.rows[0].waste_qty)).toBe(5); // 未变
  });

  it('盘点对不上 → 以盘点为准留差异记录，差异批次样本剔除出训练', async () => {
    const res = await request(app)
      .post('/api/stocktakes')
      .set(auth(hqToken))
      .send({ storeId: store1, skuId: skuBo, businessDate: arrival, actualQty: 5 });
    expect(res.status).toBe(200);
    expect(Number(res.body.difference)).toBe(5);
    expect(res.body.excluded).toBe(true);
    const s = await db.pool().query(
      'SELECT excluded_from_training, exclude_reason FROM demand_samples WHERE store_id=$1 AND sku_id=$2 AND business_date=$3',
      [store1, skuBo, arrival],
    );
    expect(s.rows[0].excluded_from_training).toBe(true);
    expect(s.rows[0].exclude_reason).toContain('盘点差异');
    // 以盘点为准：系统库存已修正为实盘数
    const inv = await db.pool().query(
      'SELECT system_qty FROM inventory_snapshots WHERE store_id=$1 AND sku_id=$2 AND business_date=$3',
      [store1, skuBo, arrival],
    );
    expect(Number(inv.rows[0].system_qty)).toBe(5);
  });
});


/**
 * 配送异常应急订货推演：修订号失效 / 迟到结果拒绝 / 承诺-确认-锁定分离 /
 * 部分到货抵扣与重复回执幂等 / 原单晚到提示取消 / 已发货不释放 / 排除规则。
 */
describe('应急订货推演', () => {
  /** 为指定到货日准备一张原确认订单（独立到货日，避免用例间互相污染） */
  async function prepareCase(offset: number): Promise<string> {
    const arrivalDate = addDays(today, offset);
    const gen = await request(app)
      .post('/api/suggestions/generate').set(auth(hqToken))
      .send({ storeId: store1, arrivalDate, idempotencyKey: `em-gen-${arrivalDate}` });
    expect(gen.status).toBe(200);
    const detail = (await request(app)
      .get(`/api/suggestions?storeId=${store1}&arrivalDate=${arrivalDate}`).set(auth(hqToken))).body;
    const conf = await request(app)
      .post(`/api/versions/${detail.currentVersion.id}/confirm`).set(auth(store1Token))
      .send({
        idempotencyKey: `em-order-${arrivalDate}`,
        items: detail.items.map((i: { sku_id: number; suggested_qty: string }) => ({ skuId: i.sku_id, qty: Number(i.suggested_qty) })),
      });
    expect(conf.status).toBe(200);
    return arrivalDate;
  }

  function register(arrivalDate: string, over: Record<string, unknown> = {}) {
    return request(app).post('/api/emergency/sources').set(auth(store1Token)).send({
      storeId: store1, arrivalDate, code: 'L1', supplier: '晨光批发',
      skuCode: 'BOC', targetSkuCode: 'BOC', availableBoxes: 6, unitsPerBox: 10,
      substitutionRatio: 1, arrivalTime: '08:30', weightPerBox: 8, volumePerBox: 0.05,
      sourceUnit: '箱', vehicleSlot: 'AM', unitCost: 45,
      ...over,
    });
  }

  async function open(arrivalDate: string) {
    return (await request(app)
      .get(`/api/emergency?storeId=${store1}&arrivalDate=${arrivalDate}`).set(auth(store1Token))).body;
  }

  function submit(arrivalDate: string, revision: number, over: Record<string, unknown> = {}) {
    return request(app).post('/api/emergency/plans').set(auth(store1Token)).send({
      storeId: store1, arrivalDate, inputRevision: revision,
      kind: 'bounded', status: 'optimal',
      objective: { total: 100, stockoutLoss: 0, wasteLoss: 10, freight: 90 },
      allocation: { L1: 2 }, hourlyGap: [],
      vehicleUsage: [{ slot: 'AM', vehicles: 1, weightKg: 16, volumeM3: 0.1, freight: 90, overCapacity: false }],
      iterations: 42, elapsedMs: 3, nodeLimitHit: false,
      ...over,
    });
  }

  it('登记货源：整箱规格/替代比例/到达时刻/重量/容积落库；不可换算与晚到货源被排除并说明', async () => {
    const d = await prepareCase(4);
    expect((await register(d, { code: 'L1' })).status).toBe(200);
    expect((await register(d, { code: 'L2', supplier: '城南合作社', availableBoxes: 4, arrivalTime: '10:00', weightPerBox: 8 })).status).toBe(200);
    expect((await register(d, { code: 'L3', supplier: '小农直供', unitsPerBox: 0, vehicleSlot: 'MID' })).status).toBe(200);
    expect((await register(d, { code: 'L4', supplier: '晚市补货', arrivalTime: '18:30', vehicleSlot: 'EVE' })).status).toBe(200);

    const state = await open(d);
    expect(state.originalOrder.items.length).toBeGreaterThan(0);
    expect(state.plans).toHaveLength(0);
    expect(state.events.every((e: { applied: boolean }) => !e.applied)).toBe(true);
    const byCode = new Map(state.sources.map((s: { code: string }) => [s.code, s]));
    expect((byCode.get('L1') as { status: string }).status).toBe('registered');
    expect((byCode.get('L3') as { status: string }).status).toBe('excluded');
    expect((byCode.get('L3') as { exclude_reason: string }).exclude_reason).toContain('单位无法换算');
    expect((byCode.get('L4') as { status: string }).status).toBe('excluded');
    expect((byCode.get('L4') as { exclude_reason: string }).exclude_reason).toContain('晚于销售时段');
  });

  it('回传方案：修订号一致 → 入库；超过可供箱数 / 使用被排除货源 → 409 拒绝', async () => {
    const d = await prepareCase(5);
    await register(d, { code: 'L1', availableBoxes: 6 });
    await register(d, { code: 'L4', supplier: '晚市补货', arrivalTime: '18:30', vehicleSlot: 'EVE' });
    const revision = (await open(d)).case.inputRevision;

    const bounded = await submit(d, revision);
    expect(bounded.status).toBe(200);
    expect(bounded.body.planId).toBeTruthy();

    const lower = await submit(d, revision, {
      kind: 'lower_bound', status: 'lower_bound',
      objective: { total: 95 }, allocation: { L1: 2 }, iterations: 0, elapsedMs: 0,
    });
    expect(lower.status).toBe(200);

    const over = await submit(d, revision, { allocation: { L1: 999 } });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('PLAN_EXCEEDS_SUPPLY');

    const excludedUse = await submit(d, revision, { allocation: { L4: 1 } });
    expect(excludedUse.status).toBe(409);
    expect(excludedUse.body.error.code).toBe('PLAN_USES_EXCLUDED');
  });

  it('店长选货 → 待确认应急单（承诺中，不锁量）；同一批货不能同时分给两个方案', async () => {
    const d = await prepareCase(6);
    await register(d, { code: 'L1', availableBoxes: 6 });
    const revision = (await open(d)).case.inputRevision;
    const plan = await submit(d, revision);
    expect(plan.status).toBe(200);

    const sel = await request(app)
      .post(`/api/emergency/plans/${plan.body.planId}/select`).set(auth(store1Token))
      .send({ storeId: store1, arrivalDate: d });
    expect(sel.status).toBe(200);
    const orderId = sel.body.orderId;

    const second = await request(app)
      .post(`/api/emergency/plans/${plan.body.planId}/select`).set(auth(store1Token))
      .send({ storeId: store1, arrivalDate: d });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('PLAN_CONFLICT');

    const state = await open(d);
    expect(state.emergencyOrder.id).toBe(orderId);
    expect(state.emergencyOrder.status).toBe('awaiting_confirmation');
    expect(state.commitments.every((c: { status: string }) => c.status === 'proposed')).toBe(true);
    const l1 = state.sources.find((s: { code: string }) => s.code === 'L1');
    expect(Number(l1.available_boxes)).toBe(6); // 未确认费用前不扣可供量
  });

  it('店长不能确认费用；总部确认后锁定数量并扣减可供量，原订单保持不变', async () => {
    const d = await prepareCase(7);
    await register(d, { code: 'L1', availableBoxes: 6 });
    const revision = (await open(d)).case.inputRevision;
    const plan = await submit(d, revision);
    const sel = await request(app)
      .post(`/api/emergency/plans/${plan.body.planId}/select`).set(auth(store1Token))
      .send({ storeId: store1, arrivalDate: d });
    expect(sel.status).toBe(200);
    const orderId = sel.body.orderId;
    // 费用 = 2 箱 × 45 + 1 辆 AM 车 90（按方案车辆占用）＝ 180
    expect(sel.body.totalCost).toBeCloseTo(180);

    const denied = await request(app)
      .post(`/api/emergency/orders/${orderId}/confirm`).set(auth(store1Token))
      .send({ storeId: store1, arrivalDate: d });
    expect(denied.status).toBe(403);

    const ok = await request(app)
      .post(`/api/emergency/orders/${orderId}/confirm`).set(auth(hqToken))
      .send({ storeId: store1, arrivalDate: d });
    expect(ok.status).toBe(200);
    expect(ok.body.locked).toBe(true);

    const state = await open(d);
    expect(state.emergencyOrder.status).toBe('confirmed');
    expect(state.commitments.every((c: { status: string }) => c.status === 'locked')).toBe(true);
    expect(Number(state.sources.find((s: { code: string }) => s.code === 'L1').available_boxes)).toBe(4);

    const orders = await request(app).get(`/api/orders?storeId=${store1}&arrivalDate=${d}`).set(auth(hqToken));
    expect(orders.body.orders.length).toBe(1);
    expect(orders.body.orders[0].status).toBe('confirmed');
  });

  it('供货量减少：输入修订号自增，旧计算失效；迟到的计算结果被拒绝（STALE_INPUT）', async () => {
    const d = await prepareCase(8);
    await register(d, { code: 'L1', availableBoxes: 6 });
    const before = (await open(d)).case.inputRevision;
    const candidate = await submit(d, before);
    expect(candidate.status).toBe(200);

    const applied = await register(d, { code: 'L1', availableBoxes: 3 });
    expect(applied.status).toBe(200);
    expect(applied.body.inputRevision).toBeGreaterThan(before);

    const stale = await submit(d, before);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_INPUT');
    expect(stale.body.error.details.currentRevision).toBe(applied.body.inputRevision);

    const plans = (await open(d)).plans;
    const old = plans.find((p: { id: number }) => p.id === candidate.body.planId);
    expect(old.status).toBe('invalidated');

    // 用新修订号回传则入库
    const fresh = await submit(d, applied.body.inputRevision);
    expect(fresh.status).toBe(200);
  });

  it('部分到货抵扣对应缺口；重复回执不再增加库存；原单晚到提示取消，已发货部分不释放', async () => {
    const d = await prepareCase(9);
    await register(d, { code: 'L1', availableBoxes: 6 });
    await register(d, { code: 'L2', supplier: '城南合作社', availableBoxes: 4, arrivalTime: '10:00' });
    const revision = (await open(d)).case.inputRevision;
    const plan = await submit(d, revision, { allocation: { L1: 2, L2: 2 } });
    expect(plan.status).toBe(200);
    const sel = await request(app)
      .post(`/api/emergency/plans/${plan.body.planId}/select`).set(auth(store1Token))
      .send({ storeId: store1, arrivalDate: d });
    expect(sel.status).toBe(200);
    const orderId = sel.body.orderId;

    const stockBefore = Number((await open(d)).sources.find((s: { code: string }) => s.code === 'L2').available_boxes);
    const r1 = await request(app)
      .post(`/api/emergency/events/${encodeURIComponent('receipt#3')}/apply`).set(auth(store1Token))
      .send({ storeId: store1, arrivalDate: d });
    expect(r1.status).toBe(200);
    expect(r1.body.idempotent).toBeFalsy();

    const r2 = await request(app)
      .post(`/api/emergency/events/${encodeURIComponent('receipt_duplicate#4')}/apply`).set(auth(store1Token))
      .send({ storeId: store1, arrivalDate: d });
    expect(r2.status).toBe(200);
    expect(r2.body.idempotent).toBe(true);
    expect(r2.body.stockIncreased).toBe(false);

    const after = await open(d);
    expect(after.receipts.filter((r: { receipt_key: string }) => r.receipt_key === 'R-001')).toHaveLength(1);
    expect(Number(after.sources.find((s: { code: string }) => s.code === 'L2').available_boxes)).toBe(stockBefore - 2);
    const c2 = after.commitments.find((c: { source_code: string }) => c.source_code === 'L2');
    expect(Number(c2.received_boxes)).toBe(2);
    expect(c2.status).toBe('shipped');

    const late = await request(app)
      .post(`/api/emergency/events/${encodeURIComponent('original_order_late#2')}/apply`).set(auth(store1Token))
      .send({ storeId: store1, arrivalDate: d });
    expect(late.status).toBe(200);

    const afterLate = await open(d);
    expect(afterLate.case.originalOrderLate).toBe(true);
    expect(afterLate.emergencyOrder.id).toBe(orderId);
    expect(afterLate.emergencyOrder.cancel_prompt).toBe(true);

    const cancel = await request(app)
      .post(`/api/emergency/orders/${orderId}/cancel`).set(auth(store1Token))
      .send({ storeId: store1, arrivalDate: d, reason: '原单恢复正常' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('cancelled');
    expect(cancel.body.shippedBoxes).toBe(2);

    const finalState = await open(d);
    const shipped = finalState.commitments.filter((c: { status: string }) => c.status === 'shipped');
    expect(shipped.length).toBe(1);
    expect(shipped[0].source_code).toBe('L2');
    expect(Number(shipped[0].received_boxes)).toBe(2);
    const released = finalState.commitments.filter((c: { status: string }) => c.status === 'released');
    expect(released.map((c: { source_code: string }) => c.source_code)).toContain('L1');
  });

  it('车辆晚到 → 受影响车次到达时刻顺延，修订号再次变化', async () => {
    const d = await prepareCase(10);
    await register(d, { code: 'L5', supplier: '根茎补货', unitsPerBox: 5, arrivalTime: '12:00', weightPerBox: 3, volumePerBox: 0.04, vehicleSlot: 'PM' });
    const before = (await open(d)).case.inputRevision;
    const applied = await request(app)
      .post(`/api/emergency/events/${encodeURIComponent('vehicle_delay#1')}/apply`).set(auth(store1Token))
      .send({ storeId: store1, arrivalDate: d });
    expect(applied.status).toBe(200);
    expect(applied.body.inputRevision).toBeGreaterThan(before);

    const state = await open(d);
    const pm = state.sources.filter((s: { vehicle_slot: string }) => s.vehicle_slot === 'PM');
    expect(pm.length).toBeGreaterThan(0);
    expect(pm.every((s: { delay_hours: string }) => Number(s.delay_hours) >= 2)).toBe(true);
  });

  it('商品优先级变化 → 修订号自增且落库，旧计算失效', async () => {
    const d = await prepareCase(11);
    await register(d, { code: 'L1', availableBoxes: 6 });
    const opened = await open(d);
    const candidate = await submit(d, opened.case.inputRevision);
    expect(candidate.status).toBe(200);

    const priorities: Record<string, number> = {};
    for (const s of opened.skus) priorities[String(s.id)] = 5;
    const res = await request(app)
      .post('/api/emergency/priorities').set(auth(store1Token))
      .send({ storeId: store1, arrivalDate: d, priorities });
    expect(res.status).toBe(200);
    expect(res.body.inputRevision).toBeGreaterThan(opened.case.inputRevision);

    const after = await open(d);
    expect(after.case.priorities[String(opened.skus[0].id)]).toBe(5);
    expect(after.plans.find((p: { id: number }) => p.id === candidate.body.planId).status).toBe('invalidated');
  });

  it('门店账号不能访问他店应急推演', async () => {
    const d = await prepareCase(12);
    const res = await request(app)
      .get(`/api/emergency?storeId=${store1}&arrivalDate=${d}`).set(auth(store2Token));
    expect(res.status).toBe(403);
  });
});
