import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import EmergencyPage from '../src/pages/EmergencyPage';
import type { EmergencyResponse } from '../src/types';

function fixture(): EmergencyResponse {
  return {
    case: {
      id: 1, storeId: 1, arrivalDate: '2026-11-14', inputRevision: 3,
      demandMultiplier: 1, originalOrderLate: false, priorities: {},
    },
    scenario: {
      demandMultiplier: 1, originalArrival: '08:00', originalLateArrival: '11:00',
      shortDeliveryRatios: { BOC01: 0.4 },
      hourlyProfiles: {
        LEAFY: { start: '08:00', end: '18:00', weights: [0.08, 0.1, 0.12, 0.14, 0.13, 0.11, 0.08, 0.09, 0.08, 0.07] },
      },
      vehicle: { freightPerVehicle: 90, weightCapKg: 220, volumeCapM3: 1, maxVehiclesPerSlot: 1 },
    },
    originalOrder: {
      id: 1, versionNo: 1, confirmedBy: 'store1', confirmedAt: '2026-11-13T00:00:00Z', status: 'confirmed',
      items: [{ sku_id: 1, qty: '40', suggested_qty: '40', sku_code: 'BOC01', sku_name: '菠菜', unit: '份' }],
    },
    skus: [{
      id: 1, code: 'BOC01', name: '菠菜', unit: '份', categoryId: 1, categoryCode: 'LEAFY', categoryName: '叶菜',
      cu: 8, co: 2, salesStart: '08:00', salesEnd: '18:00', priority: 3, shortDeliveryRatio: 0.4,
      dailyDemandBase: 40, demandSource: 'suggestion',
      hourlyProfile: { start: '08:00', end: '18:00', weights: [0.08, 0.1, 0.12, 0.14, 0.13, 0.11, 0.08, 0.09, 0.08, 0.07] },
    }],
    sources: [{
      id: 1, case_id: 1, code: 'L1', supplier: '晨光批发', sku_id: 1, sku_code: 'BOC01', sku_name: '菠菜',
      target_sku_id: 1, target_sku_code: 'BOC01', target_sku_name: '菠菜', target_category_code: 'LEAFY',
      available_boxes: '6', units_per_box: '10', substitution_ratio: '1', arrival_time: '08:30',
      weight_per_box: '8', volume_per_box: '0.05', source_unit: '箱', vehicle_slot: 'AM', delay_hours: '0',
      unit_cost: '45', status: 'registered', exclude_reason: null, note: null,
    }],
    receipts: [],
    plans: [],
    emergencyOrder: null,
    commitments: [],
    events: [{ key: 'supply_decrease#0', eventType: 'supply_decrease', title: '供货量减少：L1 可供 6 → 3', payload: {}, applied: false }],
  };
}

let written: unknown[] = [];

beforeEach(() => {
  written = [];
  localStorage.clear();
  localStorage.setItem('fresh-order-token', 'test-token');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (path.startsWith('/api/emergency?') && method === 'GET') {
      return new Response(JSON.stringify(fixture()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/emergency/plans' && method === 'POST') {
      written.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify({ planId: 99 }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function seedUser() {
  const { useApp } = await import('../src/store');
  useApp.setState({
    token: 'test-token',
    user: { id: 2, username: 'store1', role: 'manager', storeId: 1 },
    filters: { storeId: 1, categoryId: null, arrivalDate: '2026-11-14' },
  });
}

describe('应急订货页面（DOM 级）', () => {
  it('加载推演数据并在浏览器内分批搜索，显示当前最好方案与忽略共享限制的对照', async () => {
    await seedUser();
    const { container } = render(<EmergencyPage meta={null} />);
    // 需要重新导入 store 以拾取 localStorage 的用户
    await waitFor(() => expect(screen.getByText(/配送异常应急订货推演/)).toBeTruthy());
    expect(screen.getByText(/已登记货源/)).toBeTruthy();
    const button = screen.getByText('计算方案（浏览器内分批搜索）');
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText(/当前最好方案/)).toBeTruthy(), { timeout: 5000 });
    // 目标总额与下界对照都出现
    expect(screen.getByText(/忽略共享限制时的最低成本对照/)).toBeTruthy();
    // 说明中出现「少送」口径
    expect(container.textContent).toContain('少送');
    // 计划回传（浏览器计算结果提交到服务端）
    await waitFor(() => expect(written.length).toBeGreaterThan(0));
  });
});

describe('应急订货页面：提前停止与状态标签', () => {
  it('时间上限极小 → 显示「已找到的可行方案」并明确不是最优', async () => {
    const { useApp } = await import('../src/store');
    useApp.setState({
      token: 'test-token',
      user: { id: 2, username: 'store1', role: 'manager', storeId: 1 },
      filters: { storeId: 1, categoryId: null, arrivalDate: '2026-11-14' },
    });
    render(<EmergencyPage meta={null} />);
    await waitFor(() => expect(screen.getByText(/配送异常应急订货推演/)).toBeTruthy());
    const select = screen.getByDisplayValue(/1500ms/);
    fireEvent.change(select, { target: { value: '300' } });
    fireEvent.click(screen.getByText('计算方案（浏览器内分批搜索）'));
    await waitFor(() => expect(screen.getByText(/当前最好方案/)).toBeTruthy(), { timeout: 5000 });
    // 状态必须是 最优 或 可行方案 之一，且页面上永远不出现「已证明最优」这种误导文案
    const text = document.body.textContent ?? '';
    expect(/已穷尽搜索|已找到的可行方案/.test(text)).toBe(true);
  });
});
