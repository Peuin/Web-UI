# Google Drive Media Workflow Web UI

Next.js + React + TypeScript UI for the Supabase/n8n Google Drive Media Workflow Platform.

## Run

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

## Environment

Copy `.env.example` to `.env.local` and set:

```text
NEXT_PUBLIC_SUPABASE_URL=https://svykhovdpaviqgouaafh.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-or-anon-key
```

Do not put server secrets in `NEXT_PUBLIC_` variables.

## Scope

- Supabase Auth login through the `auth` Edge Function
- Drive Browser with folder tree, breadcrumb, search, sync action, grid/list switch
- Media cards with lazy thumbnails, selection, type/status/cache metadata
- File Preview drawer with temporary URL/materialize/workflow actions
- Workflow Jobs table with status badges, progress and job timeline
- Integration Settings screen for Supabase, n8n, secrets and external API contracts

The UI does not ship crawled/mock file records. It loads Drive metadata and workflow jobs from Supabase Edge Functions.

## User guide

The header's **User Guide** button opens `/user-guide.html` in a new tab. The
English/Vietnamese guide is bundled in `public/user-guide.html`, including its
screenshots, so it is available in both development and production.

After rebuilding the guide, update the bundled copy from the `Web-UI` directory:

```sh
cp ../docs/userguide/media-workflow-userguide.html public/user-guide.html
```
