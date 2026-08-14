import { defineModel } from "../db/model.js";

export interface IAlpacaPosition {
  symbol: string;
  qty: number;
  market_value: number;
  unrealized_pl: number;
  current_price: number;
}

const AlpacaSnapshot = defineModel({
  table: "alpaca_snapshots",
  fields: {
    ts: "ts", equity: "equity", last_equity: "last_equity", cash: "cash",
    buying_power: "buying_power", day_pl: "day_pl",
    positions: { col: "positions", type: "jsonb" },
  },
});
export default AlpacaSnapshot;
