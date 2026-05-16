import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "TACKTCIX",
  description: "Cloud-Native AI Company Operating System",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
