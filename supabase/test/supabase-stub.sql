-- Minimal stand-ins for what Supabase provides (roles, auth and storage), enough to run
-- supabase/schema.sql and supabase/test/checks.sql on plain PostgreSQL. Not used in production.
create role anon nologin; create role authenticated nologin;
create schema auth; create schema storage;
grant usage on schema auth, storage, public to anon, authenticated;
create table auth.users (id uuid primary key, encrypted_password text);
create table auth.sessions (id uuid primary key, user_id uuid references auth.users on delete cascade, created_at timestamptz default now(), updated_at timestamptz, refreshed_at timestamp, user_agent text, ip inet, aal text, not_after timestamptz);
create table auth.mfa_factors (id uuid primary key, user_id uuid references auth.users on delete cascade, status text);
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
grant execute on function auth.jwt(), auth.uid() to anon, authenticated;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, unique (bucket_id, name));
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to authenticated;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant execute on function storage.foldername(text) to authenticated;
