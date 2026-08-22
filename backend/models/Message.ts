import { defineModel } from "../db/model.js";
import Campaign from "./Campaign.js";
import Event from "./Event.js";

const Message = defineModel({
  table: "messages",
  fields: {
    campaign: { col: "campaign_id", type: "uuid" },
    event: { col: "event_id", type: "uuid" },
    dmKey: "dm_key", recipient: "recipient",
    "sender.id": "sender_id", "sender.name": "sender_name", "sender.email": "sender_email",
    body: "body", createdAt: { col: "created_at", type: "date" },
  },
  refs: { campaign: () => Campaign, event: () => Event },
  preSave: (doc) => {
    if (!doc.campaign && !doc.dmKey) throw new Error("Message requires either a campaign or a dmKey");
  },
});
export default Message;
