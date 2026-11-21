-- Checks for supabase/schema.sql, run in CI against plain PostgreSQL with supabase-stub.sql standing
-- in for Supabase's auth and storage schemas. Each check raises an exception if the rule does not hold.
\set ON_ERROR_STOP 1

insert into auth.users values ('11111111-1111-4111-8111-111111111111', null), ('22222222-2222-4222-8222-222222222222', null);
insert into auth.sessions (id, user_id) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111'),
  ('aaaaaaaa-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222');

-- Act as a user whose token shows a sign-in `auth_age` seconds ago.
create function pg_temp.as_user(uid text, sid text, auth_age int, method text default 'password') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'session_id', sid, 'aal', 'aal1',
    'amr', json_build_array(json_build_object('method', method, 'timestamp', extract(epoch from now())::bigint - auth_age)))::text, false);
  execute 'set role authenticated';
end $$;
-- Run `stmt` as that user and expect it to fail with a message matching `pattern`.
create function pg_temp.refused(uid text, sid text, auth_age int, stmt text, pattern text) returns void language plpgsql as $$
begin
  perform pg_temp.as_user(uid, sid, auth_age);
  begin
    execute stmt;
  exception when others then
    execute 'reset role';
    if sqlerrm !~* pattern then raise exception 'refused for the wrong reason: % (wanted %)', sqlerrm, pattern; end if;
    return;
  end;
  execute 'reset role';
  raise exception 'not refused: %', stmt;
end $$;
create function pg_temp.ok(uid text, sid text, auth_age int, stmt text) returns void language plpgsql as $$
begin
  perform pg_temp.as_user(uid, sid, auth_age);
  execute stmt;
  execute 'reset role';
end $$;

\echo 'account deletion needs a recent sign-in'
select pg_temp.refused('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 3600, 'select public.delete_my_account()', 'recent sign-in');
-- A token that was only renewed just now (no fresh sign-in) is not proof either.
select pg_temp.as_user('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 5, 'token_refresh');
do $$ begin if public.recently_authenticated() then raise exception 'a token refresh counted as a sign-in'; end if; end $$;
reset role;
do $$ begin if (select count(*) from auth.users) <> 2 then raise exception 'an old session deleted the account'; end if; end $$;
select pg_temp.ok('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-0000-4000-8000-000000000002', 60, 'select public.delete_my_account()');
do $$ begin if exists (select 1 from auth.users where id = '22222222-2222-4222-8222-222222222222') then raise exception 'a fresh sign-in could not delete the account'; end if; end $$;

\echo 'a note cannot go into a notebook in the trash; the trash does not count toward the notebook limit'
select pg_temp.ok('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 60, $q$
  insert into public.notebooks (id, name) values ('bbbbbbbb-0000-4000-8000-000000000001', 'A'), ('bbbbbbbb-0000-4000-8000-000000000002', 'B');
  insert into public.notes (id, title, notebook_id) values ('cccccccc-0000-4000-8000-000000000001', 'n', 'bbbbbbbb-0000-4000-8000-000000000001');
  update public.notebooks set deleted_at = now() where id = 'bbbbbbbb-0000-4000-8000-000000000002' $q$);
select pg_temp.refused('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 60,
  $q$update public.notes set notebook_id = 'bbbbbbbb-0000-4000-8000-000000000002' where id = 'cccccccc-0000-4000-8000-000000000001'$q$, 'in the trash');
select pg_temp.refused('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 60,
  $q$insert into public.notes (title, notebook_id) values ('x', 'bbbbbbbb-0000-4000-8000-000000000002')$q$, 'in the trash');
-- Fill the notebook limit (500), then the trash can still be made.
alter table public.notebooks disable trigger user;
insert into public.notebooks (user_id, name) select '11111111-1111-4111-8111-111111111111', 'n' || g from generate_series(1, 498) g;
alter table public.notebooks enable trigger user;
select pg_temp.ok('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 60,
  $q$insert into public.notebooks (id, name) values ('11111111-1111-8111-8111-111111111111', 'Trash')$q$);
select pg_temp.refused('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 60,
  $q$insert into public.notebooks (name) values ('one too many')$q$, 'at most 500 notebooks');

\echo 'limits hold for changes as well as additions'
insert into public.notes (id, user_id, title, notebook_id) values
  ('dddddddd-0000-4000-8000-00000000000a', '11111111-1111-4111-8111-111111111111', 'X', 'bbbbbbbb-0000-4000-8000-000000000001'),
  ('dddddddd-0000-4000-8000-00000000000b', '11111111-1111-4111-8111-111111111111', 'Y', 'bbbbbbbb-0000-4000-8000-000000000001');
alter table public.strokes disable trigger user;
insert into public.strokes (id, note_id, user_id, tool, color, width, points)
  select gen_random_uuid(), 'dddddddd-0000-4000-8000-00000000000a', '11111111-1111-4111-8111-111111111111', 'pen', '#000', 2, '[0,0,0.5]'::jsonb from generate_series(1, 50000);
insert into public.strokes (id, note_id, user_id, tool, color, width, points)
  values ('eeeeeeee-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-00000000000b', '11111111-1111-4111-8111-111111111111', 'pen', '#000', 2, '[0,0,0.5]'::jsonb);
alter table public.strokes enable trigger user;
select pg_temp.refused('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 60,
  $q$update public.strokes set note_id = 'dddddddd-0000-4000-8000-00000000000a' where id = 'eeeeeeee-0000-4000-8000-000000000001'$q$, '50000 strokes in one note');

\echo 'the picture quota holds when a file is replaced'
insert into storage.objects (bucket_id, name, metadata) values
  ('images', '11111111-1111-4111-8111-111111111111/big', '{"size": 2147483648}'),
  ('images', '11111111-1111-4111-8111-111111111111/small', '{"size": 10}');
select pg_temp.refused('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 60,
  $q$update storage.objects set metadata = '{"size": 15000000}' where name = '11111111-1111-4111-8111-111111111111/small'$q$, 'row-level security');
delete from storage.objects where name like '%/big';
select pg_temp.ok('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 60,
  $q$update storage.objects set metadata = '{"size": 15000000}' where name = '11111111-1111-4111-8111-111111111111/small'$q$);

\echo 'all schema checks passed'
