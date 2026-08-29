"use client";

import { Menu } from "lucide-react";

export default function Header({
  onOpenMenu,
}: {
  onOpenMenu?: () => void;
}) {
  return (
    <header className="sticky top-0 h-20 w-full bg-white/75 backdrop-blur-md border-b border-outline-variant/30 z-40 flex items-center justify-between px-4 md:px-margin-desktop">
      <div className="flex items-center gap-stack-md">
        {onOpenMenu && (
          <button
            onClick={onOpenMenu}
            aria-label="Open menu"
            className="md:hidden flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-container-highest text-on-surface transition-[background-color,transform] duration-150 ease-out hover:bg-surface-variant focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary active:scale-[0.94]"
          >
            <Menu className="h-5 w-5" />
          </button>
        )}
        <div className="hidden md:flex h-10 w-10 shrink-0 rounded-xl bg-primary-container/10 items-center justify-center text-primary">
          <span className="material-symbols-outlined">search</span>
        </div>
        <span className="text-on-surface-variant font-body-md truncate hidden md:inline">
          Search for classes, documents, or reports...
        </span>
      </div>
      <div className="flex items-center gap-4 md:gap-6">
        <button className="relative p-2 text-on-surface-variant hover:text-primary transition-colors">
          <span className="material-symbols-outlined">notifications</span>
          <span className="absolute top-2 right-2 w-2 h-2 bg-primary rounded-full ring-2 ring-white"></span>
        </button>
        <div className="flex items-center gap-3 pl-4 md:pl-6 border-l border-outline-variant/30">
          <div className="text-right hidden sm:block">
            <div className="font-label-md text-on-surface font-bold">Alex Rivers</div>
            <div className="font-label-sm text-on-surface-variant">Academic Lead</div>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt="Profile"
            className="w-10 h-10 rounded-full object-cover ring-2 ring-primary/20 hover:ring-primary transition-all cursor-pointer"
            src="/headshot.png"
          />
        </div>
      </div>
    </header>
  );
}
