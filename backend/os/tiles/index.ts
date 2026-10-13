import type { TileSource } from "../overview.js";
import { alpacaTile } from "./alpaca.js";

/**
 * The overview's tiles, in page order. Later tickets add theirs here:
 * usage (#144), tasks (#141), brief & runner (#142).
 */
export const TILES: readonly TileSource<any>[] = [alpacaTile];
