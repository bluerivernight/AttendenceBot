-- AttendanceBot v1 — Supabase schema

create extension if not exists pgcrypto;

-- enums
do $$ begin
  create type public.user_tier as enum ('super_admin', 'manager', 'employee');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.session_status as enum ('working', 'on_break', 'completed');
exception when duplicate_object then null; end $$;

-- profiles: one row per auth user; carries tier + discord linkage
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  discord_user_id text,
  discord_username text,
  full_name text,
  tier public.user_tier not null default 'employee',
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_discord_user_id_idx on public.profiles (discord_user_id);

-- guild config: single-row server settings
create table if not exists public.guild_configs (
  guild_id text primary key,
  attendance_logs_channel_id text not null default '',
  manager_role_ids text[] not null default '{}',
  tracked_voice_channel_ids text[] not null default '{}',
  auto_checkout_inactivity_minutes int not null default 480,
  default_timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- work_sessions: one row per duty check-in; immutable once completed
create table if not exists public.work_sessions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles (id) on delete cascade,
  guild_id text not null,
  check_in_at timestamptz not null,
  check_out_at timestamptz,
  status public.session_status not null default 'working',
  gross_duration_ms bigint,
  break_duration_ms bigint not null default 0,
  net_duration_ms bigint,
  manager_edited boolean not null default false,
  last_calculated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists work_sessions_employee_idx on public.work_sessions (employee_id, check_in_at desc);
create index if not exists work_sessions_guild_idx on public.work_sessions (guild_id, status);

-- break_logs: sub-rows of an active work session
create table if not exists public.break_logs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.work_sessions (id) on delete cascade,
  employee_id uuid not null references public.profiles (id) on delete cascade,
  start_iso timestamptz not null,
  end_iso timestamptz,
  duration_ms bigint,
  created_at timestamptz not null default now()
);

create index if not exists break_logs_session_idx on public.break_logs (session_id);

-- voice_sessions: signed on VC leave
create table if not exists public.voice_sessions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid unique not null,
  employee_id uuid not null references public.profiles (id) on delete cascade,
  guild_id text not null,
  member_name text not null,
  channel_id text not null,
  channel_name text not null,
  start_iso timestamptz not null,
  end_iso timestamptz not null,
  duration_sec bigint not null,
  ed25519_signature text not null,
  created_at timestamptz not null default now()
);

create index if not exists voice_sessions_employee_idx on public.voice_sessions (employee_id, end_iso desc);

-- session_audit_logs: immutable manager override trail
create table if not exists public.session_audit_logs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.work_sessions (id) on delete cascade,
  modified_by_auth_id uuid not null references auth.users (id) on delete cascade,
  modified_by_discord_id text not null,
  previous_json jsonb not null,
  new_json jsonb not null,
  reason text not null default '',
  signature text not null,
  created_at timestamptz not null default now()
);

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.guild_configs enable row level security;
alter table public.work_sessions enable row level security;
alter table public.break_logs enable row level security;
alter table public.voice_sessions enable row level security;
alter table public.session_audit_logs enable row level security;

-- profiles: read own row; managers/super_admin read all; self update only
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_select_staff" on public.profiles
  for select using (
    exists (
      select 1 from public.guild_configs g
      where g.tracked_voice_channel_ids is not null
    ) and false
  );

-- simplified tier-based policies (finalized in follow-up migration)
drop policy if exists "profiles_select_staff" on public.profiles;
create policy "profiles_select_staff" on public.profiles
  for select using (
    public.current_tier() in ('manager', 'super_admin')
    or auth.uid() = id
  );

create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

-- guild_configs: staff only
create policy "guild_configs_select_staff" on public.guild_configs
  for select using (public.current_tier() in ('manager', 'super_admin'));
create policy "guild_configs_insert_staff" on public.guild_configs
  for insert with check (public.current_tier() in ('manager', 'super_admin'));
create policy "guild_configs_update_staff" on public.guild_configs
  for update using (public.current_tier() in ('manager', 'super_admin'));

-- work_sessions: employee own sessions select/insert; staff read/update
create policy "work_sessions_select_own" on public.work_sessions
  for select using (employee_id = auth.uid());
create policy "work_sessions_select_staff" on public.work_sessions
  for select using (public.current_tier() in ('manager', 'super_admin'));
create policy "work_sessions_insert_own" on public.work_sessions
  for insert with check (employee_id = auth.uid());
create policy "work_sessions_update_staff" on public.work_sessions
  for update using (public.current_tier() in ('manager', 'super_admin'));

-- break_logs: employee own session rows; staff read
create policy "break_logs_select_own" on public.break_logs
  for select using (employee_id = auth.uid());
create policy "break_logs_select_staff" on public.break_logs
  for select using (public.current_tier() in ('manager', 'super_admin'));
create policy "break_logs_insert_own" on public.break_logs
  for insert with check (employee_id = auth.uid());
create policy "break_logs_update_staff" on public.break_logs
  for update using (public.current_tier() in ('manager', 'super_admin'));

-- voice_sessions: staff read
create policy "voice_sessions_select_staff" on public.voice_sessions
  for select using (public.current_tier() in ('manager', 'super_admin'));

-- session_audit_logs: staff read + insert
create policy "session_audit_logs_select_staff" on public.session_audit_logs
  for select using (public.current_tier() in ('manager', 'super_admin'));
create policy "session_audit_logs_insert_staff" on public.session_audit_logs
  for insert with check (public.current_tier() in ('manager', 'super_admin'));

-- helper: resolve current caller's tier
create or replace function public.current_tier()
  returns public.user_tier
  language sql
  stable
as $$
  select p.tier
  from public.profiles p
  where p.id = auth.uid();
$$;

-- RPC: atomic checkout — closes open break then finalizes session
create or replace function public.rpc_checkout_session(p_session_id uuid)
returns public.work_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.work_sessions;
begin
  select * into v_session from public.work_sessions where id = p_session_id;

  update public.break_logs
     set end_iso = coalesce(now(), v_session.check_in_at + interval '0 seconds'),
         duration_ms = extract(epoch from (now() - v_session.check_in_at)) * 1000
   where session_id = p_session_id
     and end_iso is null;

  update public.work_sessions
     set status = 'completed',
         check_out_at = coalesce(now(), v_session.check_in_at),
         gross_duration_ms = coalesce(
           extract(epoch from (v_session.check_out_at - v_session.check_in_at)) * 1000,
           0
         ),
         break_duration_ms = coalesce(
           (select coalesce(sum(duration_ms), 0) from public.break_logs
             where session_id = v_session.id),
           0
         ),
         net_duration_ms = greatest(
           coalesce(v_session.gross_duration_ms, 0)
           - coalesce((select coalesce(sum(duration_ms), 0) from public.break_logs
             where session_id = v_session.id), 0),
           0
         ),
         updated_at = now()
   where id = p_session_id
   returning * into v_session;

  return v_session;
end;
$$;

grant execute on function public.rpc_checkout_session(uuid) to authenticated, service_role;
grant select, insert, update on public.work_sessions to authenticated, service_role;
grant select, insert, update on public.break_logs to authenticated, service_role;
grant select, insert on public.voice_sessions to authenticated, service_role;
grant select, insert on public.session_audit_logs to authenticated, service_role;
grant select, insert, update on public.guild_configs to authenticated, service_role;
grant select, insert, update on public.profiles to authenticated, service_role;
