const nextConfig = {
    swcMinify: false,
    eslint: { ignoreDuringBuilds: true },
    typescript: { ignoreBuildErrors: true }
}

console.log("-----------------------------------------");
console.log("   Next.js Config Loaded - Starting up   ");
console.log("-----------------------------------------");

module.exports = nextConfig
