import { Database, KeyRound, ShieldCheck, Workflow } from "lucide-react";

export function SettingsPage() {
  return (
    <section className="flex-1 overflow-auto p-5">
      <div className="mb-5">
        <h2 className="text-lg font-semibold">Integration Settings</h2>
        <p className="text-sm text-muted-foreground">Server-side credentials and webhook contracts</p>
      </div>
      <div className="grid max-w-5xl grid-cols-1 gap-4 md:grid-cols-2">
        <SettingPanel
          icon={Database}
          title="Supabase API Gateway"
          rows={[
            ["Auth", "Supabase Auth"],
            ["Realtime", "workflow_jobs updates"],
            ["Storage bucket", "temp-media private"],
          ]}
        />
        <SettingPanel
          icon={Workflow}
          title="n8n Workflows"
          rows={[
            ["Drive sync", "drive-sync workflow"],
            ["Media generation", "vcxyqTKCJW29xmWQ"],
            ["Orchestration", "Supabase Edge Functions"],
          ]}
        />
        <SettingPanel
          icon={KeyRound}
          title="Private Credentials"
          rows={[
            ["n8n callback auth", "Server only"],
            ["Supabase admin key", "Edge Functions only"],
            ["Google OAuth", "n8n only"],
          ]}
        />
        <SettingPanel
          icon={ShieldCheck}
          title="External API"
          rows={[
            ["File metadata", "GET /files/{file_id}"],
            ["Access URL", "POST /files/{file_id}/access-url"],
            ["Signed URL TTL", "600 seconds"],
          ]}
        />
      </div>
    </section>
  );
}

function SettingPanel({
  icon: Icon,
  title,
  rows,
}: {
  icon: typeof Database;
  title: string;
  rows: [string, string][];
}) {
  return (
    <article className="rounded-md border border-border bg-card p-4">
      <div className="mb-4 flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="font-semibold">{title}</h3>
      </div>
      <div className="space-y-3">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-4 text-sm">
            <span className="text-muted-foreground">{label}</span>
            <span className="truncate font-medium">{value}</span>
          </div>
        ))}
      </div>
    </article>
  );
}
