"use client";

import { useEffect, useState, type ChangeEvent, type ReactNode } from 'react';
import { displayName, handleOf, initialOf, uniqueIdOf, type LedgerPerson } from '@/lib/room';

export interface PhotoChange {
  /** A file was picked: the parent checks it (`photoProblem`) and uploads it. */
  onPick: (file: File) => void;
  busy?: boolean;
}

/**
 * A person's photo in a gilded medallion, or their initial on dyed cloth.
 * With `change` (your own page) it's also the way to change it: a label
 * around a file input, named for what it takes.
 */
export function PersonPhoto({ person, change }: { person: LedgerPerson; change?: PhotoChange }) {
  const name = displayName(person);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [person.profilePicture]);
  const has = !!person.profilePicture && !broken;
  const face = (
    <span className="hs-room-medal">
      {has
        ? <img src={person.profilePicture!} alt={change ? 'Your photo' : `${name}’s photo`} onError={() => setBroken(true)} />
        : <span className="hs-room-initial" aria-hidden="true">{initialOf(person)}</span>}
    </span>
  );
  if (!change) return <span className="hs-room-photo">{face}</span>;

  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) change.onPick(file);
  };
  return (
    <label className={change.busy ? 'hs-room-photo is-mine is-busy' : 'hs-room-photo is-mine'} title={has ? 'Change photo' : 'Add a photo'}>
      {face}
      <span className="hs-room-photo-hint" aria-hidden="true">{change.busy ? 'Uploading…' : has ? 'Change photo' : 'Add a photo'}</span>
      <input
        type="file"
        className="hs-sr-only"
        accept="image/png,image/jpeg,image/gif,image/webp"
        aria-label={`${has ? 'Change' : 'Add'} your photo (JPG, PNG, GIF or WEBP, up to 5 MB)`}
        disabled={change.busy}
        onChange={pick}
      />
    </label>
  );
}

export interface LedgerHeadProps {
  person: LedgerPerson;
  /** The counts under the name: `headLine(...)` on Your Room. */
  line?: string | null;
  /** Your own page: the photo changes from here. */
  photo?: PhotoChange;
  /** What went wrong with the photo, under the head. */
  photoError?: string | null;
  /** Edit on Your Room; "Write a letter" and the Friends pill on another player's page (#231). */
  actions?: ReactNode;
}

/**
 * The ledger's head, on the floor (layout A): the photo, the name, the
 * handle and unique ID, the counts, and the page's actions. It takes any
 * person: Your Room passes the session's, another player's page (#231) the
 * `GET /api/users/players/:id` reply.
 */
export default function LedgerHead({ person, line, photo, photoError, actions }: LedgerHeadProps) {
  const handle = handleOf(person);
  const unique = uniqueIdOf(person);
  return (
    <header className="hs-page-head hs-room-head">
      <PersonPhoto person={person} change={photo} />
      <div className="hs-room-who">
        <h1>{displayName(person)}</h1>
        <div className="hs-room-handle">
          {handle || <small>No handle yet</small>}
          {unique && <small> · {unique}</small>}
        </div>
        {line && <p>{line}</p>}
        {photoError && <p className="hs-room-alert" role="alert">{photoError}</p>}
      </div>
      {actions && <div className="hs-room-acts">{actions}</div>}
    </header>
  );
}
