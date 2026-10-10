import { defineModel } from "../db/model.js";
import Account from "./Account.js";

const Campaign = defineModel({
  table: "campaigns",
  fields: {
    title: "title", description: "description", status: "status",
    startDate: { col: "start_date", type: "date" }, endDate: { col: "end_date", type: "date" },
    discordGuildId: "discord_guild_id", discordChannelId: "discord_channel_id",
    sfID: "sf_id", createdAt: { col: "created_at", type: "date" },
    // Session planning (#57). The owner is who created the campaign -- not the
    // Game Master, and unchanged when the torch passes. NULL = admin-managed.
    owner: { col: "owner_id", type: "uuid" },
    gmTitle: "gm_title", quorum: "quorum", tableLink: "table_link", bannerKey: "banner_key",
  },
  refs: { owner: () => Account },
});
export default Campaign;
