-- PulseGrid Studio — cloud sync.
--
-- Run this once in Supabase: SQL Editor → New query → paste → Run.
-- It is safe to run again; it only creates what's missing and refreshes the rules.
--
-- What it sets up:
--   * a private "projects" file bucket, where each user can only touch files in their own folder;
--   * a cloud_projects table with one row per synced project, readable only by its owner;
--   * commit_project(), the only way to add or change a row. It checks that nobody else
--     changed the project first (so two PCs can never silently overwrite each other)
--     and enforces the size limits below.

-- ───────────────────────────── table ─────────────────────────────

create table if not exists public.cloud_projects (
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id          uuid        not null,
  name        text        not null check (char_length(name) between 1 and 200),
  revision    integer     not null default 1,
  object_path text        not null,
  size_bytes  bigint      not null check (size_bytes between 0 and 52428800),
  device      text        not null default '' check (char_length(device) <= 80),
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.cloud_projects enable row level security;

drop policy if exists "pulsegrid: read own projects"   on public.cloud_projects;
drop policy if exists "pulsegrid: delete own projects" on public.cloud_projects;

create policy "pulsegrid: read own projects"
  on public.cloud_projects for select to authenticated
  using (user_id = auth.uid());

create policy "pulsegrid: delete own projects"
  on public.cloud_projects for delete to authenticated
  using (user_id = auth.uid());

-- Signed-in users may read and delete their own rows. Adding or changing a row
-- goes through commit_project() below, never through direct inserts or updates.
revoke all on public.cloud_projects from anon, authenticated;
grant select, delete on public.cloud_projects to authenticated;

-- ─────────────────────────── commit_project ───────────────────────────

create or replace function public.commit_project(
  p_id     uuid,
  p_name   text,
  p_base   integer,   -- the revision this device last saw; 0 for a project that isn't in the cloud yet
  p_path   text,      -- where the new file was uploaded: <user id>/<project id>/<file>
  p_size   bigint,
  p_device text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid     uuid := auth.uid();
  cur     public.cloud_projects%rowtype;
  has_row boolean;
  used    bigint;
  total   integer;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  -- The file must sit in this user's own folder.
  if p_path is null or p_path not like uid::text || '/%' then
    raise exception 'bad file path' using errcode = '22023';
  end if;

  select * into cur from public.cloud_projects where user_id = uid and id = p_id for update;
  has_row := found;

  select coalesce(sum(size_bytes), 0), count(*)
    into used, total
    from public.cloud_projects
   where user_id = uid and id <> p_id;

  -- 250 MB and 100 projects per account keep the free plan fair for everyone.
  if used + p_size > 262144000 then
    return jsonb_build_object('ok', false, 'reason', 'quota');
  end if;

  if not has_row then
    if p_base <> 0 then
      -- It was deleted elsewhere; the app uploads it again as a new project.
      return jsonb_build_object('ok', false, 'reason', 'missing');
    end if;
    if total >= 100 then
      return jsonb_build_object('ok', false, 'reason', 'too_many');
    end if;

    insert into public.cloud_projects (user_id, id, name, revision, object_path, size_bytes, device)
    values (uid, p_id, left(p_name, 200), 1, p_path, p_size, left(coalesce(p_device, ''), 80));

    return jsonb_build_object('ok', true, 'revision', 1, 'old_path', null);
  end if;

  if cur.revision <> p_base then
    return jsonb_build_object('ok', false, 'reason', 'conflict', 'revision', cur.revision);
  end if;

  update public.cloud_projects
     set name        = left(p_name, 200),
         revision    = cur.revision + 1,
         object_path = p_path,
         size_bytes  = p_size,
         device      = left(coalesce(p_device, ''), 80),
         updated_at  = now()
   where user_id = uid and id = p_id;

  return jsonb_build_object('ok', true, 'revision', cur.revision + 1, 'old_path', cur.object_path);
end;
$$;

revoke all on function public.commit_project(uuid, text, integer, text, bigint, text) from public, anon;
grant execute on function public.commit_project(uuid, text, integer, text, bigint, text) to authenticated;

-- ───────────────────────────── file bucket ─────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit)
values ('projects', 'projects', false, 52428800)   -- private, 50 MB per file
on conflict (id) do update set public = false, file_size_limit = 52428800;

drop policy if exists "pulsegrid: read own project files"   on storage.objects;
drop policy if exists "pulsegrid: add own project files"    on storage.objects;
drop policy if exists "pulsegrid: delete own project files" on storage.objects;

create policy "pulsegrid: read own project files"
  on storage.objects for select to authenticated
  using (bucket_id = 'projects' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "pulsegrid: add own project files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'projects' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "pulsegrid: delete own project files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'projects' and (storage.foldername(name))[1] = auth.uid()::text);
