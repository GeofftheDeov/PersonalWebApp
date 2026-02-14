const nextConfig = {
    swcMinify: false,
    eslint: { ignoreDuringBuilds: true },
    typescript: { ignoreBuildErrors: true },
    output: 'standalone',
    async rewrites() {
        return {
            beforeFiles: [
                {
                    source: '/api/:path*',
                    destination: 'http://backend:5000/api/:path*',
                },
                {
                    source: '/admin/:path*',
                    destination: 'http://backend:5000/admin/:path*',
                },
                {
                    source: '/admin',
                    destination: 'http://backend:5000/admin',
                },
                {
                    source: '/db/:path*',
                    destination: 'http://backend:5000/db/:path*',
                },
                {
                    source: '/db',
                    destination: 'http://backend:5000/db',
                },
            ]
        }
    },
}

console.log("-----------------------------------------");
console.log("   Next.js Config Loaded - Starting up   ");
console.log("-----------------------------------------");

module.exports = nextConfig
