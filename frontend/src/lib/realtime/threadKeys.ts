/**
 * Thread keys as the live channel names them; the same strings as
 * backend/services/threads.ts.
 */
export const campaignThreadKey = (campaignId: string): string => `campaign:${campaignId}`;

/** A friend DM's key: the two account ids, sorted, so both sides name it the same. */
export const dmThreadKey = (a: string, b: string): string => `dm:${[String(a), String(b)].sort().join(':')}`;
