import { defineModel } from "../db/model.js";
import Account from "./Account.js";

const Opportunity = defineModel({
  table: "opportunities",
  fields: {
    name: "name", amount: "amount", stage: "stage", closeDate: "close_date",
    accountId: { col: "account_id", type: "uuid" },
    createdAt: "created_at",
  },
  refs: { accountId: () => Account },
});
export default Opportunity;
