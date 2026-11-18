-- Lineboard database schema.
-- Run once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Safe to re-run.

-- ------------- Tables -------------

create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title       text not null default 'Untitled' check (char_length(title) <= 200),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists notes_user_updated_idx on public.notes (user_id, updated_at desc);

-- Notebooks group notes (two levels: notebook -> notes).
create table if not exists public.notebooks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null default 'My Notebook' check (char_length(name) <= 120),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists notebooks_user_idx on public.notebooks (user_id, created_at);

-- Added after the first release: existing notes keep notebook_id = null and the app
-- moves them into the user's default notebook on next load. Deleting a notebook deletes its notes.
alter table public.notes add column if not exists notebook_id uuid references public.notebooks (id) on delete cascade;
create index if not exists notes_notebook_idx on public.notes (notebook_id);

create table if not exists public.strokes (
  id          uuid primary key,                       -- generated on the device so offline saves are idempotent
  note_id     uuid not null references public.notes (id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  tool        text not null check (tool in ('pen', 'highlighter')),
  color       text not null check (char_length(color) <= 32),
  width       real not null check (width > 0 and width <= 100),
  points      jsonb not null check (jsonb_typeof(points) = 'array'),  -- [x, y, pressure, x, y, pressure, ...]
  created_at  timestamptz not null default now()
);
create index if not exists strokes_note_created_idx on public.strokes (note_id, created_at, id);
create index if not exists strokes_user_idx on public.strokes (user_id);

-- ------------- End-to-end encryption (optional, per user) -------------
-- When a user turns encryption on, the app encrypts titles, names and ink on the device. Encrypted
-- rows keep the ciphertext in *_enc columns and leave the plaintext columns empty (or null).
alter table public.notebooks add column if not exists name_enc text check (char_length(name_enc) <= 4000);
alter table public.notes     add column if not exists title_enc text check (char_length(title_enc) <= 4000);
alter table public.strokes   add column if not exists enc text;
alter table public.strokes alter column tool   drop not null;
alter table public.strokes alter column color  drop not null;
alter table public.strokes alter column width  drop not null;
alter table public.strokes alter column points drop not null;
alter table public.strokes drop constraint if exists strokes_payload_present;
alter table public.strokes add constraint strokes_payload_present check (
  enc is not null or (tool is not null and color is not null and width is not null and points is not null)
);

-- Wrapped copies of the user's data key. The key itself never reaches the server: one copy is
-- encrypted with a key derived from the user's passphrase, the other with their recovery key.
create table if not exists public.user_keys (
  user_id           uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  state             text not null check (state in ('off', 'encrypting', 'on', 'decrypting')),
  key_id            uuid not null,
  kdf               jsonb not null,
  pass_wrapped      text not null check (char_length(pass_wrapped) <= 1000),
  recovery_wrapped  text not null check (char_length(recovery_wrapped) <= 1000),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- True once the signed-in user's notes must be stored encrypted.
create or replace function public.encryption_required() returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.user_keys k where k.user_id = (select auth.uid()) and k.state = 'on')
$$;

create table if not exists public.user_settings (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  settings    jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ------------- Keep notes.updated_at fresh when ink changes -------------

create or replace function public.touch_note() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  update public.notes set updated_at = now()
   where id = coalesce(new.note_id, old.note_id);
  return null;
end $$;

drop trigger if exists strokes_touch_note on public.strokes;
create trigger strokes_touch_note
  after insert or update or delete on public.strokes
  for each row execute function public.touch_note();

-- ------------- Row level security: every user sees only their own rows -------------

alter table public.notebooks     enable row level security;
alter table public.notes         enable row level security;
alter table public.strokes       enable row level security;
alter table public.user_settings enable row level security;
alter table public.user_keys     enable row level security;

drop policy if exists "own notebooks" on public.notebooks;
create policy "own notebooks" on public.notebooks
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and (name_enc is not null or not (select public.encryption_required())));

drop policy if exists "own notes" on public.notes;
create policy "own notes" on public.notes
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (title_enc is not null or not (select public.encryption_required()))
    and (notebook_id is null
         or exists (select 1 from public.notebooks b where b.id = notebook_id and b.user_id = (select auth.uid())))
  );

drop policy if exists "own strokes" on public.strokes;
create policy "own strokes" on public.strokes
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (enc is not null or not (select public.encryption_required()))
    and exists (select 1 from public.notes n where n.id = note_id and n.user_id = (select auth.uid()))
  );

drop policy if exists "own settings" on public.user_settings;
create policy "own settings" on public.user_settings
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "own keys" on public.user_keys;
create policy "own keys" on public.user_keys
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Signed-in users get table access (RLS above still limits them to their own rows); anonymous users get none.
grant select, insert, update, delete on public.notebooks, public.notes, public.strokes, public.user_settings, public.user_keys to authenticated;
revoke all on public.notebooks, public.notes, public.strokes, public.user_settings, public.user_keys from anon;
grant execute on function public.encryption_required() to authenticated;
revoke execute on function public.encryption_required() from anon, public;
