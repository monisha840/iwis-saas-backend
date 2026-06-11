# Manual-pending migrations

This folder holds SQL migrations that are **ready to apply** but cannot be run
from this codebase because the production Supabase database is owned by the
MD's account. Each file here is a self-contained, idempotent script the MD can
paste into the Supabase SQL editor.

## Workflow

1. A code change wants to add or alter a column.
2. We write the SQL here (`YYYY_MM_short_description.sql`) and keep the change
   **purely additive and nullable** so the Node code can still run before the
   MD applies it.
3. We hand the SQL to the MD when convenient. They run it.
4. After confirmation, we follow up with a normal Prisma migration that:
   - Adds the field to `schema.prisma`.
   - Generates a matching prisma migration in `prisma/migrations/`.
   - Marks this manual SQL as applied (the followup Prisma migration becomes a
     no-op for that column because `ADD COLUMN IF NOT EXISTS` was already run).
5. Delete the file from this folder once landed.

## Why not just run `prisma migrate` directly?

The Supabase DB credentials are owned by the MD. We cannot push migrations from
this dev environment. This folder is the bridge between "code wants a column"
and "DB has the column", without giving us migration push rights.

## Currently pending

| File | Adds | For | Status |
|---|---|---|---|
| `2026_add_voice_message_retrieved_passage_ids.sql` | `VoiceMessage.retrievedPassageIds JSONB` | RAG audit (Phase R4 of voice-coach RAG plan) | Pending MD apply |
