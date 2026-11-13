-- SAHA Video Odası - 2. SQL (güvenle tekrar çalıştırılabilir)
alter table public.watch_progress add column if not exists seen int[] not null default '{}';
alter table public.watch_progress add column if not exists last_sec int not null default 0;
alter table public.profiles add column if not exists email text;
update public.profiles p set email = u.email from auth.users u where u.id = p.id and p.email is null;
