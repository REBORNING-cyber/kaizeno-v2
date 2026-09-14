import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Локальная разработка: без server-side оптимизации (не нужен sharp)
    unoptimized: true,
    remotePatterns: [
      { protocol: "https", hostname: "aniliberty.top" },
      { protocol: "https", hostname: "static-libria.*" },
      { protocol: "https", hostname: "cache-rfn.libria.fun" },
      { protocol: "https", hostname: "desu.shikimori.one" },
    ],
  },
};

export default nextConfig;