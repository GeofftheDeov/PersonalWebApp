import { defineModel } from "../db/model.js";
import User from "./User.js";

const FriendRequest = defineModel({
  table: "friend_requests",
  fields: {
    from: { col: "from_user", type: "uuid" },
    to: { col: "to_user", type: "uuid" },
    status: "status", createdAt: "created_at",
  },
  refs: { from: () => User, to: () => User },
});
export default FriendRequest;
