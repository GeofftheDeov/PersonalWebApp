import express, { Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { auth } from '../middleware/auth.js';
import CloudClawSession from '../models/CloudClawSession.js';
import mongoose from 'mongoose';

const router = express.Router();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

const MODEL = 'claude-sonnet-4-6';
const MAX_HISTORY = 40; // stored message entries (user + assistant pairs = 20 exchanges)

const SYSTEM_PROMPT =
  'You are Cloud-Claw, an autonomous trading agent connected to an Alpaca paper trading account. ' +
  'You can check account details, inspect open positions, look up stock quotes, and submit market orders. ' +
  'You also have access to an Obsidian personal knowledge vault — use readNote and searchVault to look up notes, research, and context from the vault when relevant. ' +
  'Be concise and factual. Always confirm trade details before executing.';

// ── Obsidian vault helpers ────────────────────────────────────────────────────

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';
const VAULT_EXCLUDED = new Set(['.git', 'private', 'node_modules']);

function safeVaultPath(relativePath: string): string | null {
  if (!VAULT_PATH) return null;
  const full = path.resolve(VAULT_PATH, relativePath);
  return full.startsWith(path.resolve(VAULT_PATH)) ? full : null;
}

function readVaultNote(relativePath: string): unknown {
  if (!VAULT_PATH) return { error: 'OBSIDIAN_VAULT_PATH not configured' };
  const full = safeVaultPath(relativePath);
  if (!full) return { error: 'Invalid path' };
  try {
    return { path: relativePath, content: fs.readFileSync(full, 'utf-8') };
  } catch (err: any) {
    return { error: err.message };
  }
}

function searchVaultNotes(query: string): unknown {
  if (!VAULT_PATH) return { error: 'OBSIDIAN_VAULT_PATH not configured' };
  const q = query.toLowerCase();
  const results: { path: string; excerpt: string }[] = [];

  function walk(dir: string, base: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || VAULT_EXCLUDED.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.join(base, e.name).replace(/\\/g, '/');
      if (e.isDirectory()) { walk(full, rel); }
      else if (e.name.endsWith('.md')) {
        try {
          const text = fs.readFileSync(full, 'utf-8');
          if (text.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)) {
            const idx = text.toLowerCase().indexOf(q);
            const excerpt = idx >= 0 ? text.slice(Math.max(0, idx - 50), idx + 150) : text.slice(0, 200);
            results.push({ path: rel, excerpt: '...' + excerpt.trim() + '...' });
            if (results.length >= 10) return;
          }
        } catch { /* skip */ }
      }
    }
  }

  walk(VAULT_PATH, '');
  return { results };
}

// ── Alpaca helpers ────────────────────────────────────────────────────────────

const alpacaHeaders = () => ({
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY || '',
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY || '',
  'Content-Type': 'application/json',
});

async function alpacaFetch(path: string, opts?: RequestInit) {
  const base = 'https://paper-api.alpaca.markets/v2';
  const res = await fetch(`${base}${path}`, { ...opts, headers: alpacaHeaders() });
  if (!res.ok) throw new Error(`Alpaca error (${path}): ${await res.text()}`);
  return res.json();
}

async function handleToolCall(name: string, input: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'getAccount':    return await alpacaFetch('/account');
      case 'getPositions':  return await alpacaFetch('/positions');
      case 'submitOrder':   return await alpacaFetch('/orders', {
        method: 'POST',
        body: JSON.stringify({ symbol: input.symbol, qty: input.qty, side: input.side, type: 'market', time_in_force: 'day' }),
      });
      case 'getMarketData': {
        const res = await fetch(
          `https://data.alpaca.markets/v2/stocks/${input.symbol}/quotes/latest`,
          { headers: { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY || '', 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY || '' } }
        );
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      }
      case 'readNote':    return readVaultNote(input.path as string);
      case 'searchVault': return searchVaultNotes(input.query as string);
      default: return { error: `Unknown tool: ${name}` };
    }
  } catch (err: any) {
    return { error: err.message };
  }
}

const tools: Anthropic.Tool[] = [
  { name: 'getAccount',   description: 'Get Alpaca account details (buying power, portfolio value).', input_schema: { type: 'object', properties: {} } },
  { name: 'getPositions', description: 'Get all open positions in the Alpaca account.',               input_schema: { type: 'object', properties: {} } },
  {
    name: 'getMarketData',
    description: 'Get the latest quote for a stock symbol.',
    input_schema: { type: 'object', properties: { symbol: { type: 'string', description: 'Ticker symbol, e.g. AAPL' } }, required: ['symbol'] },
  },
  {
    name: 'submitOrder',
    description: 'Submit a market order to buy or sell a stock.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        qty:    { type: 'number' },
        side:   { type: 'string', enum: ['buy', 'sell'] },
      },
      required: ['symbol', 'qty', 'side'],
    },
  },
  {
    name: 'readNote',
    description: 'Read a specific note from the Obsidian vault by its relative file path (e.g. "projects/alpaca-trading-bot/index.md").',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path within the vault' } },
      required: ['path'],
    },
  },
  {
    name: 'searchVault',
    description: 'Search the Obsidian vault for notes matching a keyword query. Returns up to 10 matching excerpts.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search term' } },
      required: ['query'],
    },
  },
];

async function runAgentLoop(messages: Anthropic.MessageParam[]): Promise<string> {
  let response = await anthropic.messages.create({ model: MODEL, max_tokens: 1024, system: SYSTEM_PROMPT, messages, tools });

  while (response.stop_reason === 'tool_use') {
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const result = await handleToolCall(block.name, block.input as Record<string, unknown>);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
    }
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: results });
    response = await anthropic.messages.create({ model: MODEL, max_tokens: 1024, system: SYSTEM_PROMPT, messages, tools });
  }

  return response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? "I couldn't generate a response.";
}

// ── Routes ───────────────────────────────────────────────────────────────────

// POST /api/cloud-claw/chat  — send a message, get a reply
router.post('/chat', auth, async (req: any, res: Response) => {
  const { message } = req.body as { message: string };
  if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    let session = await CloudClawSession.findOne({ userId });
    if (!session) session = new CloudClawSession({ userId, messages: [] });

    // Build Anthropic message history from stored session
    const history: Anthropic.MessageParam[] = session.messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    history.push({ role: 'user', content: message });

    const reply = await runAgentLoop(history);

    // Persist new turns, trimming to MAX_HISTORY
    session.messages.push({ role: 'user', content: message });
    session.messages.push({ role: 'assistant', content: reply });
    while (session.messages.length > MAX_HISTORY) session.messages.shift();
    await session.save();

    res.json({ reply });
  } catch (err: any) {
    console.error('[cloud-claw] chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/cloud-claw/chat  — clear conversation history
router.delete('/chat', auth, async (req: any, res: Response) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    await CloudClawSession.findOneAndUpdate({ userId }, { messages: [] }, { upsert: true });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cloud-claw/history  — fetch existing conversation
router.get('/history', auth, async (req: any, res: Response) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const session = await CloudClawSession.findOne({ userId });
    res.json({ messages: session?.messages ?? [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
