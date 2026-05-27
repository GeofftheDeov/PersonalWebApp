import mongoose, { Schema, Document } from 'mongoose';

export interface IAlpacaPosition {
  symbol: string;
  qty: number;
  market_value: number;
  unrealized_pl: number;
  current_price: number;
}

export interface IAlpacaSnapshot extends Document {
  ts: Date;
  equity: number;
  last_equity: number;
  cash: number;
  buying_power: number;
  day_pl: number;
  positions: IAlpacaPosition[];
}

const PositionSchema = new Schema<IAlpacaPosition>({
  symbol:        { type: String, required: true },
  qty:           { type: Number, default: 0 },
  market_value:  { type: Number, default: 0 },
  unrealized_pl: { type: Number, default: 0 },
  current_price: { type: Number, default: 0 },
}, { _id: false });

const AlpacaSnapshotSchema = new Schema<IAlpacaSnapshot>({
  ts:           { type: Date, default: Date.now, index: true },
  equity:       { type: Number, default: 0 },
  last_equity:  { type: Number, default: 0 },
  cash:         { type: Number, default: 0 },
  buying_power: { type: Number, default: 0 },
  day_pl:       { type: Number, default: 0 },
  positions:    { type: [PositionSchema], default: [] },
});

export default mongoose.model<IAlpacaSnapshot>('AlpacaSnapshot', AlpacaSnapshotSchema);
