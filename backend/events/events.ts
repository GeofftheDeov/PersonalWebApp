/**
 * Event catalog — the single source of truth for event names and payload shapes.
 *
 * Conventions (see Obsidian vault: concepts/redis-streams-event-bus):
 *  - Names are past-tense and dot-namespaced: `<domain>.<happened>`
 *  - The domain (text before the first dot) maps to a Redis stream: `events:<domain>`
 *  - Payloads must be JSON-serializable
 */
export interface EventMap {
    /** A task changed in Mongo (from web, SF sync, or Notion sync). */
    "task.updated": {
        taskId: string;
        source: "web" | "salesforce" | "notion" | "sync";
    };

    /** A calendar/game-night event was created or updated. */
    "event.changed": {
        eventId: string;
        action: "created" | "updated" | "deleted";
    };

    /** Campaign membership or details changed. */
    "campaign.changed": {
        campaignId: string;
        action: "created" | "updated" | "member-added" | "member-removed";
    };

    /** A chat message was posted in a campaign's Game Night channel. */
    "gamenight.message": {
        messageId: string;
        campaignId: string;
        eventId?: string;
        sender: { id: string; name: string; email: string };
        body: string;
        createdAt: string; // ISO timestamp
    };

    /** A direct message was sent between two users. */
    "social.dm": {
        messageId: string;
        dmKey: string; // "<userIdA>:<userIdB>", ids sorted
        recipientId: string;
        sender: { id: string; name: string; email: string };
        body: string;
        createdAt: string; // ISO timestamp
    };

    /** A notification was created (or refreshed) for a user's bell. */
    "user.notification": {
        notificationId: string;
        userId: string;
        type: "friend_request" | "campaign_invite" | "message" | "system";
        title: string;
        body?: string;
        link?: string;
        createdAt: string; // ISO timestamp
    };
}

export type EventName = keyof EventMap;

/** Wire format for every event placed on the bus. */
export interface EventEnvelope<K extends EventName = EventName> {
    /** Unique event id (Redis stream entry id in prod, UUID in memory). */
    id: string;
    name: K;
    ts: string; // ISO timestamp at publish time
    source: string; // emitting service, e.g. "backend"
    payload: EventMap[K];
}
