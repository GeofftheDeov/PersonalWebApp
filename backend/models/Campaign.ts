import { defineModel } from "../db/model.js";

const Campaign = defineModel({
  table: "campaigns",
  fields: {
    title: "title", description: "description", status: "status",
    startDate: "start_date", endDate: "end_date",
    discordGuildId: "discord_guild_id", discordChannelId: "discord_channel_id",
    sfID: "sf_id", createdAt: "created_at",
  },
});
export default Campaign;
