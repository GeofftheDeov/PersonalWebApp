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

    /**
     * Someone's regular availability changed (#57), so any overlap that
     * includes them is stale. Carries no times: listeners re-read the overlap,
     * which applies its own access rules.
     */
    "availability.changed": {
        personId: string;
        what: "windows" | "exceptions" | "busy";
    };

    /**
     * Session planning (#57). Published by planning/planner.ts on every
     * mutation, so the Letters live channel and notifications can react
     * without the planner knowing about them (planning/announcements.ts
     * turns them into bell notifications and Table Talk posts, #88).
     * Payloads carry ids, not content: listeners re-read state through the
     * planner's access rules.
     *
     * stage_changed, by (status, stage): planning/night is the kickoff
     * (unless `nightChange` is "reopened"), planning/venue the night
     * confirmed for an in-person session, planning/food the venue confirmed,
     * then scheduled or cancelled.
     * `actorId` is whoever did it, when a person did, so a "you did this"
     * notification can skip them.
     */
    "planning.stage_changed": {
        sessionId: string;
        campaignId: string;
        status: "planning" | "scheduled" | "cancelled" | "completed";
        stage: "night" | "venue" | "food" | null;
        actorId?: string;
        /**
         * Set when the change is about a night that was already confirmed
         * (#87): "reopened" on planning/night when the Game Master changes a
         * scheduled session's night (not a kickoff), "moved" on the transition
         * that confirms a different night for it (planning.night_moved follows
         * with the old and new times), "kept" on the one where the vote kept
         * the night it already had.
         */
        nightChange?: "reopened" | "moved" | "kept";
        /** With "reopened": the confirmed night that stands until a new one is (ISO date-time). */
        standingStart?: string;
    };
    /**
     * A scheduled session's night moved (#87): published once the new night
     * is confirmed, never while it's only being re-planned. Anything timed
     * off the session's start -- quest due times and reminders (#91) --
     * shifts by `start - previousStart`. ISO date-times.
     */
    "planning.night_moved": {
        sessionId: string;
        campaignId: string;
        previousStart: string;
        previousEnd: string | null;
        start: string;
        end: string;
    };
    "planning.poll_opened": {
        sessionId: string;
        campaignId: string;
        pollId: string;
        kind: "night" | "venue";
        round: number;
        actorId?: string;
        /** "reopened" on the round a reopen starts (#87): its stage_changed already told the party. */
        nightChange?: "reopened";
    };
    "planning.vote_cast": {
        sessionId: string;
        campaignId: string;
        pollId: string;
        personId: string;
    };
    "planning.poll_closed": {
        sessionId: string;
        campaignId: string;
        pollId: string;
        kind: "night" | "venue";
        result: "winner" | "tie" | "no_quorum" | null;
        reason: "all_voted" | "gm_advanced" | "gm_reshortlisted" | "cancelled";
    };

    /**
     * Quests (#90, part of #57): a quest was created with an owner, or its
     * owner changed. Published by planning/quests.ts. `assigneeId` is null
     * when a potluck slot is left unclaimed; `previousAssigneeId` is null for
     * a new quest; `assignedBy` is null when the app did it (e.g. a host-prep
     * quest on venue confirmation).
     */
    "quest.assigned": {
        questId: string;
        sessionId: string;
        campaignId: string;
        kind: "host_prep" | "food" | "custom";
        assigneeId: string | null;
        previousAssigneeId: string | null;
        assignedBy: string | null;
    };
    /** A quest was marked done, by its owner or the Game Master. */
    "quest.completed": {
        questId: string;
        sessionId: string;
        campaignId: string;
        assigneeId: string | null;
        completedBy: string;
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
