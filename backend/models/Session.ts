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
  },
  refs: { campaign: () => Campaign },
});
export default Session;
