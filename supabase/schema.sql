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

-- Stars and the archive: a starred note or notebook is pinned to the top of the sidebar; an archived
-- one is hidden from the sidebar and search until restored (Settings > Data controls).
alter table public.notes     add column if not exists starred boolean not null default false;
alter table public.notes     add column if not exists archived_at timestamptz;
alter table public.notebooks add column if not exists starred boolean not null default false;
alter table public.notebooks add column if not exists archived_at timestamptz;

-- The trash. It is a notebook of its own (one per user, made by the app): deleting a note moves it
-- there (notes.deleted_at says since when), and taking it out moves it into a notebook the user picks.
-- A deleted notebook moves to the trash whole (notebooks.deleted_at set), its notes with it, and can
-- only be restored whole. The app deletes for good what has been in the trash for 30 days.
alter table public.notes     add column if not exists deleted_at timestamptz;
alter table public.notebooks add column if not exists deleted_at timestamptz;

-- A note cannot be put into a notebook that is in the trash (say, deleted on another device a moment
-- ago): the move fails instead, and the app says so.
create or replace function public.note_notebook_live() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.notebook_id is not null
     and (tg_op = 'INSERT' or new.notebook_id is distinct from old.notebook_id)
     and exists (select 1 from public.notebooks b where b.id = new.notebook_id and b.deleted_at is not null) then
    raise exception 'Lineboard: that notebook is in the trash' using errcode = '23503';
  end if;
  return new;
end $$;
drop trigger if exists notes_notebook_live on public.notes;
create trigger notes_notebook_live
  before insert or update of notebook_id on public.notes
  for each row execute function public.note_notebook_live();

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
-- Dashed and dotted shapes (null: solid). Inside the ciphertext when encrypted.
alter table public.strokes add column if not exists dash text check (dash in ('dashed', 'dotted'));
-- Text box style: font family, bold / italic / underline, alignment (null: plain). Inside the ciphertext when encrypted.
alter table public.strokes add column if not exists font jsonb check (jsonb_typeof(font) = 'object' and octet_length(font::text) <= 200);
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

-- Version history: past states of a note, each a full snapshot of its strokes (deflated JSON,
-- base64). With encryption on, the snapshot and the version's name are encrypted on the device
-- (data_enc, name_enc) and the plaintext columns stay empty. `size` is the stored length, kept so
-- the per-account limit below can be checked without reading every snapshot.
create table if not exists public.note_versions (
  id             uuid primary key,                    -- generated on the device
  note_id        uuid not null references public.notes (id) on delete cascade,
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at     timestamptz not null default now(),
  kind           text not null default 'auto' check (kind in ('auto', 'restore')),
  name           text check (char_length(name) <= 120),
  name_enc       text check (char_length(name_enc) <= 4000),
  restored_from  timestamptz,
  data           text check (char_length(data) <= 16000000),
  data_enc       text check (char_length(data_enc) <= 16000000),
  size           integer not null default 0,
  constraint note_versions_payload check ((data is null) <> (data_enc is null)),
  constraint note_versions_size check (size = coalesce(char_length(data), 0) + coalesce(char_length(data_enc), 0))
);
create index if not exists note_versions_note_idx on public.note_versions (note_id, created_at desc);
create index if not exists note_versions_user_idx on public.note_versions (user_id);

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
alter table public.note_versions enable row level security;

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

drop policy if exists "own versions" on public.note_versions;
create policy "own versions" on public.note_versions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and ((data_enc is not null and name is null) or not (select public.encryption_required()))
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
  foreach t in array array['notebooks', 'notes', 'strokes', 'user_settings', 'user_keys', 'note_versions'] loop
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

-- True when the caller's token shows a sign-in or confirmation (password, emailed code, passkey or
-- authenticator code) from the last 10 minutes: each entry of the "amr" claim says when that method
-- was last used for the session, and refreshing a token does not renew it.
create or replace function public.recently_authenticated() returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from jsonb_array_elements(coalesce((select auth.jwt()) -> 'amr', '[]'::jsonb)) a
     where jsonb_typeof(a) = 'object'
       and (a ->> 'timestamp') ~ '^[0-9]+$'
       and (a ->> 'timestamp')::bigint > extract(epoch from now()) - 600
  )
$$;

-- Delete the signed-in user's account (right to erasure). Removing the auth user removes every
-- row that references it (notebooks, notes, strokes, versions, settings, keys, sessions, factors, passkeys).
-- The app deletes the user's picture files through the Storage API first. It needs a fresh proof
-- of identity: a session left signed in (or a stolen token) alone cannot delete the account.
create or replace function public.delete_my_account() returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.access_ok() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if not public.recently_authenticated() then
    raise exception 'Lineboard: a recent sign-in is needed to delete the account' using errcode = '42501';
  end if;
  delete from auth.users where id = (select auth.uid());
end $$;

revoke execute on function public.access_ok(), public.list_my_sessions(), public.revoke_my_session(uuid), public.delete_my_account(), public.recently_authenticated() from anon, public;
grant execute on function public.recently_authenticated() to authenticated;
grant execute on function public.access_ok(), public.list_my_sessions(), public.revoke_my_session(uuid), public.delete_my_account() to authenticated;

-- ------------- Pictures -------------
-- An 'image' stroke points at a file in this private bucket, at <user id>/<image id>. Files of
-- encrypted accounts are encrypted on the device before upload.
insert into storage.buckets (id, name, public, file_size_limit)
values ('images', 'images', false, 15728640)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- Pictures: only image files (or encrypted ones), at most 15 MB each, and per account at most
-- 5000 files and 2 GB in all.
update storage.buckets
   set allowed_mime_types = array['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'application/octet-stream']
 where id = 'images';

create or replace function public.image_quota_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select count(*) < 5000 and coalesce(sum((o.metadata ->> 'size')::bigint), 0) < 2147483648
    from storage.objects o
   where o.bucket_id = 'images' and (storage.foldername(o.name))[1] = (select auth.uid())::text
$$;
revoke execute on function public.image_quota_ok() from anon, public;
grant execute on function public.image_quota_ok() to authenticated;

-- Replacing a file: the account's other files must be within the quota, so replacing small files
-- with large ones cannot grow the account past it (one file is at most 15 MB on top).
create or replace function public.image_quota_ok_replacing(target text) returns boolean
language sql stable security definer set search_path = '' as $$
  select count(*) < 5000 and coalesce(sum((o.metadata ->> 'size')::bigint), 0) < 2147483648
    from storage.objects o
   where o.bucket_id = 'images' and (storage.foldername(o.name))[1] = (select auth.uid())::text and o.name <> target
$$;
revoke execute on function public.image_quota_ok_replacing(text) from anon, public;
grant execute on function public.image_quota_ok_replacing(text) to authenticated;

drop policy if exists "own images: read" on storage.objects;
drop policy if exists "own images: add" on storage.objects;
drop policy if exists "own images: change" on storage.objects;
drop policy if exists "own images: remove" on storage.objects;
create policy "own images: read" on storage.objects for select to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.access_ok()));
create policy "own images: add" on storage.objects for insert to authenticated
  with check (bucket_id = 'images' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.access_ok())
              and (select public.image_quota_ok()));
create policy "own images: change" on storage.objects for update to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.access_ok()))
  with check (bucket_id = 'images' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.access_ok())
              and public.image_quota_ok_replacing(name));
create policy "own images: remove" on storage.objects for delete to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.access_ok()));

-- ------------- Fair-use limits (abuse protection) -------------
-- Generous ceilings that normal use never comes near; they stop a single account from flooding the
-- database or file storage. A refused write raises "Lineboard limit: ..." (SQLSTATE 23514), which
-- the app shows to the user instead of retrying.

-- Size of one row's content. NOT VALID: existing rows are left alone, new and changed rows are checked.
alter table public.strokes drop constraint if exists strokes_points_size;
alter table public.strokes add constraint strokes_points_size check (points is null or octet_length(points::text) <= 400000) not valid;
-- 3 to 60,000 numbers (1 to 20,000 x, y, pressure points); the app splits longer strokes as they are drawn.
alter table public.strokes drop constraint if exists strokes_points_count;
alter table public.strokes add constraint strokes_points_count check (points is null or jsonb_array_length(points) between 3 and 60000) not valid;
alter table public.strokes drop constraint if exists strokes_enc_size;
alter table public.strokes add constraint strokes_enc_size check (enc is null or char_length(enc) <= 600000) not valid;
alter table public.user_settings drop constraint if exists user_settings_size;
alter table public.user_settings add constraint user_settings_size check (octet_length(settings::text) <= 20000) not valid;
alter table public.user_keys drop constraint if exists user_keys_kdf_size;
alter table public.user_keys add constraint user_keys_kdf_size check (octet_length(kdf::text) <= 1000) not valid;

-- How many rows an account (or a note) may have. Checked once per statement, for the users and
-- notes it touched, so a batch of strokes costs one count, not one per row.
create or replace function public.enforce_row_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare bad text;
begin
  if tg_table_name = 'notebooks' then
    -- The trash (the user's id with its version digit set to 8, made by the app) does not count.
    select format('%s notebooks', 500) into bad from (select distinct user_id from added) a
     where (select count(*) from public.notebooks b
             where b.user_id = a.user_id and b.id <> overlay(a.user_id::text placing '8' from 15 for 1)::uuid) > 500 limit 1;
  elsif tg_table_name = 'notes' then
    select format('%s notes', 20000) into bad from (select distinct user_id from added) a
     where (select count(*) from public.notes n where n.user_id = a.user_id) > 20000 limit 1;
  elsif tg_table_name = 'strokes' then
    select format('%s strokes in one note; start a new note', 50000) into bad from (select distinct note_id from added) a
     where (select count(*) from public.strokes s where s.note_id = a.note_id) > 50000 limit 1;
    if bad is null then
      select format('%s strokes in all', 2000000) into bad from (select distinct user_id from added) a
       where (select count(*) from public.strokes s where s.user_id = a.user_id) > 2000000 limit 1;
    end if;
  elsif tg_table_name = 'note_versions' then
    select format('%s versions of one note', 500) into bad from (select distinct note_id from added) a
     where (select count(*) from public.note_versions v where v.note_id = a.note_id) > 500 limit 1;
    if bad is null then
      select '1 GB of version history; delete some named versions or old notes' into bad from (select distinct user_id from added) a
       where (select coalesce(sum(v.size), 0) from public.note_versions v where v.user_id = a.user_id) > 1073741824 limit 1;
    end if;
  end if;
  if bad is not null then
    raise exception 'Lineboard limit: an account can have at most %', bad using errcode = '23514';
  end if;
  return null;
end $$;
revoke execute on function public.enforce_row_limits() from anon, authenticated, public;

drop trigger if exists notebooks_row_limits on public.notebooks;
create trigger notebooks_row_limits after insert on public.notebooks
  referencing new table as added for each statement execute function public.enforce_row_limits();
drop trigger if exists notes_row_limits on public.notes;
create trigger notes_row_limits after insert on public.notes
  referencing new table as added for each statement execute function public.enforce_row_limits();
drop trigger if exists strokes_row_limits on public.strokes;
create trigger strokes_row_limits after insert on public.strokes
  referencing new table as added for each statement execute function public.enforce_row_limits();
drop trigger if exists note_versions_row_limits on public.note_versions;
create trigger note_versions_row_limits after insert on public.note_versions
  referencing new table as added for each statement execute function public.enforce_row_limits();
drop trigger if exists note_versions_size_limits on public.note_versions;
-- Changing rows is checked too: rewriting a version larger, or moving ink or versions to another
-- note, must not get round the limits that adding them is held to.
drop trigger if exists strokes_row_limits_on_update on public.strokes;
create trigger strokes_row_limits_on_update after update on public.strokes
  referencing new table as added for each statement execute function public.enforce_row_limits();
drop trigger if exists note_versions_row_limits_on_update on public.note_versions;
create trigger note_versions_row_limits_on_update after update on public.note_versions
  referencing new table as added for each statement execute function public.enforce_row_limits();

-- Signed-in users get table access (RLS above still limits them to their own rows); anonymous users get none.
grant select, insert, update, delete on public.notebooks, public.notes, public.strokes, public.user_settings, public.user_keys, public.note_versions to authenticated;
revoke all on public.notebooks, public.notes, public.strokes, public.user_settings, public.user_keys, public.note_versions from anon;
grant execute on function public.encryption_required() to authenticated;
revoke execute on function public.encryption_required() from anon, public;
