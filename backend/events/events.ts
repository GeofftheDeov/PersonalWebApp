/**
 * Event catalog — the single source of truth for event names and payload shapes.
 *
 * Conventions (see Obsidian vault: concepts/redis-streams-event-bus):
 *  - Names are past-tense and dot-namespaced: `<domain>.<happened>`
 *  - The domain (text before the first dot) maps to a Redis stream: `events:<domain>`
 *    (`<namespace>:events:<domain>` when EVENT_BUS_NAMESPACE is set; see NAMESPACES.md)
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

    /**
     * Someone is typing in a thread (#103). Ephemeral only: published with
     * `publishEphemeral`, never `publish`, so it is never XADDed to a stream
     * or stored. The live channel fans it out to the thread's other members.
     */
    "letters.typing": {
        threadKey: string; // "campaign:<id>" or "dm:<a>:<b>"
        personId: string;
        name: string; // display name, never an email address
        expiresInMs: number;
    };

    /**
     * A person's read position in a thread moved forward (#102). Published
     * with `publishEphemeral`: it only feeds the live channel's `thread.read`
     * frame to that person's other devices; the position itself is stored in
     * thread_reads, and no once-per-service consumer needs it.
     */
    "thread.read": {
        personId: string;
        threadKey: string;
        lastReadAt: string; // ISO timestamp
        lastReadMessageId: string | null;
        /** Messages left unread after this position (newer ones someone else sent). */
        unreadCount: number;
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
