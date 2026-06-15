"use client";

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Send, Terminal, MessageSquare, RefreshCw, WifiOff, Wifi } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  name?: string;
  role?: string;
  title?: string;
  status?: string;
  [key: string]: unknown;
}

interface Issue {
  id?: string;
  _id?: string;
  title?: string;
  description?: string;
  status?: string;
  assigneeAgentId?: string;
  assigneeAgent?: { name?: string; id?: string };
  createdAt?: string;
  [key: string]: unknown;
}

type RunEvent = {
  type?: string;
  kind?: string;
  content?: string | unknown;
  tool?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  [key: string]: unknown;
};

type TranscriptEntry =
  | { kind: 'text'; text: string; ts: number }
  | { kind: 'tool'; tool: string; input?: unknown; output?: unknown; ts: number }
  | { kind: 'status'; text: string; ts: number }
  | { kind: 'error'; text: string; ts: number };

// ── Helpers ───────────────────────────────────────────────────────────────────

const token = () => (typeof window !== 'undefined' ? localStorage.getItem('token') : null);
const ah = (): Record<string, string> => {
  const t = token();
  return t ? { Authorization: `Bearer ${t}` } : {};
};

const issueId = (i: Issue) => i.id ?? i._id ?? '';

const statusBadge = (s?: string) => {
  const v = (s ?? '').toLowerCase();
  if (v === 'open') return 'bg-teal-500 text-white';
  if (v === 'in_progress' || v === 'in progress') return 'bg-yellow-400 text-black';
  if (v === 'closed' || v === 'done' || v === 'completed') return 'bg-zinc-600 text-zinc-200';
  return 'bg-zinc-700 text-zinc-300';
};

// Derive a readable label from a raw run event
function eventToEntry(evt: RunEvent): TranscriptEntry {
  const tool = evt.tool ?? evt.toolName ?? '';
  const kind = (evt.type ?? evt.kind ?? '').toLowerCase();
  const ts = Date.now();

  if (tool || kind === 'tool_call' || kind === 'tool_result' || kind === 'tool_use') {
    return {
      kind: 'tool',
      tool: tool || kind,
      input: evt.input,
      output: evt.output ?? (evt as any).result,
      ts,
    };
  }

  const text =
    typeof evt.content === 'string'
      ? evt.content
      : typeof (evt as any).text === 'string'
      ? (evt as any).text
      : JSON.stringify(evt);

  return { kind: 'text', text, ts };
}

// ── Transcript renderer ───────────────────────────────────────────────────────

function TranscriptEntry({ entry }: { entry: TranscriptEntry }) {
  if (entry.kind === 'status') {
    return (
      <p className="text-[10px] font-bold text-zinc-500 uppercase text-center py-1">
        — {entry.text} —
      </p>
    );
  }
  if (entry.kind === 'error') {
    return (
      <div className="border-2 border-red-500 bg-red-900/30 px-3 py-2 text-xs font-bold text-red-400 uppercase">
        ERROR: {entry.text}
      </div>
    );
  }
  if (entry.kind === 'tool') {
    return (
      <div className="border-2 border-yellow-400 bg-zinc-800 px-3 py-2 font-mono text-xs">
        <div className="flex items-center gap-2 mb-1">
          <Terminal className="w-3 h-3 text-yellow-400 shrink-0" />
          <span className="font-black text-yellow-400 uppercase">{entry.tool}</span>
        </div>
        {entry.input != null && (
          <pre className="text-zinc-400 whitespace-pre-wrap break-all text-[10px] mb-1">
            ← {JSON.stringify(entry.input, null, 2)}
          </pre>
        )}
        {entry.output != null && (
          <pre className="text-teal-400 whitespace-pre-wrap break-all text-[10px]">
            → {JSON.stringify(entry.output, null, 2)}
          </pre>
        )}
      </div>
    );
  }
  // text
  return (
    <div className="flex gap-2 items-start">
      <MessageSquare className="w-3 h-3 text-teal-400 shrink-0 mt-0.5" />
      <p className="text-sm text-zinc-100 whitespace-pre-wrap break-words">{entry.text}</p>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CFOConsolePage() {
  const router = useRouter();

  // Agents for dropdown
  const [agents, setAgents] = useState<Agent[]>([]);

  // Issue form
  const [issueTitle, setIssueTitle] = useState('');
  const [issueDesc, setIssueDesc] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Issues list
  const [issues, setIssues] = useState<Issue[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(false);

  // Live run transcript
  const [runId, setRunId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamDone, setStreamDone] = useState(false);
  const [streamConnected, setStreamConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Toast
  const [toast, setToast] = useState<string | null>(null);
  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3500); };

  // ── Auth guard
  useEffect(() => {
    const t = token();
    if (!t) { router.push('/login'); return; }
    const userStr = typeof window !== 'undefined' ? localStorage.getItem('user') : null;
    const userType = userStr ? (JSON.parse(userStr) as any).type : null;
    if (userType !== 'User') { router.push('/dashboard'); return; }
  }, [router]);

  // ── Load agents
  const loadAgents = useCallback(async () => {
    const t = token();
    if (!t) return;
    try {
      const res = await fetch('/api/paperclip/agents', { headers: ah() });
      if (res.status === 401) { router.push('/login'); return; }
      if (res.status === 403) { router.push('/dashboard'); return; }
      const data = await res.json();
      const list: Agent[] = Array.isArray(data) ? data : (data?.agents ?? data?.items ?? []);
      setAgents(list);
      if (!assigneeId && list.length > 0) setAssigneeId(list[0].id);
    } catch { /* non-fatal */ }
  }, [router, assigneeId]);

  // ── Load issues
  const loadIssues = useCallback(async () => {
    const t = token();
    if (!t) return;
    setIssuesLoading(true);
    try {
      const res = await fetch('/api/paperclip/issues', { headers: ah() });
      const data = await res.json();
      const list: Issue[] = Array.isArray(data) ? data : (data?.issues ?? data?.items ?? []);
      setIssues(list);
    } catch { /* non-fatal */ }
    setIssuesLoading(false);
  }, []);

  useEffect(() => { loadAgents(); loadIssues(); }, [loadAgents, loadIssues]);

  // ── Auto-scroll transcript
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [transcript]);

  // ── SSE stream
  const startStream = useCallback((rid: string) => {
    if (esRef.current) esRef.current.close();

    setTranscript([{ kind: 'status', text: `Connecting to run ${rid}…`, ts: Date.now() }]);
    setStreamDone(false);
    setStreamConnected(false);
    setStreaming(true);

    const t = token();
    const url = `/api/paperclip/runs/${encodeURIComponent(rid)}/stream?token=${encodeURIComponent(t ?? '')}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('status', (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data);
        setStreamConnected(true);
        setTranscript(prev => [...prev, { kind: 'status', text: d.text ?? 'Connected', ts: Date.now() }]);
      } catch { /* ignore */ }
    });

    es.addEventListener('run_event', (e: MessageEvent) => {
      try {
        const evt: RunEvent = JSON.parse(e.data);
        setTranscript(prev => [...prev, eventToEntry(evt)]);
      } catch { /* ignore malformed frame */ }
    });

    es.addEventListener('done', (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data);
        setTranscript(prev => [...prev, { kind: 'status', text: `Run ${d.status ?? 'done'}`, ts: Date.now() }]);
      } catch { /* ignore */ }
      setStreamDone(true);
      setStreaming(false);
      es.close();
    });

    es.addEventListener('error', (e: MessageEvent) => {
      let text = 'Stream error';
      try { text = JSON.parse(e.data)?.message ?? text; } catch { /* ignore */ }
      setTranscript(prev => [...prev, { kind: 'error', text, ts: Date.now() }]);
      setStreamDone(true);
      setStreaming(false);
      es.close();
    });

    es.onerror = () => { setStreamConnected(false); };

    return () => { es.close(); };
  }, []);

  useEffect(() => {
    return () => { esRef.current?.close(); };
  }, []);

  // ── Submit issue
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!issueTitle.trim()) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const body: Record<string, string> = { title: issueTitle.trim() };
      if (issueDesc.trim()) body.description = issueDesc.trim();
      if (assigneeId) body.assigneeAgentId = assigneeId;

      const res = await fetch('/api/paperclip/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ah() },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data as any)?.error ?? 'Failed to file issue');

      showToast('Issue filed!');
      setIssueTitle('');
      setIssueDesc('');
      setIssues(prev => [data as Issue, ...prev]);

      // If the response carries a runId, start streaming
      const rid = (data as any)?.runId ?? (data as any)?.run_id;
      if (rid) { setRunId(rid); startStream(rid); }
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Heartbeat (invokes run)
  const handleHeartbeat = async (agentId: string) => {
    try {
      const res = await fetch(`/api/paperclip/agents/${agentId}/heartbeat`, {
        method: 'POST',
        headers: ah(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data as any)?.error ?? 'Heartbeat failed');
      const rid = (data as any)?.runId ?? (data as any)?.run_id;
      if (rid) { setRunId(rid); startStream(rid); showToast(`Heartbeat invoked — streaming run ${rid}`); }
      else showToast('Heartbeat invoked (no run id returned)');
    } catch (err: any) {
      showToast(`Error: ${err.message}`);
    }
  };

  // ── Render
  const INPUT_CLS =
    'w-full p-3 border-4 border-black bg-black text-white font-bold text-sm placeholder-zinc-600 focus:outline-none focus:border-teal-500 transition-colors';

  return (
    <div className="min-h-[calc(100vh-76px)] flex flex-col relative w-full">
      <div className="flex-grow w-full max-w-7xl mx-auto p-4 sm:p-8 relative z-10">
        {/* Header */}
        <header className="mb-8 relative">
          <h1 className="text-4xl sm:text-5xl md:text-7xl font-permanent text-black dark:text-white leading-none tracking-tight uppercase">
            <span className="drop-shadow-[6px_6px_0px_rgba(250,204,21,1)]">CFO</span>
            <span className="text-teal-600 ml-3">
              <span className="drop-shadow-[6px_6px_0px_rgba(0,0,0,1)]">CONSOLE</span>
            </span>
          </h1>
          <p className="mt-2 text-sm font-bold text-zinc-500 uppercase tracking-widest">
            File work &amp; observe live runs
          </p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* ── LEFT COLUMN: Issue form + list ── */}
          <div className="flex flex-col gap-6">
            {/* File Issue form */}
            <div className="border-4 border-black bg-slate-900 shadow-[6px_6px_0px_0px_rgba(13,148,136,1)] p-5">
              <h2 className="text-xl font-permanent text-yellow-400 uppercase mb-4">File Work</h2>
              <form onSubmit={handleSubmit} className="flex flex-col gap-3">
                <input
                  value={issueTitle}
                  onChange={e => setIssueTitle(e.target.value)}
                  placeholder="ISSUE TITLE"
                  required
                  className={INPUT_CLS}
                />
                <textarea
                  value={issueDesc}
                  onChange={e => setIssueDesc(e.target.value)}
                  placeholder="DESCRIPTION (OPTIONAL)"
                  rows={3}
                  className={INPUT_CLS}
                />
                <div>
                  <label className="block text-xs font-black uppercase text-zinc-400 mb-1">
                    Assign To
                  </label>
                  <select
                    value={assigneeId}
                    onChange={e => setAssigneeId(e.target.value)}
                    className="w-full p-3 border-4 border-black bg-black text-white font-bold text-sm appearance-none focus:outline-none focus:border-teal-500"
                  >
                    <option value="">— Unassigned —</option>
                    {agents.map(a => (
                      <option key={a.id} value={a.id}>
                        {a.name ?? a.id} {a.title ? `(${a.title})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                {formError && (
                  <p className="text-xs font-bold text-red-400 uppercase">{formError}</p>
                )}
                <button
                  type="submit"
                  disabled={submitting || !issueTitle.trim()}
                  className="flex items-center justify-center gap-2 p-3 border-4 border-black bg-yellow-400 text-black font-black uppercase text-sm shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-yellow-300 transition-colors disabled:opacity-50"
                >
                  <Send className="w-4 h-4" />
                  {submitting ? 'FILING…' : 'FILE ISSUE'}
                </button>
              </form>
            </div>

            {/* Issues list */}
            <div className="border-4 border-black bg-slate-900 shadow-[6px_6px_0px_0px_rgba(13,148,136,1)] p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xl font-permanent text-yellow-400 uppercase">Issues</h2>
                <button
                  onClick={loadIssues}
                  disabled={issuesLoading}
                  className="border-2 border-black bg-zinc-700 text-white p-1 hover:bg-zinc-600 transition-colors disabled:opacity-50"
                  aria-label="Refresh issues"
                >
                  <RefreshCw className={`w-4 h-4 ${issuesLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>

              {issues.length === 0 && !issuesLoading && (
                <p className="text-xs font-bold text-zinc-500 uppercase text-center py-8">
                  No issues yet. File one above.
                </p>
              )}

              <div className="flex flex-col gap-3 max-h-80 overflow-y-auto pr-1">
                {issues.map((issue) => {
                  const iid = issueId(issue);
                  const assigneeName =
                    issue.assigneeAgent?.name ??
                    agents.find(a => a.id === issue.assigneeAgentId)?.name ??
                    issue.assigneeAgentId;

                  return (
                    <div
                      key={iid || issue.title}
                      className="border-2 border-zinc-700 bg-zinc-800 p-3"
                    >
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <p className="text-sm font-bold text-white truncate flex-1">
                          {issue.title ?? '(untitled)'}
                        </p>
                        <span className={`shrink-0 px-2 py-0.5 border border-black font-black text-[9px] uppercase ${statusBadge(issue.status)}`}>
                          {issue.status ?? 'open'}
                        </span>
                      </div>
                      {issue.description && (
                        <p className="text-[11px] text-zinc-400 mb-1 line-clamp-2">{issue.description}</p>
                      )}
                      {assigneeName && (
                        <p className="text-[10px] font-bold text-teal-400 uppercase">
                          Assigned: {assigneeName}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Quick heartbeat buttons */}
            {agents.length > 0 && (
              <div className="border-4 border-black bg-slate-900 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] p-5">
                <h2 className="text-xl font-permanent text-yellow-400 uppercase mb-3">
                  Quick Heartbeat
                </h2>
                <div className="flex flex-wrap gap-2">
                  {agents.map(a => (
                    <button
                      key={a.id}
                      onClick={() => handleHeartbeat(a.id)}
                      className="px-3 py-1.5 border-2 border-black bg-zinc-700 text-white font-bold text-xs uppercase hover:bg-teal-700 transition-colors"
                    >
                      {a.name ?? a.id}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── RIGHT COLUMN: Live run transcript ── */}
          <div className="flex flex-col border-4 border-black bg-slate-900 shadow-[6px_6px_0px_0px_rgba(13,148,136,1)] min-h-[520px]">
            {/* Transcript header */}
            <div className="flex items-center justify-between border-b-4 border-black px-4 py-3">
              <h2 className="text-xl font-permanent text-yellow-400 uppercase">
                Run Transcript
              </h2>
              <div className="flex items-center gap-2">
                {runId && (
                  <span className="text-[10px] font-bold text-zinc-500 uppercase font-mono truncate max-w-[120px]">
                    {runId}
                  </span>
                )}
                {streaming && (
                  <span className="flex items-center gap-1 px-2 py-0.5 border-2 border-black bg-teal-500 text-white font-black text-[10px] uppercase">
                    {streamConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                    {streamConnected ? 'LIVE' : 'CONNECTING'}
                  </span>
                )}
                {streamDone && !streaming && (
                  <span className="px-2 py-0.5 border-2 border-black bg-zinc-600 text-zinc-300 font-black text-[10px] uppercase">
                    DONE
                  </span>
                )}
              </div>
            </div>

            {/* Transcript body */}
            {!runId ? (
              <div className="flex-grow flex items-center justify-center p-8">
                <p className="font-bold text-zinc-600 uppercase text-sm text-center leading-relaxed">
                  Transcript appears when a run id is known.
                  <br />
                  <span className="text-zinc-500 text-xs">
                    Invoke a heartbeat or file an issue that triggers a run.
                  </span>
                </p>
              </div>
            ) : (
              <div
                ref={scrollRef}
                className="flex-grow overflow-y-auto p-4 space-y-3 bg-zinc-900"
              >
                {transcript.map((entry, i) => (
                  <TranscriptEntry key={i} entry={entry} />
                ))}
              </div>
            )}
          </div>
        </div>
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
