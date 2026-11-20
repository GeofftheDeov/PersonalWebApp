// The 308s that send /game-night/... and /players/:id to Hearthside (#234).
// Plain JS from the shared package, since this file is require()d before
// anything is compiled; see its header for the rules.
const { hearthsideRedirects } = require('@gtd/shared/hearthside/redirects');

const nextConfig = {
    swcMinify: false,
    eslint: { ignoreDuringBuilds: true },
    // A type error fails the build, and so the deploy. Pull requests run
    // `npm run typecheck` and this build (.github/workflows/frontend-checks.yml).
    typescript: { ignoreBuildErrors: false },
    // The workspace package shared with Hearthside (#209) ships TypeScript
    // source, so Next compiles it like the app's own code.
    transpilePackages: ['@gtd/shared'],
    // output: 'standalone',
    experimental: { proxyTimeout: 300_000 },
    async redirects() {
        return [
            // The Paperclip "CFO" console became the issue desk.
            { source: '/paperclip/cfo', destination: '/paperclip/issues', permanent: true },
            // Game Night moved to Hearthside (spec #69). Only once Hearthside
            // is configured: NEXT_PUBLIC_HEARTHSIDE_URL, built in like the
            // portfolio's links to it ("" = not live yet, so the old
            // /game-night pages keep serving). Read at `next build`.
            ...hearthsideRedirects(process.env.NEXT_PUBLIC_HEARTHSIDE_URL),
        ];
    },
    async rewrites() {
        const backendUrl = process.env.BACKEND_URL || 'http://localhost:5000';
        return {
            beforeFiles: [
                {
                    source: '/api/:path*',
                    destination: `${backendUrl}/api/:path*`,
                },
                {
                    source: '/admin/:path*',
                    destination: `${backendUrl}/admin/:path*`,
                },
                {
                    source: '/admin',
                    destination: `${backendUrl}/admin`,
                },
                {
                    source: '/db/:path*',
                    destination: `${backendUrl}/db/:path*`,
                },
                {
                    source: '/db',
                    destination: `${backendUrl}/db`,
                },
                {
                    source: '/uploads/:path*',
                    destination: `${backendUrl}/uploads/:path*`,
                },
            ]
        }
    },
}

console.log("-----------------------------------------");
console.log("   Next.js Config Loaded - Starting up   ");
console.log("-----------------------------------------");

module.exports = nextConfig
