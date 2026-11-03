const nextConfig = {
    swcMinify: false,
    eslint: { ignoreDuringBuilds: true },
    // A type error fails the build (and so the deploy). `npm run typecheck`
    // runs the same check on every pull request.
    typescript: { ignoreBuildErrors: false },
    // output: 'standalone',
    experimental: { proxyTimeout: 300_000 },
    async redirects() {
        return [
            // The Paperclip "CFO" console became the issue desk.
            { source: '/paperclip/cfo', destination: '/paperclip/issues', permanent: true },
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
