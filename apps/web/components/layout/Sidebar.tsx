"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react"; // Keep X for mobile close for now, or use Material Symbol
import { NAV_ITEMS } from "@/lib/navigation";

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const items = NAV_ITEMS;

  return (
    <>
      <div className="p-6 mb-6 flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt="VedaAI Logo" className="h-8 w-auto object-contain" src="/veda_ai_logo.png" />
        <span className="font-headline-md text-primary tracking-tight">VedaAI</span>
      </div>
      <nav className="flex-1 px-4 space-y-2">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.id}
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={clsx(
                "flex w-full items-center px-4 py-3 rounded-xl transition-all group",
                active
                  ? "bg-primary-container text-on-primary-container font-semibold"
                  : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface font-semibold"
              )}
            >
              <span
                className={clsx(
                  "material-symbols-outlined mr-4 transition-colors",
                  !active && "group-hover:text-primary"
                )}
              >
                {item.icon}
              </span>
              <span className="font-label-md">{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="p-4 mt-auto">
        <div className="bg-surface-container-highest/50 rounded-2xl p-4 border border-outline-variant/20">
          <div className="font-label-sm text-on-surface-variant mb-1">PLAN</div>
          <div className="font-label-md text-on-surface font-bold">Enterprise Pro</div>
        </div>
      </div>
    </>
  );
}

export default function Sidebar({
  mobileOpen,
  onCloseMobile,
}: {
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
}) {
  return (
    <>
      {/* Desktop persistent sidebar */}
      <aside className="hidden fixed left-0 top-0 h-full w-72 bg-surface-container-low md:flex flex-col border-r border-outline-variant/30 z-50 transition-all duration-300">
        <SidebarContent />
      </aside>

      {/* Mobile drawer */}
      <Dialog.Root open={!!mobileOpen} onOpenChange={(open) => !open && onCloseMobile?.()}>
        <Dialog.Portal>
          <Dialog.Backdrop className="dialog-backdrop fixed inset-0 z-50 bg-black/40 backdrop-blur-sm md:hidden" />
          <Dialog.Viewport className="fixed inset-0 z-50 md:hidden">
            <Dialog.Popup
              aria-label="Navigation menu"
              className="dialog-panel-slide-left absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col bg-surface-container-low shadow-2xl"
            >
              <Dialog.Close
                aria-label="Close menu"
                className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-surface-container-high text-on-surface transition-colors hover:bg-surface-variant focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary z-10"
              >
                <X className="h-5 w-5" />
              </Dialog.Close>
              <SidebarContent onNavigate={onCloseMobile} />
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
