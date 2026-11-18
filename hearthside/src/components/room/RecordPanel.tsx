"use client";

import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { recordRows, type LedgerPerson } from '@/lib/room';

export interface GamesEditor {
  /** Saves the whole list. Throw to keep the field and show why. */
  onSave: (games: string[]) => Promise<void>;
  /** Builds the next list: `withGame` / `withoutGame`. */
  add: (games: readonly string[], name: string) => string[];
  remove: (games: readonly string[], name: string) => string[];
}

export interface RecordPanelProps {
  person: LedgerPerson;
  /** Your own record: shows what only you see (email, phone, record type, internal ID). */
  own: boolean;
  /** Your own page: favourite games are added and removed in place. */
  games?: GamesEditor;
  /** Anything after the record and the games: Your Room's line about API keys. */
  children?: ReactNode;
}

/**
 * The Record (layout A): every field the portfolio's profile has, as a
 * definition list on leather, then favourite games as chips. It takes any
 * person; `own` decides what shows. It's the content of a panel: the page
 * puts it in the tab panel (Your Room) or on its own (#231).
 */
export default function RecordPanel({ person, own, games, children }: RecordPanelProps) {
  const rows = recordRows(person, own);
  return (
    <>
      <div className="hs-room-sec">
        <dl className="hs-room-dl" aria-label={own ? 'Your record' : 'Their record'}>
          {rows.map((r) => (
            <div key={r.label}>
              <dt>{r.label}</dt>
              <dd>
                {r.value != null
                  ? <span className={r.mono ? 'hs-room-mono' : undefined}>{r.value}</span>
                  : <span className="hs-room-none">{r.empty}</span>}
                {r.mine && <span className="hs-room-lock">only you</span>}
                {r.note && <small>{r.note}</small>}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="hs-room-sec">
        <h2 className="hs-room-h" id="hs-room-games">Favourite games</h2>
        <Games list={person.favoriteGames ?? []} editor={games} />
      </div>
      {children}
    </>
  );
}

function Games({ list, editor }: { list: string[]; editor?: GamesEditor }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: string[], after?: () => void) => {
    if (!editor) return;
    setBusy(true);
    setError(null);
    try {
      await editor.onSave(next);
      after?.();
    } catch {
      setError('Your games couldn’t be saved. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || !editor) return;
    e.preventDefault();
    const next = editor.add(list, text);
    if (next.length === list.length) { setText(''); return; }
    save(next, () => setText(''));
  };

  return (
    <>
      <ul className="hs-room-chips" aria-labelledby="hs-room-games">
        {list.map((g) => (
          <li key={g} className={editor ? 'hs-room-chip' : 'hs-room-chip is-ro'}>
            {g}
            {editor && (
              <button type="button" aria-label={`Remove ${g}`} disabled={busy} onClick={() => save(editor.remove(list, g))}>×</button>
            )}
          </li>
        ))}
        {!list.length && !editor && <li className="hs-room-none">None listed.</li>}
      </ul>
      {editor && (
        <input
          className="hs-input hs-room-add"
          placeholder="Add a game…"
          aria-label="Add a favourite game"
          maxLength={60}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
      )}
      {error && <p className="hs-alert" role="alert">{error}</p>}
    </>
  );
}
