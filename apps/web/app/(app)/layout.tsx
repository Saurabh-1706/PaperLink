import AppShell from "@/components/layout/AppShell";

/** Every route in this group is authenticated — see middleware.ts. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
