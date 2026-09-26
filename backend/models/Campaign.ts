import { defineModel } from "../db/model.js";

const Campaign = defineModel({
  table: "campaigns",
  fields: {
    title: "title", description: "description", status: "status",
    startDate: { col: "start_date", type: "date" }, endDate: { col: "end_date", type: "date" },
    discordGuildId: "discord_guild_id", discordChannelId: "discord_channel_id",
    sfID: "sf_id", createdAt: { col: "created_at", type: "date" },
  },
});
export default Campaign;
