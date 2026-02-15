const nextConfig = {
    swcMinify: false,
    eslint: { ignoreDuringBuilds: true },
    typescript: { ignoreBuildErrors: true },
    // output: 'standalone',
    async rewrites() {
        const backendUrl = process.env.BACKEND_URL || 'https://backend:5001';
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
            ]
        }
    },
}

console.log("-----------------------------------------");
console.log("   Next.js Config Loaded - Starting up   ");
console.log("-----------------------------------------");

module.exports = nextConfig
