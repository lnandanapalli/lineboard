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
  tool        text not null check (tool in ('pen', 'highlighter', 'text', 'image')),
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

-- Text boxes: a stroke with tool 'text' keeps its text here (or inside the ciphertext when encrypted);
-- its points are the top-left corner and its width is the font size.
alter table public.strokes add column if not exists text text check (char_length(text) <= 10000);
alter table public.strokes drop constraint if exists strokes_tool_check;
alter table public.strokes drop constraint if exists strokes_tool_valid;
alter table public.strokes add constraint strokes_tool_valid check (tool in ('pen', 'highlighter', 'text', 'image'));

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

-- ------------- Signed-in devices and two-step verification -------------

-- True when the request comes from a session that still exists (a device that was signed out
-- elsewhere loses access at once, not when its access token expires) and that has passed two-step
-- verification if the user turned it on.
create or replace function public.access_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select
    exists (
      select 1 from auth.sessions s
       where s.id = nullif((select auth.jwt()) ->> 'session_id', '')::uuid
         and s.user_id = (select auth.uid())
    )
    and (
      coalesce((select auth.jwt()) ->> 'aal', 'aal1') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
         where f.user_id = (select auth.uid()) and f.status = 'verified'
      )
    )
$$;

do $$
declare t text;
begin
  foreach t in array array['notebooks', 'notes', 'strokes', 'user_settings', 'user_keys'] loop
    execute format('drop policy if exists "active session with required MFA" on public.%I', t);
    execute format(
      'create policy "active session with required MFA" on public.%I as restrictive for all to authenticated '
      'using ((select public.access_ok())) with check ((select public.access_ok()))', t);
  end loop;
end $$;

-- The signed-in user's devices (sessions), newest activity first.
create or replace function public.list_my_sessions()
returns table (id uuid, created_at timestamptz, last_active timestamptz, user_agent text, ip text, aal text, is_current boolean)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not public.access_ok() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return query
    select s.id,
           s.created_at,
           greatest(s.created_at, s.updated_at, s.refreshed_at at time zone 'UTC'),
           s.user_agent,
           host(s.ip),
           s.aal::text,
           s.id = nullif((select auth.jwt()) ->> 'session_id', '')::uuid
      from auth.sessions s
     where s.user_id = (select auth.uid())
       and (s.not_after is null or s.not_after > now())
     order by 3 desc;
end $$;

-- Sign one of the user's devices out. Its refresh tokens go with the session.
create or replace function public.revoke_my_session(target uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.access_ok() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  delete from auth.sessions where id = target and user_id = (select auth.uid());
  return found;
end $$;

revoke execute on function public.access_ok(), public.list_my_sessions(), public.revoke_my_session(uuid) from anon, public;
grant execute on function public.access_ok(), public.list_my_sessions(), public.revoke_my_session(uuid) to authenticated;

-- ------------- Pictures -------------
-- An 'image' stroke points at a file in this private bucket, at <user id>/<image id>. Files of
-- encrypted accounts are encrypted on the device before upload.
insert into storage.buckets (id, name, public, file_size_limit)
values ('images', 'images', false, 15728640)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "own images: read" on storage.objects;
drop policy if exists "own images: add" on storage.objects;
drop policy if exists "own images: change" on storage.objects;
drop policy if exists "own images: remove" on storage.objects;
create policy "own images: read" on storage.objects for select to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.access_ok()));
create policy "own images: add" on storage.objects for insert to authenticated
  with check (bucket_id = 'images' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.access_ok()));
create policy "own images: change" on storage.objects for update to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.access_ok()))
  with check (bucket_id = 'images' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.access_ok()));
create policy "own images: remove" on storage.objects for delete to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.access_ok()));

-- Signed-in users get table access (RLS above still limits them to their own rows); anonymous users get none.
grant select, insert, update, delete on public.notebooks, public.notes, public.strokes, public.user_settings, public.user_keys to authenticated;
revoke all on public.notebooks, public.notes, public.strokes, public.user_settings, public.user_keys from anon;
grant execute on function public.encryption_required() to authenticated;
revoke execute on function public.encryption_required() from anon, public;
