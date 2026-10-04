/**
 * What a campaign calls its Game Master (#57, #80). The role is stored as the
 * membership status "Game Master"; the words shown for it are the campaign's
 * GM title, which the owner picks ("Dungeon Master" until they do).
 */
export const DEFAULT_GM_TITLE = 'Dungeon Master';

export const gmTitleOf = (campaign?: { gmTitle?: string | null } | null): string =>
    campaign?.gmTitle || DEFAULT_GM_TITLE;

/** A membership status as the party reads it: the GM title in place of "Game Master". */
export const roleLabel = (status: string | undefined, campaign?: { gmTitle?: string | null } | null): string =>
    status === 'Game Master' ? gmTitleOf(campaign) : (status || '');
