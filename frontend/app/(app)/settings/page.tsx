import PlaceholderPage from "@/components/layout/PlaceholderPage";
import { RoleGate } from "@/components/rbac/RoleGate";

export const metadata = { title: "Settings · VedaAI" };

/**
 * Administrators only. `middleware.ts` blocks the request; RoleGate covers
 * client-side navigation to the same route.
 */
export default function SettingsPage() {
  return (
    <RoleGate permission="manage_org">
      <PlaceholderPage
        icon="settings"
        title="Organization Settings"
        description="Manage members, roles and processing defaults for your organization."
      />
    </RoleGate>
  );
}
