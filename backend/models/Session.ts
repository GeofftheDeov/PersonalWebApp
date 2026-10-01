import { defineModel } from "../db/model.js";
import Campaign from "./Campaign.js";

const Session = defineModel({
  table: "game_sessions",
  fields: {
    title: "title",
    campaign: { col: "campaign_id", type: "uuid" },
    date: { col: "date", type: "date" }, endDate: { col: "end_date", type: "date" }, location: "location", isOnline: "is_online",
    agenda: "agenda", summary: "summary", vodUrl: "vod_url",
    discordEventId: "discord_event_id", googleEventId: "google_event_id",
    googleCalendarLink: "google_calendar_link", sfID: "sf_id",
    readyCheck: { col: "ready_check", type: "jsonb" },
    createdAt: { col: "created_at", type: "date" },
    // Session planning (#57). Written only by the session planner; a session
    // created with a fixed date is 'scheduled' by the column default.
    status: "status", planningStage: "planning_stage", foodMode: "food_mode",
    foodOwner: { col: "food_owner_id", type: "uuid" }, host: { col: "host_id", type: "uuid" },
    venue: { col: "venue_id", type: "uuid" }, gmOverride: { col: "gm_override_id", type: "uuid" },
  },
  refs: { campaign: () => Campaign },
});
export default Session;
