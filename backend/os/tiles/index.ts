import type { TileSource } from "../overview.js";
import { alpacaTile } from "./alpaca.js";
import { briefTile } from "./brief.js";
import { tasksTile } from "./tasks.js";
import { usageTile } from "./usage.js";

/**
 * The overview's tiles, in page order: usage, Alpaca, tasks, brief & runner.
 * Tasks (#141) goes between Alpaca and the brief.
 */
export const TILES: readonly TileSource<any>[] = [usageTile, alpacaTile, tasksTile, briefTile];
