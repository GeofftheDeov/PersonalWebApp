/**
 * What a campaign calls its Game Master (#57, #80). The role is stored as the
 * membership status "Game Master"; the words shown for it are the campaign's
 * GM title, which the owner picks ("Dungeon Master" until they do).
 */
export const DEFAULT_GM_TITLE = 'Dungeon Master';

export const gmTitleOf = (campaign?: { gmTitle?: string | null } | null): string =>
    campaign?.gmTitle || DEFAULT_GM_TITLE;

/**
 * Is `me` the campaign's Game Master (or an admin)? From the session client
 * (#210), so it can't outlive the session. Display only: the server enforces it.
 */
export function isCampaignGameMaster(
    members: { status?: string; email?: string | null; playerId?: string | null }[],
    me: { id: string; email: string | null } | null,
    caps: { appRole: string | null } | null,
): boolean {
    if (!me) return false;
    if (caps?.appRole === 'admin') return true;
    return members.some(m =>
        m.status === 'Game Master' &&
        ((m.email && me.email && m.email.toLowerCase() === me.email.toLowerCase()) || (m.playerId && m.playerId === me.id))
    );
}

/** A membership status as the party reads it: the GM title in place of "Game Master". */
export const roleLabel = (status: string | undefined, campaign?: { gmTitle?: string | null } | null): string =>
    status === 'Game Master' ? gmTitleOf(campaign) : (status || '');
