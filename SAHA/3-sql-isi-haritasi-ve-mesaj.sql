-- SAHA Video Odası: ısı haritası + soru-cevap (mesajlar)
alter table public.videos add column if not exists heatmaps jsonb not null default '[]'::jsonb;

create or replace function public.saha_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos(id) on delete cascade,
  author_id uuid not null default auth.uid(),
  author_name text,
  author_role text,
  athlete_id uuid,
  public boolean not null default false,
  body text not null check (char_length(body) between 1 and 2000),
  at_sec int,
  created_at timestamptz not null default now()
);
create index if not exists messages_video_idx on public.messages(video_id, created_at);

create table if not exists public.msg_seen (
  user_id uuid not null default auth.uid(),
  video_id uuid not null references public.videos(id) on delete cascade,
  scope text not null,
  seen_at timestamptz not null,
  primary key (user_id, video_id, scope)
);

alter table public.messages enable row level security;
alter table public.msg_seen enable row level security;

drop policy if exists msg_select on public.messages;
create policy msg_select on public.messages for select to authenticated using (
  public.saha_is_admin()
  or athlete_id = auth.uid()
  or (public and exists (select 1 from public.videos v where v.id = video_id))
);

drop policy if exists msg_insert on public.messages;
create policy msg_insert on public.messages for insert to authenticated with check (
  author_id = auth.uid()
  and (public or athlete_id is not null)
  and (
    public.saha_is_admin()
    or (
      exists (select 1 from public.videos v where v.id = video_id)
      and ((public and athlete_id is null) or (not public and athlete_id = auth.uid()))
    )
  )
);

drop policy if exists msg_delete on public.messages;
create policy msg_delete on public.messages for delete to authenticated using (
  public.saha_is_admin() or author_id = auth.uid()
);

drop policy if exists seen_all on public.msg_seen;
create policy seen_all on public.msg_seen for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
