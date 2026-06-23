-- =============================================================================
-- A4 Fase C — GESTÃO DE USUÁRIOS (listar, papel, último acesso, nº de acessos, promover)
-- Rodar no SQL Editor do Supabase. Idempotente. Requer is_admin() + profiles + page_visits.
-- =============================================================================

-- contagem de acessos POR usuário: adiciona user_id ao page_visits + log_visit captura auth.uid()
alter table public.page_visits add column if not exists user_id uuid;
create or replace function public.log_visit(p_path text)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin insert into public.page_visits(path, user_id) values (left(coalesce(p_path,'/'),200), auth.uid()); end; $$;
revoke all on function public.log_visit(text) from public;
grant execute on function public.log_visit(text) to anon, authenticated;

-- lista de usuários (só admin): email, papel, último acesso, criado, nº de acessos
create or replace function public.get_users_list()
  returns table(id uuid, email text, role text, last_sign_in_at timestamptz, created_at timestamptz, visits bigint)
  language sql stable security definer set search_path = public, pg_temp as $$
  select u.id, u.email::text, coalesce(p.role,'client'),
         u.last_sign_in_at, u.created_at,
         (select count(*) from public.page_visits v where v.user_id = u.id)
  from auth.users u
  left join public.profiles p on p.id = u.id
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

-- Obs.: get_users_list lê auth.users via SECURITY DEFINER (dono = postgres, tem acesso).
-- Se der erro de permissão, rode: grant select on auth.users to postgres;  (normalmente já tem).
