import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { useApp } from './store';
import type { Meta } from './types';
import LoginPage from './pages/LoginPage';
import SamplesPage from './pages/SamplesPage';
import SuggestionsPage from './pages/SuggestionsPage';
import ReviewPage from './pages/ReviewPage';
import EmergencyPage from './pages/EmergencyPage';
import FilterBar from './components/FilterBar';

function Shell() {
  const { user, logout, toast } = useApp();
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => {
    api<Meta>('/api/meta').then(setMeta).catch(() => setMeta(null));
  }, []);

  return (
    <>
      <header className="topbar">
        <div className="brand">生鲜订货决策</div>
        <nav>
          <NavLink to="/samples">需求还原</NavLink>
          <NavLink to="/suggestions">建议与订货</NavLink>
          <NavLink to="/review">收市复盘</NavLink>
          <NavLink to="/emergency">应急订货</NavLink>
        </nav>
        <div className="user">
          <span>
            {user?.username}（{user?.role === 'hq' ? '总部' : '门店'}）
          </span>
          <button onClick={logout}>退出</button>
        </div>
      </header>
      <FilterBar meta={meta} />
      <main className="page">
        <Routes>
          <Route path="/" element={<Navigate to="/suggestions" replace />} />
          <Route path="/samples" element={<SamplesPage meta={meta} />} />
          <Route path="/suggestions" element={<SuggestionsPage meta={meta} />} />
          <Route path="/review" element={<ReviewPage meta={meta} />} />
          <Route path="/emergency" element={<EmergencyPage meta={meta} />} />
          <Route path="*" element={<Navigate to="/suggestions" replace />} />
        </Routes>
      </main>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

export default function App() {
  const token = useApp((s) => s.token);
  if (!token) return <LoginPage />;
  return <Shell />;
}
