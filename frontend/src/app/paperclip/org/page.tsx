"use client";

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, Heart, Pause, Play, Activity } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  name?: string;
  role?: string;
  title?: string;
  status?: string;
  budgetMonthlyCents?: number;
  spentMonthlyCents?: number;
  reportsTo?: string | null;
  capabilities?: string[];
  chainOfCommand?: string[];
  [key: string]: unknown;
}

interface OrgNode {
  agent: Agent;
  children: OrgNode[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const token = () => (typeof window !== 'undefined' ? localStorage.getItem('token') : null);

const authHeaders = (): Record<string, string> => {
  const t = token();
  return t ? { Authorization: `Bearer ${t}` } : {};
};

const centsToDisplay = (cents?: number) =>
  cents == null ? '—' : `$${(cents / 100).toFixed(2)}`;

const statusColor = (status?: string) => {
  const s = (status ?? '').toLowerCase();
  if (s === 'active' || s === 'running') return 'bg-teal-500 text-white';
  if (s === 'paused') return 'bg-yellow-400 text-black';
  if (s === 'error' || s === 'failed') return 'bg-red-500 text-white';
  return 'bg-zinc-600 text-zinc-200';
};

// Build tree from flat agent list
function buildTree(agents: Agent[]): OrgNode[] {
  const byId = new Map<string, OrgNode>();
  for (const a of agents) byId.set(a.id, { agent: a, children: [] });

  const roots: OrgNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.agent.reportsTo;
    if (parentId && byId.has(parentId)) {
      byId.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

// ── Detail Panel ──────────────────────────────────────────────────────────────

function AgentDetail({
  agent,
  onClose,
  onAction,
}: {
  agent: Agent;
  onClose: () => void;
  onAction: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  const doAction = async (path: string, label: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/paperclip/agents/${agent.id}/${path}`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as any)?.error ?? `${label} failed`);
      onAction(`${label} sent for ${agent.name ?? agent.id}`);
    } catch (err: any) {
      onAction(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const isPaused = (agent.status ?? '').toLowerCase() === 'paused';
  const spent = agent.spentMonthlyCents ?? 0;
  const budget = agent.budgetMonthlyCents ?? 0;
  const pct = budget > 0 ? Math.min((spent / budget) * 100, 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg bg-slate-900 border-4 border-black dark:border-white shadow-[10px_10px_0px_0px_rgba(13,148,136,1)] p-6 overflow-y-auto max-h-[90vh]">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-2xl font-permanent text-yellow-400 uppercase">
              {agent.name ?? agent.id}
            </h2>
            <p className="text-sm font-bold text-zinc-400 uppercase tracking-widest">
              {agent.title ?? agent.role ?? ''}
            </p>
          </div>
          <button
            onClick={onClose}
            className="ml-4 border-4 border-black bg-zinc-700 text-white font-black px-3 py-1 uppercase text-xs hover:bg-zinc-500 transition-colors"
          >
            CLOSE
          </button>
        </div>

        {/* Status badge */}
        <span className={`inline-block px-3 py-1 border-2 border-black font-black text-xs uppercase mb-4 ${statusColor(agent.status)}`}>
          {agent.status ?? 'unknown'}
        </span>

        {/* Budget bar */}
        <div className="mb-4">
          <div className="flex justify-between text-xs font-bold uppercase text-zinc-400 mb-1">
            <span>Budget Used</span>
            <span>{centsToDisplay(spent)} / {centsToDisplay(budget > 0 ? budget : undefined)}</span>
          </div>
          <div className="h-3 border-2 border-black bg-zinc-700">
            <div
              className={`h-full transition-all ${pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-400' : 'bg-teal-500'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {/* Capabilities */}
        {Array.isArray(agent.capabilities) && agent.capabilities.length > 0 && (
          <div className="mb-4">
            <p className="text-xs font-black uppercase text-teal-400 mb-1">Capabilities</p>
            <div className="flex flex-wrap gap-2">
              {agent.capabilities.map((c, i) => (
                <span key={i} className="px-2 py-0.5 border-2 border-black bg-zinc-700 text-white text-xs font-bold uppercase">
                  {c}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 mt-4">
          <button
            disabled={busy}
            onClick={() => doAction(isPaused ? 'resume' : 'pause', isPaused ? 'Resume' : 'Pause')}
            className="flex items-center gap-2 px-4 py-2 border-4 border-black font-black uppercase text-sm shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] bg-yellow-400 text-black hover:bg-yellow-300 transition-colors disabled:opacity-50"
          >
            {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
            {isPaused ? 'RESUME' : 'PAUSE'}
          </button>
          <button
            disabled={busy}
            onClick={() => doAction('heartbeat', 'Heartbeat')}
            className="flex items-center gap-2 px-4 py-2 border-4 border-black font-black uppercase text-sm shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] bg-teal-600 text-white hover:bg-teal-500 transition-colors disabled:opacity-50"
          >
            <Activity className="w-4 h-4" />
            INVOKE HEARTBEAT
          </button>
        </div>

        {/* Raw JSON collapsible */}
        <details className="mt-6 border-2 border-zinc-700">
          <summary className="cursor-pointer px-3 py-2 text-xs font-black uppercase text-zinc-400 bg-zinc-800 hover:bg-zinc-700 transition-colors">
            Raw JSON
          </summary>
          <pre className="p-3 text-xs text-zinc-300 overflow-x-auto bg-black font-mono whitespace-pre-wrap break-all">
            {JSON.stringify(agent, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}

// ── Tree Node Card ─────────────────────────────────────────────────────────────

function OrgCard({
  node,
  onSelect,
}: {
  node: OrgNode;
  onSelect: (a: Agent) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const { agent } = node;
  const spent = agent.spentMonthlyCents ?? 0;
  const budget = agent.budgetMonthlyCents ?? 0;
  const pct = budget > 0 ? Math.min((spent / budget) * 100, 100) : 0;
  const hasChildren = node.children.length > 0;

  return (
    <div className="flex flex-col items-center">
      {/* Card */}
      <div
        className="w-56 border-4 border-black bg-slate-800 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] cursor-pointer hover:shadow-[6px_6px_0px_0px_rgba(13,148,136,1)] transition-shadow group select-none"
        onClick={() => onSelect(agent)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onSelect(agent)}
        aria-label={`View details for ${agent.name ?? agent.id}`}
      >
        <div className="p-3">
          <p className="font-permanent text-sm text-yellow-400 uppercase truncate group-hover:text-teal-400 transition-colors">
            {agent.name ?? agent.id}
          </p>
          <p className="text-[10px] font-bold text-zinc-400 uppercase truncate">
            {agent.title ?? agent.role ?? 'Agent'}
          </p>
          <span className={`mt-1 inline-block px-2 py-0.5 border border-black font-black text-[9px] uppercase ${statusColor(agent.status)}`}>
            {agent.status ?? '?'}
          </span>
        </div>
        {/* Mini budget bar */}
        <div className="mx-3 mb-3">
          <div className="h-1.5 border border-black bg-zinc-700">
            <div
              className={`h-full ${pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-400' : 'bg-teal-500'}`}
              style={{ width: `${Math.max(pct, budget > 0 ? 0 : 0)}%` }}
            />
          </div>
          <p className="text-[9px] font-bold text-zinc-500 mt-0.5 text-right">
            {centsToDisplay(spent)} / {budget > 0 ? centsToDisplay(budget) : '—'}
          </p>
        </div>
      </div>

      {/* Expand/collapse toggle & children */}
      {hasChildren && (
        <>
          {/* Connector line + toggle */}
          <div className="flex flex-col items-center">
            <div className="w-0.5 h-4 bg-zinc-600" />
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
              className="border-2 border-zinc-600 bg-zinc-800 text-zinc-400 hover:text-teal-400 p-0.5 transition-colors"
              aria-label={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </button>
          </div>

          {expanded && (
            <>
              <div className="w-0.5 h-4 bg-zinc-600" />
              {/* Horizontal line spanning children */}
              <div className="flex items-start gap-8 relative">
                {node.children.length > 1 && (
                  <div
                    className="absolute top-0 left-1/2 -translate-x-1/2 h-0.5 bg-zinc-600"
                    style={{ width: `calc(100% - ${100 / node.children.length}%)` }}
                  />
                )}
                {node.children.map((child) => (
                  <div key={child.agent.id} className="flex flex-col items-center">
                    <div className="w-0.5 h-4 bg-zinc-600" />
                    <OrgCard node={child} onSelect={onSelect} />
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OrgChartPage() {
  const router = useRouter();
  const [roots, setRoots] = useState<OrgNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const loadOrg = useCallback(async () => {
    setLoading(true);
    setError(null);
    const t = token();
    if (!t) { router.push('/login'); return; }

    try {
      const res = await fetch('/api/paperclip/org', {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (res.status === 401) { router.push('/login'); return; }
      const data = await res.json();
      if (!res.ok) throw new Error((data as any)?.error ?? 'Failed to load org');

      // Accept { agents: [...] }, { nodes: [...] }, or a bare array
      const raw: Agent[] = Array.isArray(data)
        ? data
        : (data?.agents ?? data?.nodes ?? data?.members ?? []);

      setRoots(buildTree(raw));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { loadOrg(); }, [loadOrg]);

  return (
    <div className="min-h-[calc(100vh-76px)] flex flex-col relative w-full">
      <div className="flex-grow w-full max-w-7xl mx-auto p-4 sm:p-8 relative z-10">
        {/* Header */}
        <header className="mb-10 relative">
          <h1 className="text-4xl sm:text-5xl md:text-7xl font-permanent text-black dark:text-white leading-none tracking-tight uppercase">
            <span className="drop-shadow-[6px_6px_0px_rgba(250,204,21,1)]">ORG</span>
            <span className="text-teal-600 ml-3">
              <span className="drop-shadow-[6px_6px_0px_rgba(0,0,0,1)]">CHART</span>
            </span>
          </h1>
          <p className="mt-2 text-sm font-bold text-zinc-500 uppercase tracking-widest">
            Paperclip Agent Hierarchy
          </p>
        </header>

        {/* Controls */}
        <div className="flex gap-3 mb-8">
          <button
            onClick={loadOrg}
            disabled={loading}
            className="px-5 py-2 border-4 border-black bg-yellow-400 text-black font-black uppercase text-sm shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-yellow-300 transition-colors disabled:opacity-50"
          >
            {loading ? 'LOADING…' : 'REFRESH'}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-6 p-4 border-4 border-red-500 bg-red-900/30 font-bold text-red-400 uppercase text-sm">
            {error}
          </div>
        )}

        {/* Org Tree */}
        {!loading && !error && roots.length === 0 && (
          <p className="font-bold text-zinc-500 uppercase text-center py-24 text-lg">
            No agents found — check PAPERCLIP_COMPANY_ID config.
          </p>
        )}

        {!loading && roots.length > 0 && (
          <div className="overflow-x-auto pb-8">
            <div className="flex gap-16 items-start justify-center">
              {roots.map((root) => (
                <OrgCard key={root.agent.id} node={root} onSelect={setSelected} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selected && (
        <AgentDetail
          agent={selected}
          onClose={() => setSelected(null)}
          onAction={(msg) => { showToast(msg); setSelected(null); }}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 border-4 border-black bg-teal-600 text-white font-black uppercase text-sm px-5 py-3 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
          {toast}
        </div>
      )}
    </div>
  );
}
