# Autolink Support Control Center

Internal Next.js admin app for testing and managing Autolink's AI Telegram support operation.

## Stack

- Next.js 14 App Router
- TypeScript
- Tailwind CSS
- Supabase
- Server-only mutations for Mark actions and Telegram sends
- Vercel-ready environment variables

## File Structure

```txt
app/
  api/
    playbook/
    tickets/[id]/action/
  knowledge-base/
  intents/
  settings/
  tickets/
components/
lib/
  supabase/
  intent-library.ts
  playbook.ts
  telegram.ts
  tickets.ts
supabase/migrations/
```

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

## Environment Variables

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
TELEGRAM_BOT_TOKEN=
GEMINI_API_KEY=
MARK_INTERNAL_CHAT_ID=
```

Never expose `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, or `GEMINI_API_KEY` to client components.

## Supabase

The app expects the existing tables listed in the project brief.

Optional migration:

```bash
supabase db push
```

Or run `supabase/migrations/0001_control_center_indexes.sql` in the Supabase SQL editor.

## Seed Playbook

Go to `/knowledge-base` and click `Seed Playbook`.

The seed endpoint inserts missing intent entries only. It does not overwrite existing entries.

## Mark Action Flow

1. Open `/tickets/[id]`.
2. Click a Mark action or write a custom reply.
3. The app inserts a `mark_actions` row.
4. The app updates the ticket status and completion message.
5. If `TELEGRAM_BOT_TOKEN` and `client_chat_id` exist, the server sends the Telegram message.
6. On successful Telegram send, the app inserts a `bot_responses` row.

`Close` sets `status = closed` and does not send Telegram.

## Deploy to Vercel

```bash
npm run build
vercel
```

Set all environment variables in Vercel Project Settings before production use.
