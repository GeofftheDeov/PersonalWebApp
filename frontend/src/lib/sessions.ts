/**
 * How a session's "when" reads in a list (#57). A session being planned has
 * no date yet -- `new Date(null)` would render as Jan 1 1970 -- and a
 * cancelled one should say so.
 */
export interface SessionLike {
    date?: string | null;
    status?: string | null;
}

export function sessionWhen(s: SessionLike, format?: Intl.DateTimeFormatOptions): string {
    if (s.status === 'planning') return 'Planning';
    const date = s.date ? new Date(s.date).toLocaleDateString(undefined, format) : 'Date TBD';
    return s.status === 'cancelled' ? `Cancelled · ${date}` : date;
}
