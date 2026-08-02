import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bill Splitter — Share travel & everyday costs",
  description: "A simple, fair way to split itemized bills and travel expenses with friends.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
