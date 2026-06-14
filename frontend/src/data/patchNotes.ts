/**
 * Curated patch notes, newest first. Add a new entry at the top of the array
 * when shipping a release — the /patch-notes page renders this file directly.
 */

export type ChangeKind = 'NEW' | 'IMPROVED' | 'FIXED';

export interface PatchChange {
    kind: ChangeKind;
    text: string;
}

export interface PatchNote {
    version: string;
    date: string; // ISO date
    title: string;
    summary?: string;
    changes: PatchChange[];
}

export const PATCH_NOTES: PatchNote[] = [
    {
        version: '1.5.0',
        date: '2026-06-14',
        title: 'The Paperclip Dashboard',
        summary: 'Manage your AI agents without leaving the site.',
        changes: [
            { kind: 'NEW', text: 'Org Chart page — visualise your Paperclip agent hierarchy as an expandable tree with status badges and a per-agent budget-burn bar.' },
            { kind: 'NEW', text: 'CFO dashboard — track monthly spend and budget headroom across every agent at a glance.' },
            { kind: 'NEW', text: 'Budgets page — adjust monthly budget caps for each agent directly from the UI.' },
            { kind: 'NEW', text: 'Paperclip proxy backend — a secure API bridge tunnels these pages through the app\'s existing JWT auth so no Paperclip credential is ever exposed to the browser.' },
            { kind: 'IMPROVED', text: 'Agent detail panel — pause/resume and heartbeat-invoke controls with a toast confirmation, plus a collapsible raw-JSON view for debugging.' },
        ],
    },
    {
        version: '1.4.0',
        date: '2026-06-10',
        title: 'The Social Update',
        summary: 'Chat without leaving the app, a bell that actually tells you things, and smarter session scheduling everywhere.',
        changes: [
            { kind: 'NEW', text: 'Instant messaging in the Social Hub — a Chats tab with live campaign Table Talk for every campaign you belong to, plus direct messages with friends.' },
            { kind: 'NEW', text: 'Notifications bell in the navigation — friend requests, campaign invites, and new messages land there, with accept/decline right in the dropdown.' },
            { kind: 'NEW', text: 'Direct campaign invites — invite friends to a campaign from the invite modal; they get a bell notification and can join in one click. Share links still work.' },
            { kind: 'NEW', text: 'This patch notes page.' },
            { kind: 'IMPROVED', text: 'The Game Night dashboard’s New Session form now matches the campaign page: end time, Discord scheduled event and Google Calendar toggles, and the same validation.' },
            { kind: 'IMPROVED', text: 'Friend cards in the Social Hub gained an in-app MESSAGE button; Discord remains as a secondary option.' },
        ],
    },
    {
        version: '1.3.0',
        date: '2026-06-10',
        title: 'Table Talk & The Event Bus',
        summary: 'Real-time foundations: a durable event bus and live campaign chat built on top of it.',
        changes: [
            { kind: 'NEW', text: 'Table Talk — live chat on every campaign page. Messages stream in real time to everyone viewing the campaign.' },
            { kind: 'NEW', text: 'Event bus backbone (Redis Streams) — durable, replayable events powering chat today and future integrations tomorrow.' },
            { kind: 'IMPROVED', text: 'Backend now shuts down gracefully on deploys, so in-flight events aren’t lost.' },
        ],
    },
    {
        version: '1.2.0',
        date: '2026-06-09',
        title: 'Calendars, Keys & Campaign Power-Ups',
        summary: 'Sessions that schedule themselves and a safe home for your API keys.',
        changes: [
            { kind: 'NEW', text: 'API Key Vault — store provider keys (Discord bot, Google Calendar, and more) encrypted, per user.' },
            { kind: 'NEW', text: 'Google Calendar integration — creating a session can add a calendar event and produce a shareable link for the whole party.' },
            { kind: 'NEW', text: 'Discord scheduled events — link a Discord server to a campaign and new sessions can create server events automatically.' },
            { kind: 'IMPROVED', text: 'Campaign and session editing across the board, plus admin UI enhancements.' },
        ],
    },
    {
        version: '1.1.1',
        date: '2026-05-27',
        title: 'Trading Dashboard Tune-Up',
        changes: [
            { kind: 'NEW', text: 'KPI charts on the Alpaca dashboard with a 5-minute snapshot loop for per-symbol position history.' },
            { kind: 'FIXED', text: 'Chart canvases no longer grow unbounded; x-axis is properly time-scaled.' },
        ],
    },
    {
        version: '1.1.0',
        date: '2026-05-25',
        title: 'Cloud-Claw Streams & A Fresh Coat of Paint',
        summary: 'The assistant talks back in real time, and the whole site got sharper.',
        changes: [
            { kind: 'NEW', text: 'Cloud-Claw streaming chat with a live activity feed, plus vault read/search tools.' },
            { kind: 'NEW', text: 'STL hero on the home page and an About Me section.' },
            { kind: 'IMPROVED', text: 'Markdown rendering for Obsidian vault notes and Claude replies.' },
            { kind: 'IMPROVED', text: 'Mobile responsiveness tightened across every page.' },
        ],
    },
    {
        version: '1.0.0',
        date: '2026-05-19',
        title: 'The Command Center',
        changes: [
            { kind: 'NEW', text: 'Admin command center: Cloud-Claw chat, Obsidian vault browser, and the Alpaca trading dashboard.' },
            { kind: 'IMPROVED', text: 'Obsidian vault synced to the server with persistent storage.' },
            { kind: 'FIXED', text: 'Database resilience after storage corruption — fresh data path and recovery.' },
        ],
    },
];
