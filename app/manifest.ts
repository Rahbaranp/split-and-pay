import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "SplitPay — Restaurant Bill Splitter",
    short_name: "SplitPay",
    description: "Scan restaurant receipts, split itemized bills, and settle up fairly.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#101716",
    theme_color: "#101716",
    orientation: "any",
    categories: ["finance", "utilities", "food"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
