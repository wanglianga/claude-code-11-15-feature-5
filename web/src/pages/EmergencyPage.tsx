import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { useApp } from '../store';
import type {
  EmergencyCommitment, EmergencyResponse, EmergencySku, EmergencySource, Meta,
} from '../types';
import {
  solveEmergency, type SolverInput, type SolveResult,
} from '../lib/emergencySolver';

const SLOT_LABELS: Record<string, string> = { AM: '早班车', MID: '午前车', PM: '午市车', EVE: '晚市车' };
const STATUS_LABELS: Record<string, string> = {
  optimal: '已穷尽搜索 · 当前最好',
  feasible: '已找到的可行方案（未穷尽）',
  lower_bound: '忽略共享限制的对照下界',
  invalidated: '已失效',
  selected: '已选货',
  locked: '已锁定',
  superseded: '已被取代',
};
const ORDER_STATUS_LABELS: Record<string, string> = {
  awaiting_confirmation: '待区域负责人确认费用',
  confirmed: '费用已确认 · 数量已锁定',
  invalidated: '输入变化 · 已失效',
  cancelled: '已取消',
};
const COMMIT_LABELS: Record<string, string> = {
  proposed: '承诺中（未锁量）', locked: '已锁量', shipped: '已部分发货', released: '已释放', invalidated: '已失效',
};

function money(n: number) {
  return `¥${n.toFixed(2)}`;
}

function toSolverInput(
  data: EmergencyResponse,
  priorities: Record<string, number>,
  sourceLookup: Map<string, EmergencySource>,
): SolverInput {
  return {
    skus: data.skus.map((s: EmergencySku) => ({
      id: s.id, code: s.code, name: s.name, unit: s.unit,
      cu: Number(s.cu), co: Number(s.co), categoryCode: s.categoryCode,
      salesStart: s.salesStart, salesEnd: s.salesEnd,
      priority: Number(priorities[String(s.id)] ?? s.priority),
      shortDeliveryRatio: Number(s.shortDeliveryRatio),
      dailyDemandBase: Number(s.dailyDemandBase),
      demandSource: s.demandSource,
      hourlyProfile: s.hourlyProfile,
    })),
    sources: data.sources.map((s: EmergencySource) => ({
      code: s.code, supplier: s.supplier, skuCode: s.sku_code, targetSkuCode: s.target_sku_code,
      targetSkuId: s.target_sku_id, availableBoxes: Number(s.available_boxes),
      unitsPerBox: Number(s.units_per_box), substitutionRatio: Number(s.substitution_ratio),
      arrivalTime: s.arrival_time, weightPerBox: Number(s.weight_per_box),
      volumePerBox: Number(s.volume_per_box), vehicleSlot: s.vehicle_slot,
      status: s.status, excludeReason: s.exclude_reason, delayHours: Number(s.delay_hours),
      unitCost: Number(s.unit_cost ?? 0),
    })),
    receipts: data.receipts.map((r) => {
      const src = sourceLookup.get(r.source_code);
      return {
        targetSkuId: src?.target_sku_id ?? 0,
        coveredUnits: Number(r.boxes) * Number(src?.units_per_box ?? 0) * Number(src?.substitution_ratio ?? 0),
        arrivalTime: r.arrival_time,
        receiptKey: r.receipt_key,
      };
    }),
    originalOrder: data.originalOrder
      ? {
          arrivalTime: data.scenario.originalArrival,
          lateArrivalTime: data.case.originalOrderLate ? data.scenario.originalLateArrival : null,
          items: data.originalOrder.items.map((i) => ({ sku_id: i.sku_id, qty: Number(i.qty) })),
        }
      : null,
    vehicle: {
      ...data.scenario.vehicle,
      slots: ['AM', 'MID', 'PM', 'EVE'],
    },
    priorities,
  };
}

interface RunState {
  revision: number;
  bounded: SolveResult;
  independent: ReturnType<typeof solveEmergency>['independent'];
  at: string;
}

export default function EmergencyPage(_props: { meta: Meta | null }) {
  const { filters, user, showToast } = useApp();
  const [data, setData] = useState<EmergencyResponse | null>(null);
  const [priorities, setPriorities] = useState<Record<string, number>>({});
  const [run, setRun] = useState<RunState | null>(null);
  const [busy, setBusy] = useState(false);
  const [solving, setSolving] = useState(false);
  const [timeLimitMs, setTimeLimitMs] = useState(1500);
  const [form, setForm] = useState({
    code: '', supplier: '', skuCode: '', targetSkuCode: '', availableBoxes: '4',
    unitsPerBox: '10', substitutionRatio: '1', arrivalTime: '09:00',
    weightPerBox: '5', volumePerBox: '0.05', sourceUnit: '箱', vehicleSlot: 'AM', unitCost: '35',
  });
  const runIdRef = useRef(0);

  const isManager = user?.role === 'manager';
  const isHq = user?.role === 'hq';

  const load = useCallback(async () => {
    if (!filters.storeId) return;
    try {
      const r = await api<EmergencyResponse>(
        `/api/emergency?storeId=${filters.storeId}&arrivalDate=${filters.arrivalDate}`,
      );
      setData(r);
      setPriorities((prev) => {
        const next: Record<string, number> = {};
        for (const s of r.skus) next[String(s.id)] = prev[String(s.id)] ?? s.priority;
        return next;
      });
      // 输入修订号变了 → 旧计算立即失效，页面不再展示旧结果
      setRun((prev) => (prev && prev.revision !== r.case.inputRevision ? null : prev));
    } catch (e) {
      showToast(e instanceof Error ? e.message : '加载失败');
    }
  }, [filters.storeId, filters.arrivalDate]);

  useEffect(() => { load(); }, [load]);

  const invalidated = run !== null && data !== null && run.revision !== data.case.inputRevision;

  const solve = () => {
    if (!data) return;
    setSolving(true);
    // 让「计算中」先渲染出来（组合搜索是同步的）
    setTimeout(() => {
      try {
        const input = toSolverInput(data, priorities, sourceLookup);
        const result = solveEmergency(input, { timeLimitMs });
        // 回传时核对计算开始时的修订号；若期间输入已变化，服务端会以 STALE_INPUT 拒绝
        const revision = data.case.inputRevision;
        const state: RunState = { revision, bounded: result.bounded, independent: result.independent, at: new Date().toLocaleTimeString('zh-CN') };
        setRun(state);
        void persistPlans(revision, result);
      } catch (e) {
        showToast(e instanceof Error ? e.message : '计算失败');
      } finally {
        setSolving(false);
      }
    }, 30);
  };

  const persistPlans = async (revision: number, result: ReturnType<typeof solveEmergency>) => {
    if (!data) return;
    const runId = ++runIdRef.current;
    try {
      await api('/api/emergency/plans', {
        method: 'POST',
        body: {
          storeId: data.case.storeId, arrivalDate: data.case.arrivalDate,
          inputRevision: revision, kind: 'bounded', status: result.bounded.status,
          objective: result.bounded.objective, allocation: result.bounded.allocation,
          hourlyGap: result.bounded.hourlyGap, vehicleUsage: result.bounded.vehicleUsage,
          iterations: result.bounded.iterations, elapsedMs: result.bounded.elapsedMs,
          nodeLimitHit: result.bounded.nodeLimitHit,
        },
      });
      await api('/api/emergency/plans', {
        method: 'POST',
        body: {
          storeId: data.case.storeId, arrivalDate: data.case.arrivalDate,
          inputRevision: revision, kind: 'lower_bound', status: 'lower_bound',
          objective: result.independent, allocation: result.independent.allocation,
          hourlyGap: {}, vehicleUsage: result.independent.vehicleUsage,
          iterations: 0, elapsedMs: 0, nodeLimitHit: false,
        },
      });
      if (runId === runIdRef.current) await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STALE_INPUT') {
        showToast('输入已变化，迟到的搜索结果已被拒绝，不覆盖新选择');
        await load();
        setRun(null);
      } else {
        showToast(e instanceof Error ? e.message : '方案回传失败');
      }
    }
  };

  const setPriority = (skuId: number, value: number) => {
    setPriorities((p) => ({ ...p, [String(skuId)]: value }));
  };

  const savePriorities = async () => {
    if (!data) return;
    setBusy(true);
    try {
      const r = await api<{ inputRevision: number }>('/api/emergency/priorities', {
        method: 'POST',
        body: { storeId: data.case.storeId, arrivalDate: data.case.arrivalDate, priorities },
      });
      showToast(`优先级已保存，输入修订 #${r.inputRevision}，旧计算已失效`);
      setRun(null);
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '保存失败');
    } finally { setBusy(false); }
  };

  const registerSource = async () => {
    if (!data) return;
    setBusy(true);
    try {
      const r = await api<{ inputRevision: number }>('/api/emergency/sources', {
        method: 'POST',
        body: {
          storeId: data.case.storeId, arrivalDate: data.case.arrivalDate,
          code: form.code.trim().toUpperCase(),
          supplier: form.supplier.trim(),
          skuCode: form.skuCode.trim().toUpperCase(),
          targetSkuCode: (form.targetSkuCode || form.skuCode).trim().toUpperCase(),
          availableBoxes: Number(form.availableBoxes),
          unitsPerBox: Number(form.unitsPerBox),
          substitutionRatio: Number(form.substitutionRatio),
          arrivalTime: form.arrivalTime,
          weightPerBox: Number(form.weightPerBox),
          volumePerBox: Number(form.volumePerBox),
          sourceUnit: form.sourceUnit || '箱',
          vehicleSlot: form.vehicleSlot,
          unitCost: Number(form.unitCost),
        },
      });
      showToast(`货源已登记，输入修订 #${r.inputRevision}，旧计算已失效`);
      setRun(null);
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '登记失败');
    } finally { setBusy(false); }
  };

  const applyEvent = async (key: string) => {
    if (!data) return;
    setBusy(true);
    try {
      const r = await api<{ note?: string; idempotent?: boolean; stockIncreased?: boolean; inputRevision: number }>(
        `/api/emergency/events/${encodeURIComponent(key)}/apply`,
        { method: 'POST', body: { storeId: data.case.storeId, arrivalDate: data.case.arrivalDate } },
      );
      showToast(r.note ?? (r.idempotent ? '重复事件已幂等忽略' : '事件已应用'));
      setRun(null);
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '应用事件失败');
    } finally { setBusy(false); }
  };

  const selectBest = async () => {
    if (!data || !run) return;
    setBusy(true);
    try {
      const plans = await api<{ planId: number }>('/api/emergency/plans', {
        method: 'POST',
        body: {
          storeId: data.case.storeId, arrivalDate: data.case.arrivalDate,
          inputRevision: run.revision, kind: 'bounded', status: run.bounded.status,
          objective: run.bounded.objective, allocation: run.bounded.allocation,
          hourlyGap: run.bounded.hourlyGap, vehicleUsage: run.bounded.vehicleUsage,
          iterations: run.bounded.iterations, elapsedMs: run.bounded.elapsedMs,
          nodeLimitHit: run.bounded.nodeLimitHit,
        },
      });
      const r = await api<{ orderId: number }>(`/api/emergency/plans/${plans.planId}/select`, {
        method: 'POST',
        body: { storeId: data.case.storeId, arrivalDate: data.case.arrivalDate },
      });
      showToast(`已生成待确认应急单 #${r.orderId}（货源承诺中，尚未锁量）`);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        showToast(`冲突：${e.message}`);
        await load();
      } else {
        showToast(e instanceof Error ? e.message : '选货失败');
      }
    } finally { setBusy(false); }
  };

  const confirmOrder = async () => {
    if (!data?.emergencyOrder) return;
    setBusy(true);
    try {
      await api(`/api/emergency/orders/${data.emergencyOrder.id}/confirm`, {
        method: 'POST',
        body: { storeId: data.case.storeId, arrivalDate: data.case.arrivalDate },
      });
      showToast('费用已由区域负责人确认，本次选货数量已锁定');
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '确认失败');
      await load();
    } finally { setBusy(false); }
  };

  const cancelOrder = async () => {
    if (!data?.emergencyOrder) return;
    const reason = window.prompt('取消原因（已发货部分不会释放）', '原单恢复正常');
    if (reason === null) return;
    setBusy(true);
    try {
      const r = await api<{ note: string }>(`/api/emergency/orders/${data.emergencyOrder.id}/cancel`, {
        method: 'POST',
        body: { storeId: data.case.storeId, arrivalDate: data.case.arrivalDate, reason },
      });
      showToast(r.note);
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '取消失败');
    } finally { setBusy(false); }
  };

  const sourceByCode = useMemo(
    () => new Map((data?.sources ?? []).map((s) => [s.code, s])),
    [data],
  );
  const skuById = useMemo(
    () => new Map((data?.skus ?? []).map((s) => [s.id, s])),
    [data],
  );
  const sourceLookup = useMemo(
    () => new Map((data?.sources ?? []).map((s) => [s.code, s])),
    [data],
  );

  const excludedSources = (data?.sources ?? []).filter((s) => s.status === 'excluded');
  const registeredSources = (data?.sources ?? []).filter((s) => s.status !== 'excluded');
  const pendingOrder = data?.emergencyOrder && ['awaiting_confirmation', 'confirmed'].includes(data.emergencyOrder.status)
    ? data.emergencyOrder : null;
  const showStale = invalidated;

  if (!data) {
    return <div className="card muted">请选择门店与到货日，或该门店尚无应急推演数据。</div>;
  }

  return (
    <>
      <div className="card">
        <h3>
          配送异常应急订货推演
          <span className="sub">
            门店 {data.case.storeId} · 到货日 {data.case.arrivalDate} · 输入修订 #{data.case.inputRevision}
            {data.originalOrder ? ` · 原确认订单 v${data.originalOrder.versionNo}（保持不变）` : ' · 原单未确认'}
          </span>
        </h3>
        <div className="kv mb8">
          <span>需求基准：{data.skus.some((s) => s.demandSource === 'suggestion') ? '到货日建议量（分时摊开）' : '近 8 周还原需求中位'}</span>
          <span>少送判定：逐时缺口 = 分时需求 − 原单实际到货（× (1 − 少送比例)）</span>
          <span>运费：{money(data.scenario.vehicle.freightPerVehicle)}/车次 · 单车上限 {data.scenario.vehicle.weightCapKg}kg / {data.scenario.vehicle.volumeCapM3}m³</span>
          <span>每车次最多 {data.scenario.vehicle.maxVehiclesPerSlot} 辆</span>
          {data.case.originalOrderLate && <span className="badge amber">原单晚到：{data.scenario.originalLateArrival} 后才可售</span>}
        </div>
        <div className="row">
          <label className="muted">搜索时间上限
            <select value={timeLimitMs} onChange={(e) => setTimeLimitMs(Number(e.target.value))}>
              <option value={300}>300ms（很快，多为可行方案）</option>
              <option value={1500}>1500ms（默认）</option>
              <option value={5000}>5000ms（更彻底）</option>
            </select>
          </label>
          <button className="primary" disabled={solving || !data.originalOrder} onClick={solve}>
            {solving ? '分批搜索中…' : '计算方案（浏览器内分批搜索）'}
          </button>
          {showStale && <span className="badge red">输入已变化，旧计算已失效，请重新计算</span>}
          {!data.originalOrder && <span className="muted small">该到货日原确认订单缺失，无法计算少送缺口。</span>}
        </div>
      </div>

      {/* 商品优先级 + 分时需求 */}
      <div className="card">
        <h3>商品优先级与分时需求 <span className="sub">调整优先级后需重算；优先级影响缺货损失权重与报损倾向</span></h3>
        <table className="grid">
          <thead>
            <tr>
              <th>商品</th><th>品类</th><th className="num">分时需求</th><th className="num">少送比例</th>
              <th className="num">实际到货</th><th>销售时段</th><th>Cu / Co</th>
              <th>优先级（1 低 – 5 高）</th>
            </tr>
          </thead>
          <tbody>
            {data.skus.filter((s) => data.originalOrder?.items.some((i) => i.sku_id === s.id)).map((s) => {
              const ordered = Number(data.originalOrder?.items.find((i) => i.sku_id === s.id)?.qty ?? 0);
              return (
                <tr key={s.id}>
                  <td>{s.name} <span className="muted small">{s.code}</span></td>
                  <td>{s.categoryName}</td>
                  <td className="num">{s.dailyDemandBase.toFixed(1)} {s.unit}</td>
                  <td className="num">{(Number(s.shortDeliveryRatio) * 100).toFixed(0)}%</td>
                  <td className="num muted">{ordered} × {(1 - Number(s.shortDeliveryRatio)).toFixed(2)} = {(ordered * (1 - Number(s.shortDeliveryRatio))).toFixed(1)}</td>
                  <td>{s.salesStart}–{s.salesEnd}</td>
                  <td className="muted">{s.cu} / {s.co}</td>
                  <td>
                    <input
                      type="range" min={1} max={5} step={1} style={{ width: 120 }}
                      value={priorities[String(s.id)] ?? s.priority}
                      disabled={!isManager || busy}
                      onChange={(e) => setPriority(s.id, Number(e.target.value))}
                    />
                    <b style={{ marginLeft: 8 }}>{priorities[String(s.id)] ?? s.priority}</b>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {isManager && (
          <div className="row mt8">
            <button disabled={busy} onClick={savePriorities}>保存优先级并作废旧计算</button>
            <span className="muted small">保存后输入修订号自增，正在计算或未确认的方案立即失效</span>
          </div>
        )}
      </div>

      {/* 货源登记 */}
      <div className="card">
        <h3>已登记货源 <span className="sub">整箱规格 / 替代比例 / 到达时刻 / 重量 / 冷藏容积；同一箱不会分给两个方案</span></h3>
        <table className="grid">
          <thead>
            <tr>
              <th>货源</th><th>供应商</th><th>品类</th><th className="num">可供箱数</th>
              <th className="num">整箱规格</th><th className="num">替代比例</th><th>到达</th>
              <th className="num">重量/箱</th><th className="num">容积/箱</th><th className="num">成本/箱</th><th>车次</th><th>状态</th>
            </tr>
          </thead>
          <tbody>
            {registeredSources.map((s) => (
              <tr key={s.id}>
                <td>{s.code} <span className="muted small">{s.sku_name}{s.target_sku_code !== s.sku_code ? ` → ${s.target_sku_name}` : ''}</span></td>
                <td>{s.supplier}</td>
                <td>{skuById.get(s.target_sku_id)?.categoryName ?? ''}</td>
                <td className="num"><b>{Number(s.available_boxes)}</b> {s.source_unit}</td>
                <td className="num">{Number(s.units_per_box)} {skuById.get(s.target_sku_id)?.unit}/箱</td>
                <td className="num">{Number(s.substitution_ratio).toFixed(2)}</td>
                <td>{s.arrival_time}{Number(s.delay_hours) > 0 ? <span className="badge amber"> 延误 +{Number(s.delay_hours)}h</span> : ''}</td>
                <td className="num">{Number(s.weight_per_box)}kg</td>
                <td className="num">{Number(s.volume_per_box)}m³</td>
                <td className="num">{Number(s.unit_cost) > 0 ? money(Number(s.unit_cost)) : <span className="muted">—</span>}</td>
                <td>{SLOT_LABELS[s.vehicle_slot] ?? s.vehicle_slot}</td>
                <td><span className="badge green">可用</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {excludedSources.length > 0 && (
          <>
            <div className="mt16 muted small">被排除的货源（不计入可分配）：</div>
            <table className="grid mt8">
              <thead><tr><th>货源</th><th>供应商</th><th>原因</th></tr></thead>
              <tbody>
                {excludedSources.map((s) => (
                  <tr key={s.id}>
                    <td>{s.code}</td><td>{s.supplier}</td>
                    <td className="badge red" style={{ whiteSpace: 'normal' }}>{s.exclude_reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* 货源登记表单 */}
      {isManager && data.originalOrder && (
        <div className="card">
          <h3>登记货源 <span className="sub">整箱规格、替代比例、到达时刻、单箱重量与冷藏容积；登记即触发输入修订</span></h3>
          <div className="row">
            <label className="muted">编号
              <input style={{ width: 72 }} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="L12" />
            </label>
            <label className="muted">供应商
              <input style={{ width: 110 }} value={form.supplier} onChange={(e) => setForm({ ...form, supplier: e.target.value })} />
            </label>
            <label className="muted">货源商品
              <select value={form.skuCode} onChange={(e) => setForm({ ...form, skuCode: e.target.value })}>
                <option value="">选择</option>
                {data.skus.map((s) => <option key={s.id} value={s.code}>{s.name}（{s.unit}）</option>)}
              </select>
            </label>
            <label className="muted">替代目标
              <select value={form.targetSkuCode} onChange={(e) => setForm({ ...form, targetSkuCode: e.target.value })}>
                <option value="">同货源商品</option>
                {data.skus.map((s) => <option key={s.id} value={s.code}>{s.name}</option>)}
              </select>
            </label>
            <label className="muted">可供箱数
              <input type="number" min={0} style={{ width: 72 }} value={form.availableBoxes} onChange={(e) => setForm({ ...form, availableBoxes: e.target.value })} />
            </label>
            <label className="muted">每箱份数
              <input type="number" min={0} step="0.1" style={{ width: 80 }} value={form.unitsPerBox} onChange={(e) => setForm({ ...form, unitsPerBox: e.target.value })} />
            </label>
            <label className="muted">替代比例
              <input type="number" min={0} max={1} step="0.05" style={{ width: 72 }} value={form.substitutionRatio} onChange={(e) => setForm({ ...form, substitutionRatio: e.target.value })} />
            </label>
            <label className="muted">到达时刻
              <input type="time" value={form.arrivalTime} onChange={(e) => setForm({ ...form, arrivalTime: e.target.value })} />
            </label>
            <label className="muted">单箱重量kg
              <input type="number" min={0} step="0.1" style={{ width: 76 }} value={form.weightPerBox} onChange={(e) => setForm({ ...form, weightPerBox: e.target.value })} />
            </label>
            <label className="muted">单箱容积m³
              <input type="number" min={0} step="0.01" style={{ width: 80 }} value={form.volumePerBox} onChange={(e) => setForm({ ...form, volumePerBox: e.target.value })} />
            </label>
            <label className="muted">车次
              <select value={form.vehicleSlot} onChange={(e) => setForm({ ...form, vehicleSlot: e.target.value })}>
                {Object.entries(SLOT_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            </label>
            <label className="muted">每箱成本¥
              <input type="number" min={0} style={{ width: 80 }} value={form.unitCost} onChange={(e) => setForm({ ...form, unitCost: e.target.value })} />
            </label>
            <button className="primary" disabled={busy || !form.code || !form.supplier || !form.skuCode} onClick={registerSource}>
              登记货源
            </button>
          </div>
          <div className="muted small mt8">
            单位无法换算（每箱份数 ≤ 0）或到货晚于目标商品销售时段的货源会在登记后被自动排除并说明原因。
          </div>
        </div>
      )}

      {/* 计算结果 */}
      {run && (
        <div className="card">
          <h3>
            当前最好方案
            <span className="sub">
              计算于 {run.at} · 基于输入修订 #{run.revision} · 分批搜索 {run.bounded.iterations} 次 / {run.bounded.elapsedMs}ms
              · 按到达车次分批，批间累计核对共享车次与单车重量/冷藏容积
            </span>
          </h3>
          <div className={run.bounded.status === 'optimal' ? '' : 'mb8'}>
            <span className={`badge ${run.bounded.status === 'optimal' ? 'green' : 'amber'}`}>
              {STATUS_LABELS[run.bounded.status]}
            </span>
            {run.bounded.nodeLimitHit && <span className="badge amber"> 提前停止：仅可称为可行方案，不能标成最优</span>}
          </div>

          <div className="stat mt8">
            <div><b>{money(run.bounded.objective.total)}</b><span>目标总额（缺货 + 报损 + 运费）</span></div>
            <div><b>{money(run.bounded.objective.stockoutLoss)}</b><span>缺货损失（按优先级加权）</span></div>
            <div><b>{money(run.bounded.objective.wasteLoss)}</b><span>剩余鲜货报损</span></div>
            <div><b>{money(run.bounded.objective.freight)}</b><span>同车合并后运费</span></div>
            <div><b>{run.bounded.objective.stockoutUnits.toFixed(1)}</b><span>缺口份数</span></div>
          </div>

          <div className="mt8 muted small">
            本方案采购费用预览：{money(
              Object.entries(run.bounded.allocation).reduce((sum, [code, boxes]) => {
                const src = sourceLookup.get(code);
                return sum + Number(boxes) * Number(src?.unit_cost ?? 0);
              }, 0) + run.bounded.objective.freight,
            )}（箱数 × 每箱成本 + 车次运费；选货后由区域负责人确认）
          </div>

          <div className="card" style={{ background: '#fafbfa', marginTop: 16 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <b>忽略共享限制时的最低成本对照：{money(run.independent.total)}</b>
                <div className="muted small">
                  逐件挑最便宜（各商品独立最优、所有箱数合并一车），仅作对照、不可直接执行；
                  差额 {money(run.bounded.objective.total - run.independent.total)} 来自共享车次与货量争用。
                </div>
              </div>
              <span className="badge blue">下界</span>
            </div>
          </div>

          <h3 className="mt16">方案分配</h3>
          <table className="grid">
            <thead>
              <tr><th>货源</th><th>供应商</th><th>目标商品</th><th className="num">分配箱数</th><th className="num">覆盖份数</th><th>车次</th><th>备注</th></tr>
            </thead>
            <tbody>
              {Object.entries(run.bounded.allocation).filter(([, b]) => b > 0).map(([code, boxes]) => {
                const src = sourceByCode.get(code);
                const sku = src ? skuById.get(src.target_sku_id) : undefined;
                const covered = src ? Number(boxes) * Number(src.units_per_box) * Number(src.substitution_ratio) : 0;
                return (
                  <tr key={code}>
                    <td>{code}</td><td>{src?.supplier}</td><td>{sku?.name}</td>
                    <td className="num"><b>{boxes}</b></td><td className="num">{covered.toFixed(1)}</td>
                    <td>{SLOT_LABELS[src?.vehicle_slot ?? ''] ?? src?.vehicle_slot}</td>
                    <td className="small muted">{src?.note ?? ''}</td>
                  </tr>
                );
              })}
              {Object.keys(run.bounded.allocation).length === 0 && (
                <tr><td colSpan={7} className="muted">无货源分配（缺口无法由当前货源补救或无需补货）</td></tr>
              )}
            </tbody>
          </table>

          <h3 className="mt16">车辆占用核对</h3>
          <table className="grid">
            <thead><tr><th>车次</th><th className="num">车数</th><th className="num">重量</th><th className="num">冷藏容积</th><th className="num">运费</th><th>容量</th></tr></thead>
            <tbody>
              {run.bounded.vehicleUsage.map((u) => (
                <tr key={u.slot}>
                  <td>{SLOT_LABELS[u.slot] ?? u.slot}</td>
                  <td className="num">{u.vehicles}</td>
                  <td className="num">{u.weightKg}kg</td>
                  <td className="num">{u.volumeM3}m³</td>
                  <td className="num">{money(u.freight)}</td>
                  <td>{u.overCapacity ? <span className="badge red">超限</span> : <span className="badge green">未超限</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 className="mt16">逐时缺口</h3>
          <table className="grid">
            <thead>
              <tr><th>商品</th><th className="num">需求</th><th className="num">原单可售</th><th className="num">应急覆盖</th><th className="num">剩余缺口</th><th>分时缺口（需求 / 已覆盖）</th></tr>
            </thead>
            <tbody>
              {run.bounded.hourlyGap.filter((g) => g.demandUnits > 0).map((g) => (
                <tr key={g.skuId}>
                  <td>{g.skuName} <span className="badge" style={{ marginLeft: 4 }}>P{g.priority}</span></td>
                  <td className="num">{g.demandUnits.toFixed(1)}</td>
                  <td className="num">{g.originalAvailable.toFixed(1)}</td>
                  <td className="num">{g.emergencyCovered.toFixed(1)}</td>
                  <td className="num">{g.shortUnits > 0.01 ? <b style={{ color: '#b91c1c' }}>{g.shortUnits.toFixed(1)}</b> : <span className="badge green">已补齐</span>}</td>
                  <td className="small muted" style={{ whiteSpace: 'normal' }}>
                    {g.hours.map((h) => (
                      <span key={h.hour} style={{ marginRight: 8 }}>
                        {h.label} <b style={{ color: h.gap > 0.05 ? '#b45309' : 'inherit' }}>{h.demand.toFixed(1)}/{h.covered.toFixed(1)}</b>
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {run.bounded.notes.length > 0 && (
            <div className="mt16">
              <div className="muted small">说明：</div>
              <ul className="small muted" style={{ margin: '4px 0 0 18px' }}>
                {run.bounded.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </div>
          )}

          {isManager && !pendingOrder && (
            <div className="row mt16">
              <button className="primary" disabled={busy} onClick={selectBest}>
                选这个方案 → 生成待确认应急单
              </button>
              <span className="muted small">选货只登记「货源承诺」，区域负责人确认费用后才锁量</span>
            </div>
          )}
        </div>
      )}

      {/* 随附事件 */}
      <div className="card">
        <h3>随附数据事件 <span className="sub">由供货与收货变化触发；应用后输入修订号变化，旧计算立即失效</span></h3>
        <table className="grid">
          <thead><tr><th>事件</th><th>类型</th><th>状态</th><th></th></tr></thead>
          <tbody>
            {data.events.map((e) => (
              <tr key={e.key}>
                <td style={{ whiteSpace: 'normal' }}>{e.title}</td>
                <td>{e.eventType}</td>
                <td>{e.applied ? <span className="badge green">已应用</span> : <span className="badge">未应用</span>}</td>
                <td>
                  <button disabled={!isManager || busy} onClick={() => applyEvent(e.key)}>
                    {e.applied ? '再次上报（幂等验证）' : '应用事件'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(data.case.originalOrderLate || data.receipts.length > 0) && (
          <div className="kv mt8">
            {data.case.originalOrderLate && <span className="badge amber">原单晚到：需重新提示应急单是否取消</span>}
            {data.receipts.map((r) => (
              <span key={r.id}>回执 {r.receipt_key}：{r.source_code} {Number(r.boxes)} 箱 @ {r.arrival_time}</span>
            ))}
          </div>
        )}
      </div>

      {/* 应急单 */}
      {data.emergencyOrder && (
        <div className="card">
          <h3>
            应急单 #{data.emergencyOrder.id}
            <span className="sub">
              {ORDER_STATUS_LABELS[data.emergencyOrder.status]} · 选货人 {data.emergencyOrder.selected_by}
              {data.emergencyOrder.confirmed_by ? ` · 确认人 ${data.emergencyOrder.confirmed_by}` : ''}
            </span>
          </h3>
          {data.emergencyOrder.cancel_prompt && (
            <div className="badge amber mb8" style={{ display: 'block', padding: 8, whiteSpace: 'normal' }}>
              原确认订单晚到：应急单是否仍需保留？请由店长判断后{' '}
              {data.emergencyOrder.status === 'awaiting_confirmation' ? '确认或取消' : '取消（已确认单需先取消再重算）'}。
            </div>
          )}
          <div className="kv mb8">
            <span>费用合计 {money(Number(data.emergencyOrder.total_cost))}（箱数 × 每箱成本 + 车次运费，由区域负责人确认）</span>
            <span>状态：{ORDER_STATUS_LABELS[data.emergencyOrder.status] ?? data.emergencyOrder.status}</span>
            {data.emergencyOrder.cancel_reason && <span>取消原因：{data.emergencyOrder.cancel_reason}</span>}
          </div>
          <table className="grid">
            <thead><tr><th>货源</th><th>供应商</th><th className="num">承诺箱数</th><th className="num">已收箱数</th><th>承诺状态</th></tr></thead>
            <tbody>
              {data.commitments.map((c: EmergencyCommitment) => (
                <tr key={c.id}>
                  <td>{c.source_code}</td><td>{c.supplier}</td>
                  <td className="num">{c.boxes}</td><td className="num">{Number(c.received_boxes)}</td>
                  <td>{COMMIT_LABELS[c.status] ?? c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row mt8">
            {isHq && data.emergencyOrder.status === 'awaiting_confirmation' && (
              <button className="primary" disabled={busy} onClick={confirmOrder}>区域负责人确认费用并锁定数量</button>
            )}
            {isManager && ['awaiting_confirmation', 'confirmed'].includes(data.emergencyOrder.status) && (
              <button className="danger" disabled={busy} onClick={cancelOrder}>取消应急单</button>
            )}
            <span className="muted small">原订单保持不变；已发货部分取消时不会直接释放</span>
          </div>
        </div>
      )}

      {/* 历史方案 */}
      {data.plans.length > 0 && (
        <div className="card">
          <h3>方案记录 <span className="sub">计算方案与货源承诺、应急单状态分别记录</span></h3>
          <table className="grid">
            <thead>
              <tr><th>#</th><th>类型</th><th>状态</th><th className="num">输入修订</th><th className="num">目标总额</th><th className="num">搜索</th><th>时间</th></tr>
            </thead>
            <tbody>
              {data.plans.map((p) => (
                <tr key={p.id}>
                  <td>{p.id}</td>
                  <td>{p.kind === 'bounded' ? '满足共享限制' : '忽略共享限制'}</td>
                  <td>{STATUS_LABELS[p.status] ?? p.status}</td>
                  <td className="num">#{p.input_revision}</td>
                  <td className="num">{money(Number(p.objective?.total ?? 0))}</td>
                  <td className="num">{p.iterations} / {p.elapsed_ms}ms</td>
                  <td className="small muted">{new Date(p.created_at).toLocaleString('zh-CN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
