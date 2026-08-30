"use client";

import { useState } from "react";
import Header from "./Header";
import Sidebar from "./Sidebar";

/**
 * The authenticated chrome: persistent sidebar, header, and the content well.
 * Rendered once by app/(app)/layout.tsx so every page inherits it.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <>
      <Sidebar mobileOpen={mobileNavOpen} onCloseMobile={() => setMobileNavOpen(false)} />
      <div className="md:pl-72 w-full h-screen overflow-hidden flex flex-col">
        <Header onOpenMenu={() => setMobileNavOpen(true)} />
        <main className="flex-1 min-h-0 w-full flex flex-col overflow-y-auto pt-4 md:pt-0">{children}</main>
      </div>
    </>
  );
}
