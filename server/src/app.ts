import express, { type NextFunction, type Request, type Response } from 'express';
import { pool } from './db';
import { requireAuth, requireRole, scopeStoreId, signToken, verifyPassword } from './auth';
import { confirmOrder, generateSuggestion, ConflictError, NotFoundError } from './services/suggestionService';
import { addStocktake, addWasteRecord, createReview, submitReviewEntry } from './services/reviewService';
import {
  applyEvent as applyEmergencyEvent,
  cancelEmergencyOrder,
  confirmEmergencyOrder,
  openEmergency,
  registerSource,
  selectPlan,
  setPriorities,
  submitPlan,
} from './services/emergencyService';

function num(v: unknown, name: string): number {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || Number.isNaN(n)) {
    throw new ConflictError('BAD_REQUEST', `参数 ${name} 缺失或非法`);
  }
  return n;
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ConflictError('BAD_REQUEST', `参数 ${name} 缺失或非法`);
  }
  return v.trim();
}

function optStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** 门店账号强制本店范围；总部可任意门店 */
function resolveStore(req: Request, storeIdRaw: unknown): number {
  const storeId = num(storeIdRaw, 'storeId');
  const scoped = scopeStoreId(req, storeId);
  if (scoped === null) throw new ConflictError('FORBIDDEN', '门店账号只能操作本店数据');
  return scoped;
}

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const username = str(req.body?.username, 'username');
      const password = str(req.body?.password, 'password');
      const r = await pool().query('SELECT * FROM users WHERE username=$1', [username]);
      const u = r.rows[0];
      if (!u || !verifyPassword(password, u.password_hash)) {
        res.status(401).json({ error: { code: 'BAD_CREDENTIALS', message: '用户名或密码错误' } });
        return;
      }
      res.json({
        token: signToken(u.id),
        user: { id: u.id, username: u.username, role: u.role, storeId: u.store_id },
      });
    } catch (e) { next(e); }
  });

  app.use('/api', requireAuth);

  // ---------- 基础数据 ----------
  app.get('/api/meta', async (_req, res, next) => {
    try {
      const [stores, categories, skus, costParams, params] = await Promise.all([
        pool().query('SELECT id, code, name FROM stores ORDER BY id'),
        pool().query('SELECT id, code, name, default_cu, default_co FROM categories ORDER BY id'),
        pool().query('SELECT id, category_id, code, name, unit, min_order_unit, price, cost, is_new FROM skus ORDER BY id'),
        pool().query('SELECT store_id, category_id, cu, co FROM cost_params ORDER BY id'),
        pool().query('SELECT key, value FROM system_params'),
      ]);
      res.json({
        stores: stores.rows, categories: categories.rows, skus: skus.rows,
        costParams: costParams.rows,
        params: Object.fromEntries(params.rows.map((r) => [r.key, r.value])),
      });
    } catch (e) { next(e); }
  });

  // ---------- 需求还原样本 ----------
  app.get('/api/samples', async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.query.storeId);
      const categoryId = req.query.categoryId ? num(req.query.categoryId, 'categoryId') : null;
      const dateFrom = optStr(req.query.dateFrom) ?? '1900-01-01';
      const dateTo = optStr(req.query.dateTo) ?? '2999-12-31';
      const r = await pool().query(
        `SELECT ds.*, s.code AS sku_code, s.name AS sku_name, s.category_id, c.code AS category_code, c.name AS category_name
           FROM demand_samples ds
           JOIN skus s ON s.id = ds.sku_id
           JOIN categories c ON c.id = s.category_id
          WHERE ds.store_id=$1 AND ds.business_date BETWEEN $2 AND $3
            AND ($4::int IS NULL OR s.category_id=$4)
          ORDER BY ds.business_date DESC, s.id`,
        [storeId, dateFrom, dateTo, categoryId],
      );
      res.json({ samples: r.rows });
    } catch (e) { next(e); }
  });

  // ---------- 建议表 / 版本 ----------
  app.get('/api/suggestions', async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.query.storeId);
      const arrivalDate = str(req.query.arrivalDate, 'arrivalDate');
      const tbl = await pool().query(
        'SELECT * FROM suggestion_tables WHERE store_id=$1 AND arrival_date=$2',
        [storeId, arrivalDate],
      );
      const table = tbl.rows[0];
      if (!table) {
        res.json({ table: null, versions: [], currentVersion: null, items: [], order: null });
        return;
      }
      const versions = await pool().query(
        'SELECT id, table_id, version_no, revision_of, trigger_event, status, created_by, created_at, feature_snapshot, cost_snapshot FROM suggestion_versions WHERE table_id=$1 ORDER BY version_no DESC',
        [table.id],
      );
      const current = versions.rows[0];
      const items = current
        ? await pool().query(
            `SELECT si.*, s.code AS sku_code, s.name AS sku_name, s.unit, s.min_order_unit, s.is_new,
                    c.id AS category_id, c.code AS category_code, c.name AS category_name
               FROM suggestion_items si
               JOIN skus s ON s.id = si.sku_id
               JOIN categories c ON c.id = s.category_id
              WHERE si.version_id=$1 ORDER BY si.sku_id`,
            [current.id],
          )
        : { rows: [] };
      const orderRes = await pool().query('SELECT * FROM orders WHERE table_id=$1', [table.id]);
      const order = orderRes.rows[0] ?? null;
      let orderItems: unknown[] = [];
      if (order) {
        const oi = await pool().query(
          `SELECT oi.*, s.name AS sku_name, s.code AS sku_code FROM order_items oi JOIN skus s ON s.id=oi.sku_id WHERE oi.order_id=$1 ORDER BY oi.sku_id`,
          [order.id],
        );
        orderItems = oi.rows;
      }
      res.json({ table, versions: versions.rows, currentVersion: current ?? null, items: items.rows, order, orderItems });
    } catch (e) { next(e); }
  });

  // 生成 / 修订（同一入口；事件触发重算产生新修订版本；幂等键并表）
  app.post('/api/suggestions/generate', requireRole('hq'), async (req, res, next) => {
    try {
      const result = await generateSuggestion({
        storeId: num(req.body?.storeId, 'storeId'),
        arrivalDate: str(req.body?.arrivalDate, 'arrivalDate'),
        idempotencyKey: str(req.body?.idempotencyKey, 'idempotencyKey'),
        triggerEvent: optStr(req.body?.triggerEvent) ?? 'manual',
        features: req.body?.features ?? {},
        createdBy: req.user!.username,
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/suggestions/versions/:id', async (req, res, next) => {
    try {
      const v = await pool().query('SELECT * FROM suggestion_versions WHERE id=$1', [num(req.params.id, 'id')]);
      if (!v.rows[0]) throw new NotFoundError('版本不存在');
      const items = await pool().query(
        `SELECT si.*, s.code AS sku_code, s.name AS sku_name, c.code AS category_code, c.name AS category_name
           FROM suggestion_items si JOIN skus s ON s.id=si.sku_id JOIN categories c ON c.id=s.category_id
          WHERE si.version_id=$1 ORDER BY si.sku_id`,
        [v.rows[0].id],
      );
      res.json({ version: v.rows[0], items: items.rows });
    } catch (e) { next(e); }
  });

  // ---------- 门店确认 ----------
  app.post('/api/versions/:id/confirm', requireRole('manager'), async (req, res, next) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (items.length === 0) throw new ConflictError('BAD_REQUEST', '确认明细不能为空');
      const result = await confirmOrder({
        versionId: num(req.params.id, 'id'),
        idempotencyKey: str(req.body?.idempotencyKey, 'idempotencyKey'),
        confirmedBy: req.user!.username,
        items: items.map((it: Record<string, unknown>) => ({
          skuId: num(it.skuId, 'items.skuId'),
          qty: num(it.qty, 'items.qty'),
          reasonCode: optStr(it.reasonCode) ?? undefined,
        })),
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  // ---------- 订单 / 复盘 ----------
  app.get('/api/orders', async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.query.storeId);
      const arrivalDate = optStr(req.query.arrivalDate);
      const r = await pool().query(
        `SELECT o.*, v.version_no FROM orders o JOIN suggestion_versions v ON v.id=o.version_id
          WHERE o.store_id=$1 AND ($2::date IS NULL OR o.arrival_date=$2) ORDER BY o.arrival_date DESC`,
        [storeId, arrivalDate],
      );
      res.json({ orders: r.rows });
    } catch (e) { next(e); }
  });

  app.post('/api/orders/:id/review', async (req, res, next) => {
    try {
      const result = await createReview(num(req.params.id, 'id'));
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/reviews', async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.query.storeId);
      const arrivalDate = optStr(req.query.arrivalDate);
      const r = await pool().query(
        `SELECT r.*, v.version_no FROM reviews r JOIN suggestion_versions v ON v.id=r.version_id
          WHERE r.store_id=$1 AND ($2::date IS NULL OR r.arrival_date=$2) ORDER BY r.arrival_date DESC`,
        [storeId, arrivalDate],
      );
      const reviews = [];
      for (const review of r.rows) {
        const items = await pool().query(
          `SELECT ri.*, s.code AS sku_code, s.name AS sku_name, s.unit, c.name AS category_name, c.code AS category_code
             FROM review_items ri JOIN skus s ON s.id=ri.sku_id JOIN categories c ON c.id=s.category_id
            WHERE ri.review_id=$1 ORDER BY ri.sku_id`,
          [review.id],
        );
        reviews.push({ ...review, items: items.rows });
      }
      res.json({ reviews });
    } catch (e) { next(e); }
  });

  app.post('/api/reviews/:id/entry', async (req, res, next) => {
    try {
      await submitReviewEntry({
        reviewId: num(req.params.id, 'id'),
        skuId: num(req.body?.skuId, 'skuId'),
        actualSales: num(req.body?.actualSales, 'actualSales'),
        stockoutFlag: req.body?.stockoutFlag === null || req.body?.stockoutFlag === undefined
          ? null : Boolean(req.body.stockoutFlag),
        selloutTime: optStr(req.body?.selloutTime),
        wasteQty: req.body?.wasteQty === undefined || req.body?.wasteQty === null ? 0 : num(req.body.wasteQty, 'wasteQty'),
      });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---------- 报损单 / 盘点 ----------
  app.post('/api/waste-records', async (req, res, next) => {
    try {
      const result = await addWasteRecord({
        storeId: resolveStore(req, req.body?.storeId),
        skuId: num(req.body?.skuId, 'skuId'),
        businessDate: str(req.body?.businessDate, 'businessDate'),
        qty: num(req.body?.qty, 'qty'),
        recordedAt: req.body?.recordedAt ? new Date(req.body.recordedAt) : undefined,
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/waste-records', async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.query.storeId);
      const businessDate = optStr(req.query.businessDate);
      const r = await pool().query(
        `SELECT w.*, s.name AS sku_name, s.code AS sku_code FROM waste_records w JOIN skus s ON s.id=w.sku_id
          WHERE w.store_id=$1 AND ($2::date IS NULL OR w.business_date=$2) ORDER BY w.recorded_at DESC`,
        [storeId, businessDate],
      );
      res.json({ records: r.rows });
    } catch (e) { next(e); }
  });

  app.post('/api/stocktakes', async (req, res, next) => {
    try {
      const result = await addStocktake({
        storeId: resolveStore(req, req.body?.storeId),
        skuId: num(req.body?.skuId, 'skuId'),
        businessDate: str(req.body?.businessDate, 'businessDate'),
        actualQty: num(req.body?.actualQty, 'actualQty'),
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/stocktakes', async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.query.storeId);
      const businessDate = optStr(req.query.businessDate);
      const r = await pool().query(
        `SELECT st.*, s.name AS sku_name, s.code AS sku_code FROM stocktakes st JOIN skus s ON s.id=st.sku_id
          WHERE st.store_id=$1 AND ($2::date IS NULL OR st.business_date=$2) ORDER BY st.created_at DESC`,
        [storeId, businessDate],
      );
      res.json({ stocktakes: r.rows });
    } catch (e) { next(e); }
  });

  // ---------- 配送异常应急订货推演 ----------
  app.get('/api/emergency', async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.query.storeId);
      const arrivalDate = str(req.query.arrivalDate, 'arrivalDate');
      res.json(await openEmergency(storeId, arrivalDate));
    } catch (e) { next(e); }
  });

  // 货源登记（整箱规格/替代比例/到达时刻/重量/冷藏容积）
  app.post('/api/emergency/sources', requireRole('manager'), async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.body?.storeId);
      res.json(await registerSource(storeId, str(req.body?.arrivalDate, 'arrivalDate'), {
        code: str(req.body?.code, 'code').toUpperCase(),
        supplier: str(req.body?.supplier, 'supplier'),
        skuCode: str(req.body?.skuCode, 'skuCode'),
        targetSkuCode: str(req.body?.targetSkuCode, 'targetSkuCode'),
        availableBoxes: num(req.body?.availableBoxes, 'availableBoxes'),
        unitsPerBox: num(req.body?.unitsPerBox, 'unitsPerBox'),
        substitutionRatio: num(req.body?.substitutionRatio, 'substitutionRatio'),
        arrivalTime: str(req.body?.arrivalTime, 'arrivalTime'),
        weightPerBox: num(req.body?.weightPerBox, 'weightPerBox'),
        volumePerBox: num(req.body?.volumePerBox, 'volumePerBox'),
        sourceUnit: optStr(req.body?.sourceUnit) ?? '箱',
        vehicleSlot: str(req.body?.vehicleSlot, 'vehicleSlot'),
        unitCost: req.body?.unitCost === undefined ? 0 : num(req.body?.unitCost, 'unitCost'),
        note: optStr(req.body?.note) ?? undefined,
      }, req.user!.username));
    } catch (e) { next(e); }
  });

  // 商品优先级（1 最低 – 5 最高），变化 → 输入修订号自增
  app.post('/api/emergency/priorities', requireRole('manager'), async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.body?.storeId);
      const raw = req.body?.priorities;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ConflictError('BAD_REQUEST', '参数 priorities 缺失或非法');
      }
      res.json(await setPriorities(storeId, str(req.body?.arrivalDate, 'arrivalDate'), raw as Record<string, number>));
    } catch (e) { next(e); }
  });

  // 应用随附数据事件（供货减少 / 车辆晚到 / 部分到货 / 重复收货 / 原单晚到）
  app.post('/api/emergency/events/:key/apply', requireRole('manager'), async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.body?.storeId);
      res.json(await applyEmergencyEvent(storeId, str(req.body?.arrivalDate, 'arrivalDate'), req.params.key));
    } catch (e) { next(e); }
  });

  // 回传浏览器组合搜索结果（核对输入修订号与可供箱数）
  app.post('/api/emergency/plans', requireRole('manager'), async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.body?.storeId);
      const b = req.body ?? {};
      const kind = str(b.kind, 'kind');
      if (kind !== 'bounded' && kind !== 'lower_bound') {
        throw new ConflictError('BAD_REQUEST', '参数 kind 非法');
      }
      res.json(await submitPlan(storeId, str(b.arrivalDate, 'arrivalDate'), {
        inputRevision: num(b.inputRevision, 'inputRevision'),
        kind,
        status: str(b.status, 'status') as 'optimal' | 'feasible' | 'lower_bound',
        objective: (b.objective ?? {}) as Record<string, unknown>,
        allocation: (b.allocation ?? {}) as Record<string, number>,
        hourlyGap: b.hourlyGap ?? {},
        vehicleUsage: b.vehicleUsage ?? {},
        iterations: b.iterations === undefined ? 0 : num(b.iterations, 'iterations'),
        elapsedMs: b.elapsedMs === undefined ? 0 : num(b.elapsedMs, 'elapsedMs'),
        nodeLimitHit: Boolean(b.nodeLimitHit),
      }, req.user!.username));
    } catch (e) { next(e); }
  });

  // 店长选货 → 待确认应急单
  app.post('/api/emergency/plans/:id/select', requireRole('manager'), async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.body?.storeId);
      res.json(await selectPlan(storeId, str(req.body?.arrivalDate, 'arrivalDate'), num(req.params.id, 'id'), req.user!.username));
    } catch (e) { next(e); }
  });

  // 区域负责人（总部）确认费用 → 锁定本次选货数量
  app.post('/api/emergency/orders/:id/confirm', requireRole('hq'), async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.body?.storeId);
      res.json(await confirmEmergencyOrder(storeId, str(req.body?.arrivalDate, 'arrivalDate'), num(req.params.id, 'id'), req.user!.username));
    } catch (e) { next(e); }
  });

  // 取消应急单：已发货部分不直接释放
  app.post('/api/emergency/orders/:id/cancel', async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.body?.storeId);
      res.json(await cancelEmergencyOrder(
        storeId, str(req.body?.arrivalDate, 'arrivalDate'), num(req.params.id, 'id'),
        req.user!.username, optStr(req.body?.reason) ?? '手工取消',
      ));
    } catch (e) { next(e); }
  });

  // ---------- 统一错误处理 ----------
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ConflictError) {
      const status = err.code === 'BAD_REQUEST' ? 400 : err.code === 'FORBIDDEN' ? 403 : 409;
      res.status(status).json({ error: { code: err.code, message: err.message, details: err.details ?? null } });
      return;
    }
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
      return;
    }
    console.error(err);
    if (process.env.NODE_ENV === 'test') {
      res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误', details: String((err as Error).stack ?? err) } });
      return;
    }
    res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
  });

  return app;
}
