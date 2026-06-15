"use client";

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Pencil, X, Pause, Play, RefreshCw } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  name?: string;
  role?: string;
  title?: string;
  status?: string;
  budgetMonthlyCents?: number;
  spentMonthlyCents?: number;
  [key: string]: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const token = () => (typeof window !== 'undefined' ? localStorage.getItem('token') : null);
const ah = (): Record<string, string> => {
  const t = token();
  return t ? { Authorization: `Bearer ${t}` } : {};
};

const centsToDisplay = (c?: number) =>
  c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const pctOf = (spent?: number, budget?: number) =>
  budget && budget > 0 ? Math.min(((spent ?? 0) / budget) * 100, 100) : null;

const pctColor = (pct: number | null) => {
  if (pct == null) return 'bg-zinc-600';
  if (pct >= 100) return 'bg-red-500';
  if (pct >= 80) return 'bg-yellow-400';
  return 'bg-teal-500';
};

const pctTextColor = (pct: number | null) => {
  if (pct == null) return 'text-zinc-400';
  if (pct >= 100) return 'text-red-400';
  if (pct >= 80) return 'text-yellow-400';
  return 'text-teal-400';
};

const statusBadge = (s?: string) => {
  const v = (s ?? '').toLowerCase();
  if (v === 'active' || v === 'running') return 'bg-teal-500 text-white';
  if (v === 'paused') return 'bg-yellow-400 text-black';
  if (v === 'error' || v === 'failed') return 'bg-red-500 text-white';
  return 'bg-zinc-600 text-zinc-200';
};

// ── Budget row ────────────────────────────────────────────────────────────────

function AgentRow({
  agent,
  onUpdated,
  onToast,
}: {
  agent: Agent;
  onUpdated: (updated: Agent) => void;
  onToast: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [budgetInput, setBudgetInput] = useState(
    agent.budgetMonthlyCents != null ? String(agent.budgetMonthlyCents / 100) : ''
  );
  const [saving, setSaving] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const spent = agent.spentMonthlyCents;
  const budget = agent.budgetMonthlyCents;
  const pct = pctOf(spent, budget);
  const isPaused = (agent.status ?? '').toLowerCase() === 'paused';

  const saveBudget = async () => {
    const dollars = parseFloat(budgetInput);
    if (isNaN(dollars) || dollars < 0) {
      onToast('Enter a valid dollar amount');
      return;
    }
    const cents = Math.round(dollars * 100);
    setSaving(true);
    try {
      const res = await fetch(`/api/paperclip/agents/${agent.id}/budget`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...ah() },
        body: JSON.stringify({ budgetMonthlyCents: cents }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data as any)?.error ?? 'Save failed');
      onUpdated({ ...agent, budgetMonthlyCents: cents, ...(data as Partial<Agent>) });
      setEditing(false);
      onToast(`Budget updated for ${agent.name ?? agent.id}`);
    } catch (err: any) {
      onToast(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const doAction = async (action: 'pause' | 'resume') => {
    setActionBusy(true);
    try {
      const res = await fetch(`/api/paperclip/agents/${agent.id}/${action}`, {
        method: 'POST',
        headers: ah(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data as any)?.error ?? `${action} failed`);
      onUpdated({ ...agent, status: action === 'pause' ? 'paused' : 'active', ...(data as Partial<Agent>) });
      onToast(`${action === 'pause' ? 'Paused' : 'Resumed'} ${agent.name ?? agent.id}`);
    } catch (err: any) {
      onToast(`Error: ${err.message}`);
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <tr className="border-b-2 border-zinc-700 hover:bg-zinc-800/60 transition-colors group">
      {/* Name / role */}
      <td className="px-4 py-3 whitespace-nowrap">
        <p className="font-bold text-white text-sm">{agent.name ?? agent.id}</p>
        <p className="text-[10px] font-bold text-zinc-500 uppercase">{agent.title ?? agent.role ?? '—'}</p>
      </td>

      {/* Status */}
      <td className="px-4 py-3 whitespace-nowrap">
        <span className={`px-2 py-0.5 border border-black font-black text-[9px] uppercase ${statusBadge(agent.status)}`}>
          {agent.status ?? '?'}
        </span>
      </td>

      {/* Budget */}
      <td className="px-4 py-3 whitespace-nowrap">
        {editing ? (
          <div className="flex items-center gap-1">
            <span className="text-zinc-400 font-bold text-sm">$</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={budgetInput}
              onChange={e => setBudgetInput(e.target.value)}
              className="w-24 px-2 py-1 border-2 border-teal-500 bg-black text-white font-bold text-sm focus:outline-none"
              autoFocus
              onKeyDown={e => { if (e.key === 'Enter') saveBudget(); if (e.key === 'Escape') setEditing(false); }}
            />
            <button
              onClick={saveBudget}
              disabled={saving}
              className="p-1 border-2 border-teal-500 bg-teal-600 text-white hover:bg-teal-500 transition-colors disabled:opacity-50"
              aria-label="Save budget"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setEditing(false)}
              className="p-1 border-2 border-zinc-600 bg-zinc-700 text-white hover:bg-zinc-600 transition-colors"
              aria-label="Cancel"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="font-bold text-white text-sm">{centsToDisplay(budget)}</span>
            <button
              onClick={() => { setBudgetInput(budget != null ? String(budget / 100) : ''); setEditing(true); }}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-1 border border-zinc-600 bg-zinc-700 text-zinc-300 hover:text-white"
              aria-label="Edit budget"
            >
              <Pencil className="w-3 h-3" />
            </button>
          </div>
        )}
      </td>

      {/* Spent */}
      <td className="px-4 py-3 whitespace-nowrap">
        <span className="font-bold text-white text-sm">{centsToDisplay(spent)}</span>
      </td>

      {/* % used with bar */}
      <td className="px-4 py-3 min-w-[120px]">
        <div className="flex items-center gap-2">
          <div className="flex-grow h-2 border border-zinc-600 bg-zinc-700 min-w-[60px]">
            {pct != null && (
              <div
                className={`h-full transition-all ${pctColor(pct)}`}
                style={{ width: `${pct}%` }}
              />
            )}
          </div>
          <span className={`text-[10px] font-black uppercase whitespace-nowrap ${pctTextColor(pct)}`}>
            {pct != null ? `${pct.toFixed(0)}%` : '—'}
          </span>
        </div>
      </td>

      {/* Actions */}
      <td className="px-4 py-3 whitespace-nowrap">
        <button
          onClick={() => doAction(isPaused ? 'resume' : 'pause')}
          disabled={actionBusy}
          className="flex items-center gap-1 px-3 py-1.5 border-2 border-black font-black uppercase text-xs hover:bg-zinc-700 transition-colors disabled:opacity-50 text-white"
          aria-label={isPaused ? 'Resume agent' : 'Pause agent'}
        >
          {isPaused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
          {isPaused ? 'RESUME' : 'PAUSE'}
        </button>
      </td>
    </tr>
  );
}

// ── Costs section ─────────────────────────────────────────────────────────────

function CostsSection() {
  const [costs, setCosts] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/paperclip/costs', { headers: ah() });
      const data = await res.json();
      if (!res.ok) throw new Error((data as any)?.error ?? 'Failed to load costs');
      setCosts(data);
      setLoaded(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Try to render costs as key-value cards if it's an object/array with obvious structure
  const renderCosts = (data: unknown) => {
    if (data == null) return null;

    // Array of cost records
    if (Array.isArray(data)) {
      return (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {data.map((item, i) => {
            if (typeof item === 'object' && item !== null) {
              const keys = Object.keys(item as object);
              // Simple label/value card
              const labelKey = keys.find(k => ['name', 'label', 'agent', 'category', 'title'].includes(k));
              const valueKey = keys.find(k => ['cost', 'amount', 'total', 'spent', 'value', 'cents'].includes(k));
              if (labelKey && valueKey) {
                const raw = (item as any)[valueKey];
                const display =
                  typeof raw === 'number' && (valueKey.includes('cent') || valueKey.includes('Cost'))
                    ? centsToDisplay(raw)
                    : String(raw);
                return (
                  <div key={i} className="border-2 border-zinc-700 bg-zinc-800 p-3">
                    <p className="text-[10px] font-black uppercase text-zinc-400 mb-1">{(item as any)[labelKey]}</p>
                    <p className="text-lg font-permanent text-teal-400">{display}</p>
                  </div>
                );
              }
            }
            return null;
          })}
        </div>
      );
    }

    // Object with obvious numeric fields — render as cards
    if (typeof data === 'object' && data !== null) {
      const entries = Object.entries(data as object);
      const allNumeric = entries.every(([, v]) => typeof v === 'number');
      if (allNumeric && entries.length > 0 && entries.length <= 12) {
        return (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {entries.map(([k, v]) => (
              <div key={k} className="border-2 border-zinc-700 bg-zinc-800 p-3">
                <p className="text-[10px] font-black uppercase text-zinc-400 mb-1">{k.replace(/([A-Z])/g, ' $1').trim()}</p>
                <p className="text-lg font-permanent text-teal-400">
                  {k.toLowerCase().includes('cent') ? centsToDisplay(v) : String(v)}
                </p>
              </div>
            ))}
          </div>
        );
      }
    }

    // Fallback: pretty JSON
    return (
      <pre className="p-4 bg-black border-2 border-zinc-700 text-xs text-zinc-300 overflow-x-auto whitespace-pre-wrap break-all font-mono">
        {JSON.stringify(data, null, 2)}
      </pre>
    );
  };

  return (
    <div className="border-4 border-black bg-slate-900 shadow-[6px_6px_0px_0px_rgba(13,148,136,1)] p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-permanent text-yellow-400 uppercase">Costs</h2>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 border-4 border-black bg-zinc-700 text-white font-black uppercase text-xs shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:bg-zinc-600 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          {loaded ? 'REFRESH' : 'LOAD COSTS'}
        </button>
      </div>

      {error && (
        <div className="p-3 border-2 border-red-500 bg-red-900/30 font-bold text-red-400 uppercase text-xs">
          {error}
        </div>
      )}

      {!loaded && !loading && !error && (
        <p className="text-sm font-bold text-zinc-600 uppercase text-center py-8">
          Click "Load Costs" to fetch cost data.
        </p>
      )}

      {loaded && costs != null && renderCosts(costs)}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BudgetsPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3500); };

  const loadAgents = useCallback(async () => {
    const t = token();
    if (!t) { router.push('/login'); return; }
    const userStr = typeof window !== 'undefined' ? localStorage.getItem('user') : null;
    const userType = userStr ? (JSON.parse(userStr) as any).type : null;
    if (userType !== 'User') { router.push('/dashboard'); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/paperclip/agents', { headers: ah() });
      if (res.status === 401) { router.push('/login'); return; }
      if (res.status === 403) { router.push('/dashboard'); return; }
      const data = await res.json();
      if (!res.ok) throw new Error((data as any)?.error ?? 'Failed to load agents');
      const list: Agent[] = Array.isArray(data) ? data : (data?.agents ?? data?.items ?? []);
      setAgents(list);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { loadAgents(); }, [loadAgents]);

  const handleUpdated = (updated: Agent) => {
    setAgents(prev => prev.map(a => a.id === updated.id ? { ...a, ...updated } : a));
  };

  return (
    <div className="min-h-[calc(100vh-76px)] flex flex-col relative w-full">
      <div className="flex-grow w-full max-w-7xl mx-auto p-4 sm:p-8 relative z-10">
        {/* Header */}
        <header className="mb-8 relative">
          <h1 className="text-4xl sm:text-5xl md:text-7xl font-permanent text-black dark:text-white leading-none tracking-tight uppercase">
            <span className="drop-shadow-[6px_6px_0px_rgba(250,204,21,1)]">BUDGETS</span>
          </h1>
          <p className="mt-2 text-sm font-bold text-zinc-500 uppercase tracking-widest">
            Agent spend tracking &amp; controls
          </p>
        </header>

        {/* Refresh */}
        <div className="flex gap-3 mb-6">
          <button
            onClick={loadAgents}
            disabled={loading}
            className="flex items-center gap-2 px-5 py-2 border-4 border-black bg-yellow-400 text-black font-black uppercase text-sm shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-yellow-300 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'LOADING…' : 'REFRESH'}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-6 p-4 border-4 border-red-500 bg-red-900/30 font-bold text-red-400 uppercase text-sm">
            {error}
          </div>
        )}

        {/* Legend */}
        <div className="flex items-center gap-4 mb-4 text-xs font-black uppercase">
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 bg-teal-500 border border-black" />{'<'} 80%</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 bg-yellow-400 border border-black" />&ge; 80%</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 bg-red-500 border border-black" />100%+</span>
        </div>

        {/* Agents budget table */}
        <div className="border-4 border-black bg-slate-900 shadow-[6px_6px_0px_0px_rgba(13,148,136,1)] overflow-x-auto mb-10">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b-4 border-black bg-zinc-800">
                <th className="px-4 py-3 text-left font-black uppercase text-zinc-300 text-xs">Agent</th>
                <th className="px-4 py-3 text-left font-black uppercase text-zinc-300 text-xs">Status</th>
                <th className="px-4 py-3 text-left font-black uppercase text-zinc-300 text-xs">Budget / mo</th>
                <th className="px-4 py-3 text-left font-black uppercase text-zinc-300 text-xs">Spent / mo</th>
                <th className="px-4 py-3 text-left font-black uppercase text-zinc-300 text-xs min-w-[140px]">% Used</th>
                <th className="px-4 py-3 text-left font-black uppercase text-zinc-300 text-xs">Actions</th>
              </tr>
            </thead>
            <tbody>
              {!loading && agents.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center font-bold text-zinc-600 uppercase text-sm">
                    No agents found — check PAPERCLIP_COMPANY_ID config.
                  </td>
                </tr>
              )}
              {agents.map(agent => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  onUpdated={handleUpdated}
                  onToast={showToast}
                />
              ))}
            </tbody>
          </table>
        </div>

        {/* Costs section */}
        <CostsSection />
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 border-4 border-black bg-teal-600 text-white font-black uppercase text-sm px-5 py-3 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
          {toast}
        </div>
      )}
    </div>
  );
}
