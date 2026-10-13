import type { TileSource } from "../overview.js";
import { alpacaTile } from "./alpaca.js";
import { usageTile } from "./usage.js";

/**
 * The overview's tiles, in page order. Later tickets add theirs here:
 * tasks (#141), brief & runner (#142).
 */
export const TILES: readonly TileSource<any>[] = [usageTile, alpacaTile];
