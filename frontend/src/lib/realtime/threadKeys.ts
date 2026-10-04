/**
 * Thread keys as the live channel names them; the same strings as
 * backend/services/threads.ts.
 */
export const campaignThreadKey = (campaignId: string): string => `campaign:${campaignId}`;
