import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TACKTCIX — Create Your AI Company",
  description: "Strategic onboarding to convert your vision into a structured AI-native company.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
