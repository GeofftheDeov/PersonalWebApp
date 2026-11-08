/**
 * Hearthside (spec #69). Same Next version as the portfolio, and the same
 * rewrites to the shared backend, so the browser's calls stay same-origin on
 * Hearthside's host and carry its session cookie.
 *
 * BACKEND_URL is read when `next build` runs: the build writes the rewrites'
 * destinations into .next, and the server doesn't read it again. In the ECS
 * task the backend is on the task-local network, so the default is right
 * there; local Docker builds pass http://backend:5000 (docker-compose.yml).
 * Under `npm run dev` it's read when the dev server starts.
 *
 * NEXT_PUBLIC_PORTFOLIO_URL (src/lib/config.ts) is checked here, so a bad
 * value fails the build rather than every page once deployed.
 *
 * @type {import('next').NextConfig}
 */
const portfolioUrl = process.env.NEXT_PUBLIC_PORTFOLIO_URL;
if (portfolioUrl) {
    let ok = false;
    try { ok = ['http:', 'https:'].includes(new URL(portfolioUrl).protocol); } catch { /* not a URL */ }
    if (!ok) throw new Error(`NEXT_PUBLIC_PORTFOLIO_URL must be the portfolio's http(s) origin, e.g. https://geoffthedeov.net (got ${JSON.stringify(portfolioUrl)})`);
}

const nextConfig = {
    swcMinify: false,
    // Lint isn't a build gate in either app yet (see the portfolio's config).
    eslint: { ignoreDuringBuilds: true },
    // A type error fails the build, and so the deploy (#208).
    typescript: { ignoreBuildErrors: false },
    // The workspace package shared with the portfolio (#209) ships TypeScript
    // source, so Next compiles it like the app's own code.
    transpilePackages: ['@gtd/shared'],
    // Long backend calls (uploads, the live channel's upgrade) go through the rewrites.
    experimental: { proxyTimeout: 300_000 },
    async rewrites() {
        const backendUrl = process.env.BACKEND_URL || 'http://localhost:5000';
        return {
            // beforeFiles, as on the portfolio: these paths are the backend's
            // whatever pages Hearthside has. /api includes the live channel's
            // WebSocket (/api/live), which https-server.js proxies.
            beforeFiles: [
                { source: '/api/:path*', destination: `${backendUrl}/api/:path*` },
                { source: '/uploads/:path*', destination: `${backendUrl}/uploads/:path*` },
            ],
        };
    },
};

module.exports = nextConfig;
