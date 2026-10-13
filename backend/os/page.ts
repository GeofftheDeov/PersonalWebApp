import { renderPage } from "../utils/adminUi.js";
import { centralTime, esc } from "./format.js";
import { describeError, type Overview, type Tile, type TileSource, type ViewContext } from "./overview.js";

/** The page reloads itself this often while it's visible. */
export const OVERVIEW_REFRESH_MS = 2 * 60_000;

export interface OverviewPageOptions {
    token: string;
    now: Date;
    overview: Overview;
    sources: readonly TileSource<any>[];
    /** Overrides OVERVIEW_REFRESH_MS (#142: faster while a run is queued or running). */
    refreshMs?: number;
}

const unavailableBody = (reason: string) => `
    <div class="unavail"><span class="unavail-tag">UNAVAILABLE</span> ${esc(reason)}</div>`;

function renderTile(source: TileSource<any>, tile: Tile | undefined, view: ViewContext): string {
    const state: Tile = tile ?? { status: "unavailable", reason: "not built" };
    let body: string;
    let status = state.status;
    if (state.status === "ok") {
        try { body = source.render(state, view); }
        catch (err) {
            console.error(`[os] tile ${source.id} render failed:`, (err as any)?.message ?? err);
            status = "unavailable";
            body = unavailableBody(`could not render: ${describeError(err)}`);
        }
    } else {
        body = unavailableBody(state.reason);
    }
    // A tile whose data carries `stale: boolean` gets the flag; the label and
    // icon carry it, never colour alone.
    const stale = status === "ok" && (state as any).stale === true;
    return `
        <section class="tile tile-${status}" data-tile="${esc(source.id)}" data-status="${status}" data-stale="${stale}">
            <header class="tile-head">
                <a class="tile-title" href="${esc(view.link(source.href))}">${esc(source.title)} <span aria-hidden="true">→</span></a>
                ${stale ? `<span class="badge badge-warn" title="This data is older than it should be">⚠ STALE</span>` : ""}
            </header>
            <div class="tile-body">${body}</div>
        </section>`;
}

/** /admin/os: the tiles through the shared admin shell. Server-rendered; no chart library, no CDN scripts. */
export function renderOverviewPage({ token, now, overview, sources, refreshMs = OVERVIEW_REFRESH_MS }: OverviewPageOptions): string {
    const view: ViewContext = {
        now,
        link: (path) => `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`,
    };
    const tiles = sources.map((s) => renderTile(s, overview.tiles[s.id], view)).join("");

    const content = `
        <div class="os-layout">
            <div class="os-inner">
                <div class="os-head">
                    <div class="os-title">AGENTIC OS</div>
                    <div class="muted">updated ${esc(centralTime(new Date(overview.generatedAt), now))}</div>
                </div>
                <div class="os-tiles">${tiles}</div>
            </div>
        </div>
        <script>
        // Reload while the page is visible; catch up as soon as a hidden tab comes back.
        (function () {
            var every = ${Number(refreshMs)}, loaded = Date.now();
            function tick() { if (document.visibilityState === 'visible' && Date.now() - loaded >= every) location.reload(); }
            setInterval(tick, Math.min(every, 5000));
            document.addEventListener('visibilitychange', tick);
        })();
        </script>`;

    const extraStyles = `
        /* The shared admin shell centres a 100vh flex body, which pushes anything
           taller than the viewport off the top: pin the page below the nav and
           scroll inside it. */
        .os-layout { width: 100%; height: calc(100vh - 60px); overflow-y: auto; box-sizing: border-box;
            padding: 1.5rem; position: relative; z-index: 95; }
        .os-inner { max-width: 1100px; margin: 0 auto; }
        .os-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 1rem; gap: 1rem; }
        .os-title { color: #0d9488; font-weight: bold; letter-spacing: 3px; }
        .os-tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
        @media (max-width: 800px) {
            .os-layout { padding: 1rem; }
            .os-tiles { grid-template-columns: 1fr; }
            /* This page lays out at device width, so keep the shared nav usable:
               its links scroll sideways inside the one 60px row (spec #135 W5's
               rule, applied here until W5 brings it to every page). */
            .top-nav { padding: 0 1rem; gap: 1rem; }
            .nav-brand { flex-shrink: 0; font-size: 1.1rem; }
            .nav-brand .suffix { display: none; }
            .nav-links { overflow-x: auto; gap: 1.25rem; min-width: 0; scrollbar-width: none; }
            .nav-link { white-space: nowrap; font-size: 0.8rem; }
        }
        .tile { border: 1px solid #333; background: #1e1e1e; padding: 1rem 1.25rem; min-width: 0; box-sizing: border-box; }
        .tile-head { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; }
        .tile-title { color: #0d9488; font-size: 0.75rem; letter-spacing: 2px; font-weight: bold; text-transform: uppercase; text-decoration: none; }
        .tile-title:hover { color: #fff; }
        .badge { font-size: 0.65rem; padding: 0.1rem 0.45rem; letter-spacing: 1px; font-weight: bold; white-space: nowrap; }
        .badge-warn { background: #fab219; color: #000; }
        .stat-label { color: #aaa; font-size: 0.8rem; }
        .stat-value { color: #fff; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; font-weight: 600;
            font-size: 2.25rem; line-height: 1.2; overflow-wrap: anywhere; }
        .stat-delta { color: #e0e0e0; font-size: 0.95rem; margin-top: 0.25rem; }
        .dir { font-size: 0.75rem; margin-right: 0.15rem; }
        .dir-up { color: #0d9488; } .dir-down { color: #f97316; } .dir-flat { color: #666; }
        .stat-meta { color: #888; font-size: 0.75rem; margin-top: 0.6rem; }
        .warn { color: #fab219; }
        .muted { color: #777; font-size: 0.75rem; }
        .unavail { color: #bbb; font-size: 0.85rem; line-height: 1.5; overflow-wrap: anywhere; }
        .unavail-tag { display: inline-block; background: #444; color: #ddd; font-size: 0.65rem; letter-spacing: 1px;
            padding: 0.05rem 0.4rem; margin-right: 0.3rem; font-weight: bold; }
    `;

    return renderPage({ token, title: "Agentic OS", activePage: "os", content, extraStyles, deviceWidth: true });
}
