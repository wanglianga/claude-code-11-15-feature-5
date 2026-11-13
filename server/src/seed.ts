import { pool } from './db';
import { hashPassword } from './auth';
import { restoreDemand } from './lib/restore';
import { addDays, todayStr } from './lib/dates';
import { generateSuggestion, confirmOrder } from './services/suggestionService';
import { addStocktake, addWasteRecord, createReview, submitReviewEntry } from './services/reviewService';

const OPEN_HOURS = 13;

/** 确定性伪随机（种子固定，演示数据可复现） */
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fmtSellout(inStockHours: number): string {
  const totalMin = 8 * 60 + Math.round(inStockHours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export async function seedIfEmpty(): Promise<void> {
  const r = await pool().query('SELECT COUNT(*)::int AS n FROM users');
  if (r.rows[0].n > 0) return;
  console.log('[seed] 空库，写入演示数据…');
  const rand = mulberry32(20261113);
  const client = await pool().connect();
  try {
    await client.query('BEGIN');

    const stores = await client.query(
      `INSERT INTO stores (code, name) VALUES ('BJ01','朝阳门店'),('BJ02','海淀店'),('BJ03','通州店')
       RETURNING id, code`,
    );
    const storeId = (code: string) => stores.rows.find((s) => s.code === code)!.id as number;

    const cats = await client.query(
      `INSERT INTO categories (code, name, default_cu, default_co) VALUES
         ('LEAFY','叶菜', 8, 2),   -- 缺货损失含客流损失 → 临界分位 0.8（高分位）
         ('ROOT','根茎', 2, 2)     -- 临界分位 0.5（中位）
       RETURNING id, code`,
    );
    const catId = (code: string) => cats.rows.find((c) => c.code === code)!.id as number;

    // 同品类不同门店允许不同：通州店叶菜 τ=0.75，海淀店根茎 τ=0.6
    await client.query(
      `INSERT INTO cost_params (store_id, category_id, cu, co) VALUES
         ($1,$2,6,2), ($3,$4,3,2)`,
      [storeId('BJ03'), catId('LEAFY'), storeId('BJ02'), catId('ROOT')],
    );

    const skuRows = await client.query(
      `INSERT INTO skus (category_id, code, name, unit, min_order_unit, price, cost, is_new) VALUES
         ($1,'BOC01','菠菜','份',1, 6.5, 2.5, FALSE),
         ($1,'SHC02','生菜','份',1, 5.5, 2.0, FALSE),
         ($1,'YMC03','油麦菜','份',1, 4.5, 1.8, FALSE),
         ($1,'XBC04','小白菜','份',1, 5.0, 2.0, TRUE),
         ($2,'TD05','土豆','袋',5, 3.5, 2.0, FALSE),
         ($2,'HL06','胡萝卜','袋',5, 4.0, 2.2, FALSE),
         ($2,'BL07','白萝卜','袋',5, 3.0, 1.6, FALSE),
         ($2,'YC08','洋葱','袋',5, 4.5, 2.5, FALSE)
       RETURNING id, code, category_id`,
    [catId('LEAFY'), catId('ROOT')]);
    const skuId = (code: string) => skuRows.rows.find((s) => s.code === code)!.id as number;
    const LEAFY = catId('LEAFY');

    // 基础需求（朝阳门店为基准）与门店客流系数
    const baseDemand: Record<string, number> = {
      BOC01: 38, SHC02: 32, YMC03: 28, TD05: 60, HL06: 45, BL07: 40, YC08: 35,
    };
    const traffic: Record<number, number> = { [storeId('BJ01')]: 1.0, [storeId('BJ02')]: 0.85, [storeId('BJ03')]: 0.7 };

    // 历史截断观测样本：近 60 天（朝阳门店留到前天，昨天样本由复盘回流产生，演示闭环）
    const today = todayStr();
    const yesterday = addDays(today, -1);
    for (const s of stores.rows) {
      for (const sku of skuRows.rows) {
        if (sku.code === 'XBC04') continue; // 新品无历史
        const isLeafy = sku.category_id === LEAFY;
        const lastDay = s.id === storeId('BJ01') ? -2 : -1;
        for (let d = -60; d <= lastDay; d++) {
          const date = addDays(today, d);
          const dow = new Date(`${date}T00:00:00`).getDay();
          const weekly = dow === 0 || dow === 6 ? 1.25 : dow === 1 ? 0.9 : 1.0;
          const noise = 0.85 + rand() * 0.3;
          const trueDemand = baseDemand[sku.code] * traffic[s.id] * weekly * noise;

          const pStockout = isLeafy ? 0.18 : 0.08;
          const roll = rand();
          let salesQty: number, flag: boolean | null, sellout: string | null;
          if (roll < pStockout) {
            // 缺货日：实销被货架截断，有售罄时点
            const supplyRatio = 0.55 + rand() * 0.25;
            salesQty = Math.max(1, Math.round(trueDemand * supplyRatio));
            flag = true;
            sellout = fmtSellout(supplyRatio * OPEN_HOURS);
          } else if (roll < pStockout + 0.06) {
            // 断货标记缺失 → 降级保守估计
            salesQty = Math.max(1, Math.round(trueDemand));
            flag = null;
            sellout = null;
          } else {
            salesQty = Math.max(1, Math.round(trueDemand));
            flag = false;
            sellout = null;
          }

          const restored = restoreDemand({
            salesQty, openHours: OPEN_HOURS, stockoutFlag: flag, selloutTime: sellout,
          });

          // 盘点差异批次（菠菜@朝阳，3 天）：剔除出训练样本
          const isDiffBatch =
            s.id === storeId('BJ01') && sku.code === 'BOC01' && (d === -10 || d === -20 || d === -30);

          await client.query(
            `INSERT INTO demand_samples
               (store_id, sku_id, business_date, open_hours, sales_qty, stockout_flag, sellout_time,
                in_stock_hours, in_stock_rate, restored_demand, is_censored, degraded,
                excluded_from_training, exclude_reason, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'seed')
             ON CONFLICT (store_id, sku_id, business_date) DO NOTHING`,
            [
              s.id, sku.id, date, OPEN_HOURS, salesQty, flag, sellout,
              restored.inStockHours, restored.inStockRate, restored.restoredDemand,
              restored.isCensored, restored.degraded,
              isDiffBatch, isDiffBatch ? '盘点差异批次剔除' : null,
            ],
          );
        }
      }
    }

    // 系统库存快照（昨天/今天），供盘点对照
    for (const s of stores.rows) {
      for (const sku of skuRows.rows) {
        for (const d of [-1, 0]) {
          const date = addDays(today, d);
          const sysQty =
            s.id === storeId('BJ01') && sku.code === 'BOC01' && d === -1
              ? 12 // 演示：系统 12，盘点 7 → 差异 -5
              : Math.round(rand() * 15);
          await client.query(
            `INSERT INTO inventory_snapshots (store_id, sku_id, business_date, system_qty)
             VALUES ($1,$2,$3,$4) ON CONFLICT (store_id, sku_id, business_date) DO NOTHING`,
            [s.id, sku.id, date, sysQty],
          );
        }
      }
    }

    // 用户：总部 + 三门店店长
    const users: [string, string, string, number | null][] = [
      ['hq', 'hq123456', 'hq', null],
      ['store1', 'store123456', 'manager', storeId('BJ01')],
      ['store2', 'store123456', 'manager', storeId('BJ02')],
      ['store3', 'store123456', 'manager', storeId('BJ03')],
    ];
    for (const [username, pw, role, sid] of users) {
      await client.query(
        'INSERT INTO users (username, password_hash, role, store_id) VALUES ($1,$2,$3,$4)',
        [username, hashPassword(pw), role, sid],
      );
    }
    await client.query('COMMIT');
    console.log('[seed] 基础数据完成');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  // ===== 演示业务流（走服务层，保证口径一致）=====
  const storeRows = (await pool().query('SELECT id, code FROM stores ORDER BY id')).rows;
  const skuRowsAll = (await pool().query('SELECT id, code FROM skus ORDER BY id')).rows;
  const sidOf = (code: string) => storeRows.find((s) => s.code === code)!.id as number;
  const skuIdOf = (code: string) => skuRowsAll.find((s) => s.code === code)!.id as number;
  const s1 = sidOf('BJ01');
  const today = todayStr();
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);

  // 1) 昨天的建议 → 门店确认 → 复盘（朝阳门店，演示完整闭环）
  const gen = await generateSuggestion({
    storeId: s1, arrivalDate: yesterday, idempotencyKey: 'seed-gen-yesterday-s1',
    triggerEvent: 'manual', features: {}, createdBy: 'seed',
  });
  const sugItems = await pool().query(
    'SELECT sku_id, suggested_qty FROM suggestion_items WHERE version_id=$1 ORDER BY sku_id',
    [gen.versionId],
  );
  const confirmItems = sugItems.rows.map((r: { sku_id: number; suggested_qty: string }, i: number) => ({
    skuId: r.sku_id,
    qty: i === 0 ? Number(r.suggested_qty) + 6 : Number(r.suggested_qty), // 菠菜经验加量
    reasonCode: i === 0 ? '经验加量' : undefined,
  }));
  const ord = await confirmOrder({
    versionId: gen.versionId, idempotencyKey: 'seed-order-yesterday-s1',
    confirmedBy: 'store1', items: confirmItems,
  });
  const rev = await createReview(ord.orderId);

  // 2) 复盘录入：覆盖截断/降级/正常三种样本形态
  const qtyOf = (code: string) =>
    Number(sugItems.rows.find((r: { sku_id: number }) => r.sku_id === skuIdOf(code))!.suggested_qty);
  const entries: [string, boolean | null, string | null, number, number][] = [
    // [sku, 断货标记, 售罄时点, 实销, 报损]
    ['BOC01', true, '15:30', qtyOf('BOC01'), 0],           // 售罄 → 截断观测
    ['SHC02', false, null, qtyOf('SHC02') - 4, 2],
    ['YMC03', false, null, qtyOf('YMC03') - 1, 1],
    ['XBC04', null, null, Math.max(0, qtyOf('XBC04') - 2), 2], // 断货标记缺失 → 降级
    ['TD05', false, null, qtyOf('TD05') - 5, 5],
    ['HL06', false, null, qtyOf('HL06'), 0],
    ['BL07', true, '18:00', qtyOf('BL07'), 0],
    ['YC08', false, null, qtyOf('YC08') - 3, 3],
  ];
  for (const [code, flag, sellout, sales, waste] of entries) {
    await submitReviewEntry({
      reviewId: rev.reviewId, skuId: skuIdOf(code), actualSales: sales,
      stockoutFlag: flag, selloutTime: sellout, wasteQty: waste,
    });
  }

  // 3) 报损单：一张窗口内（结转重算），一张过窗（单独存档）
  await addWasteRecord({
    storeId: s1, skuId: skuIdOf('SHC02'), businessDate: yesterday, qty: 3,
    recordedAt: new Date(`${yesterday}T22:10:00`),
  });
  await addWasteRecord({
    storeId: s1, skuId: skuIdOf('BOC01'), businessDate: addDays(today, -2), qty: 5,
    recordedAt: new Date(`${yesterday}T13:00:00`),
  });

  // 4) 盘点差异：菠菜昨天系统 12 实盘 7 → 以盘点为准，差异批次样本剔除
  await addStocktake({ storeId: s1, skuId: skuIdOf('BOC01'), businessDate: yesterday, actualQty: 7 });

  // 5) 三家门店明天的建议表（首版）
  for (const s of storeRows) {
    await generateSuggestion({
      storeId: s.id, arrivalDate: tomorrow, idempotencyKey: `seed-gen-tomorrow-s${s.id}`,
      triggerEvent: 'manual', features: {}, createdBy: 'seed',
    });
  }

  // 6) 三门店明天订单均已确认（应急推演以「原确认订单」为少送基准；原单始终不变）
  const managerOf: Record<string, string> = { BJ01: 'store1', BJ02: 'store2', BJ03: 'store3' };
  for (const s of storeRows) {
    const tomorrowSug = await pool().query(
      `SELECT si.sku_id, si.suggested_qty FROM suggestion_items si
         JOIN suggestion_versions v ON v.id=si.version_id
         JOIN suggestion_tables t ON t.id=v.table_id
        WHERE t.store_id=$1 AND t.arrival_date=$2 ORDER BY si.sku_id`,
      [s.id, tomorrow],
    );
    const version = await pool().query(
      `SELECT v.id FROM suggestion_versions v JOIN suggestion_tables t ON t.id=v.table_id
        WHERE t.store_id=$1 AND t.arrival_date=$2 ORDER BY v.version_no DESC LIMIT 1`,
      [s.id, tomorrow],
    );
    await confirmOrder({
      versionId: version.rows[0].id,
      idempotencyKey: `seed-order-tomorrow-s${s.id}`,
      confirmedBy: managerOf[s.code] ?? 'store1',
      items: tomorrowSug.rows.map((r: { sku_id: number; suggested_qty: string }) => ({
        skuId: r.sku_id, qty: Number(r.suggested_qty),
      })),
    });
  }

  // 7) 应急推演会话按需建立：打开页面时才载入随附场景与货源登记
  console.log('[seed] 演示业务流完成');
}
