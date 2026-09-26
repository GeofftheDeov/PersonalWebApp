import { defineModel } from "../db/model.js";
import Account from "./Account.js";

// These refs named User while from_user/to_user could hold ANY of the four
// person tables, so populate() silently returned null for three people out of
// four. Phase 3 (#35) unified the tables and the ref becomes correct.
const FriendRequest = defineModel({
  table: "friend_requests",
  fields: {
    from: { col: "from_user", type: "uuid" },
    to: { col: "to_user", type: "uuid" },
    status: "status", createdAt: { col: "created_at", type: "date" },
  },
  refs: { from: () => Account, to: () => Account },
});
export default FriendRequest;
