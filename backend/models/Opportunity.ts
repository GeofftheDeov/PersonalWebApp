import { defineModel } from "../db/model.js";
import Account from "./Account.js";

const Opportunity = defineModel({
  table: "opportunities",
  fields: {
    name: "name", amount: "amount", stage: "stage", closeDate: { col: "close_date", type: "date" },
    accountId: { col: "account_id", type: "uuid" },
    createdAt: { col: "created_at", type: "date" },
  },
  refs: { accountId: () => Account },
});
export default Opportunity;
