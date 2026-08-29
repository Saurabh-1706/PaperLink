import type { Metadata } from "next";
import { Bricolage_Grotesque, Kalam } from "next/font/google";
import { AuthProvider } from "@/features/auth/store/AuthProvider";
import { getServerSession } from "@/lib/auth/serverSession";
import "./globals.css";

const bricolage = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-sans-main" });
const kalam = Kalam({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-handwriting" });

export const metadata: Metadata = {
  title: "AI Assessment Extraction & Answer Mapping",
  description: "Upload a question paper and a handwritten answer sheet to extract, map, and grade answers.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolved server-side so the first paint already knows the role — the nav
  // never flashes items the user cannot use.
  const user = getServerSession();

  return (
    <html lang="en">
      <head>
        <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
        <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet" />
      </head>
      <body className={`${bricolage.variable} ${kalam.variable} font-sans-main bg-background text-on-surface antialiased selection:bg-primary selection:text-white`}>
        <AuthProvider initialUser={user}>{children}</AuthProvider>
      </body>
    </html>
  );
}
