/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: process.env.NEXT_PUBLIC_API_URL
          ? `${process.env.NEXT_PUBLIC_API_URL}/api/:path*`
          : process.env.API_URL
            ? `${process.env.API_URL}/api/:path*`
            : "https://tacktcix-api.vercel.app/api/:path*",
      },
    ];
  },
};

module.exports = nextConfig;
