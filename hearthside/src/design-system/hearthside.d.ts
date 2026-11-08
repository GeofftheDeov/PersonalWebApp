/**
 * Types for the design system's script (hearthside.js), the parts that need
 * behaviour. Everything else in the design system is markup (its `hs-`
 * classes) plus components.css.
 */

/** Whether the person asked for reduced motion. */
export function reduceMotion(): boolean;

export interface FloorOptions {
  /** Fill the canvas's own box instead of the window. */
  inline?: boolean;
  /** How far one page pans the floor, in CSS px. Default 200. */
  step?: number;
  /** Where the CSS floor (`hs-ground`) goes when WebGL is missing. Default `document.body`. */
  fallback?: HTMLElement;
  /** Overrides for the boards (width, length, colours…). */
  wood?: Record<string, number | number[]>;
}

export interface Floor {
  /** False when WebGL was missing and the CSS floor stands in; the rest are then no-ops. */
  ok: boolean;
  /** Slide the boards to `x` CSS px, on a spring (instantly under reduced motion, or with `animate: false`). */
  panTo(x: number, animate?: boolean): void;
  /** Slide to page `i` (`i × step`). */
  page(i: number, animate?: boolean): void;
  redraw(): void;
  /** Stops drawing, lets go of the window, and gives the WebGL context back. */
  destroy(): void;
}

/** Draws the floor into a canvas (`.hs-floor`). */
export function mountFloor(canvas: HTMLCanvasElement, opts?: FloorOptions): Floor;

/** Gilds every `.hs-gilded` under `root` (default the document). Safe to call again. */
export function gild(root?: ParentNode): void;

/** Gilds one panel, the element itself; returns what takes its gilding off. */
export function gildOne(el: HTMLElement): () => void;

export interface NoticeSheetOptions {
  /** What the sheet's wear is seeded from (the session's id). Default the card's `data-seed`. */
  seed?: string;
}

export interface NoticeSheet {
  ok: boolean;
  setSeed(seed: string): void;
  redraw(): void;
  /** Stops drawing and takes the paper back out of the card. */
  destroy(): void;
}

/** Draws a weathered parchment sheet behind a `.hs-sheet` card's content. */
export function mountSheet(card: HTMLElement, opts?: NoticeSheetOptions): NoticeSheet;

/** Ticking a `.hs-quests` list's boxes; returns what unbinds it. */
export function bindQuests(
  list: HTMLElement,
  opts?: { count?: HTMLElement; onChange?: (li: HTMLLIElement | null, done: boolean) => void },
): () => void;

/** Renders the availability grid's table into `el` (and its legend). */
export function renderAvailability(
  el: HTMLElement,
  o: {
    counts: number[][];
    slots: string[];
    days?: [string, string?][];
    total?: number;
    suffix?: string;
    pick?: [number, number];
    legend?: HTMLElement;
  },
): void;
