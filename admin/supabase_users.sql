-- =============================================================================
-- A4 Fase C — GESTÃO DE USUÁRIOS (listar, papel, último acesso, nº de acessos, promover)
-- Rodar no SQL Editor do Supabase. Idempotente. Requer is_admin() + profiles + page_visits.
--
-- 2026-08-17 — ACESSOS POR JANELA: get_users_list passou a devolver 24h / 7 dias /
-- 30 dias / total por usuário (antes era só o total). Um "acesso" = uma abertura da
-- Home (`index.html`), que é onde o login cai — navegar entre abas NÃO conta.
-- =============================================================================

-- contagem de acessos POR usuário: adiciona user_id ao page_visits + log_visit captura auth.uid()
alter table public.page_visits add column if not exists user_id uuid;
create or replace function public.log_visit(p_path text)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin insert into public.page_visits(path, user_id) values (left(coalesce(p_path,'/'),200), auth.uid()); end; $$;
revoke all on function public.log_visit(text) from public;
grant execute on function public.log_visit(text) to anon, authenticated;

-- índice p/ as 4 contagens por janela (sem ele é seq scan na tabela inteira por usuário)
create index if not exists page_visits_user_created_idx
  on public.page_visits(user_id, created_at desc) where user_id is not null;

-- lista de usuários (só admin): email, papel, último acesso, criado, acessos por janela
-- ⚠️ o conjunto de colunas MUDOU → precisa do drop; `create or replace` recusa trocar o
--    tipo de retorno de uma função que já existe (42P13).
drop function if exists public.get_users_list();
create or replace function public.get_users_list()
  returns table(id uuid, email text, role text,
                last_sign_in_at timestamptz, created_at timestamptz,
                visits bigint, v24h bigint, v7d bigint, v30d bigint,
                last_visit timestamptz)
  language sql stable security definer set search_path = public, pg_temp as $$
  with v as (
    select pv.user_id,
           count(*)                                                                as total,
           count(*) filter (where pv.created_at >= now() - interval '24 hours')    as v24h,
           count(*) filter (where pv.created_at >= now() - interval '7 days')      as v7d,
           count(*) filter (where pv.created_at >= now() - interval '30 days')     as v30d,
           max(pv.created_at)                                                      as last_visit
    from public.page_visits pv
    where pv.user_id is not null and public.is_admin()
    group by pv.user_id
  )
  select u.id, u.email::text, coalesce(p.role,'client'),
         u.last_sign_in_at, u.created_at,
         coalesce(v.total,0), coalesce(v.v24h,0), coalesce(v.v7d,0), coalesce(v.v30d,0),
         v.last_visit
  from auth.users u
  left join public.profiles p on p.id = u.id
  left join v on v.user_id = u.id
  where public.is_admin()
  order by u.last_sign_in_at desc nulls last;
$$;
revoke all on function public.get_users_list() from public, anon;
grant execute on function public.get_users_list() to authenticated;

-- promover/rebaixar (só admin)
create or replace function public.admin_set_user_role(p_user_id uuid, p_role text)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    if p_role not in ('client','admin') then raise exception 'papel invalido (use client ou admin)'; end if;
    insert into public.profiles (id, role) values (p_user_id, p_role)
      on conflict (id) do update set role = excluded.role;
  end; $$;
revoke all on function public.admin_set_user_role(uuid, text) from public, anon;
grant execute on function public.admin_set_user_role(uuid, text) to authenticated;

-- a assinatura de get_users_list MUDOU → avisa o PostgREST na hora (senão o front pode
-- levar alguns segundos vendo a assinatura velha em cache e reclamar de PGRST202)
notify pgrst, 'reload schema';

-- Obs.: get_users_list lê auth.users via SECURITY DEFINER (dono = postgres, tem acesso).
-- Se der erro de permissão, rode: grant select on auth.users to postgres;  (normalmente já tem).
-- Obs. 2: visitas anteriores a esta feature têm user_id nulo (a coluna nasceu depois) e por
-- isso não entram em nenhuma das contagens — o "total" é do usuário, não da dashboard.
