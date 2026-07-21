import { defineModel } from "../db/model.js";
import Campaign from "./Campaign.js";

const Session = defineModel({
  table: "game_sessions",
  fields: {
    title: "title",
    campaign: { col: "campaign_id", type: "uuid" },
    date: "date", endDate: "end_date", location: "location", isOnline: "is_online",
    agenda: "agenda", summary: "summary", vodUrl: "vod_url",
    discordEventId: "discord_event_id", googleEventId: "google_event_id",
    googleCalendarLink: "google_calendar_link", sfID: "sf_id",
    readyCheck: { col: "ready_check", type: "jsonb" },
    createdAt: "created_at",
  },
  refs: { campaign: () => Campaign },
});
export default Session;
