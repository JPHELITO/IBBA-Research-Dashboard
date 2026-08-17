-- =============================================================================
-- A4 Fase C — GESTÃO DE USUÁRIOS (listar, papel, último acesso, nº de acessos, promover)
-- Rodar no SQL Editor do Supabase. Idempotente. Requer is_admin() + profiles.
--
-- 2026-08-17 — ACESSO = LOGIN. Decisão do usuário: "acesso" é a quantidade de vezes
-- que alguém DIGITOU A SENHA e entrou com aquele login. get_users_list devolve
-- 24h / 7 dias / 30 dias / total por usuário, contados na trilha de auditoria do
-- próprio Supabase Auth (`auth.audit_log_entries`, ação 'login'), que é onde o
-- GoTrue grava cada `signInWithPassword` bem-sucedido.
--
-- ⚠️ NÃO usa mais `page_visits`: aquilo conta ABERTURA DE PÁGINA (a Home), então um
-- F5 somava um "acesso" sem ninguém digitar senha nenhuma. Nada a ver com a
-- definição acima. O `page_visits` continua existindo e alimentando os acessos
-- gerais da aba Visão geral (get_visit_stats) — só saiu DESTA conta.
-- =============================================================================

-- page_visits segue com user_id (usado pela Visão geral); mantido por idempotência
alter table public.page_visits add column if not exists user_id uuid;
create or replace function public.log_visit(p_path text)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin insert into public.page_visits(path, user_id) values (left(coalesce(p_path,'/'),200), auth.uid()); end; $$;
revoke all on function public.log_visit(text) from public;
grant execute on function public.log_visit(text) to anon, authenticated;

-- lista de usuários (só admin): email, papel, último login, criado, LOGINS por janela
-- ⚠️ o conjunto de colunas MUDOU → precisa do drop; `create or replace` recusa trocar o
--    tipo de retorno de uma função que já existe (42P13).
drop function if exists public.get_users_list();
create or replace function public.get_users_list()
  returns table(id uuid, email text, role text,
                last_sign_in_at timestamptz, created_at timestamptz,
                visits bigint, v24h bigint, v7d bigint, v30d bigint)
  language sql stable security definer set search_path = public, pg_temp as $$
  -- ⚠️ os apelidos aqui são `uid`/`ts` DE PROPÓSITO: numa função `language sql`, os nomes
  --    do RETURNS TABLE (id, created_at, …) ficam visíveis no corpo e uma coluna com o
  --    mesmo nome vira "column reference is ambiguous" em tempo de execução.
  with l as (
    select (a.payload->>'actor_id')::uuid as uid, a.created_at as ts
    from auth.audit_log_entries a
    where public.is_admin()
      and a.payload->>'action' = 'login'      -- só login de verdade; 'token_refreshed' fica de fora
  ), agg as (
    select l.uid,
           count(*)                                                   as n_total,
           count(*) filter (where l.ts >= now() - interval '24 hours') as n24h,
           count(*) filter (where l.ts >= now() - interval '7 days')   as n7d,
           count(*) filter (where l.ts >= now() - interval '30 days')  as n30d
    from l where l.uid is not null group by l.uid
  )
  select u.id, u.email::text, coalesce(p.role,'client'),
         u.last_sign_in_at, u.created_at,
         coalesce(g.n_total,0), coalesce(g.n24h,0), coalesce(g.n7d,0), coalesce(g.n30d,0)
  from auth.users u
  left join public.profiles p on p.id = u.id
  left join agg g on g.uid = u.id
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

-- =============================================================================
-- CONFERÊNCIA (opcional) — rode isto DEPOIS, no mesmo SQL Editor, p/ ver a matéria-prima:
--
--   select date_trunc('day', created_at)::date as dia,
--          payload->>'actor_username' as quem, count(*) as logins
--   from auth.audit_log_entries
--   where payload->>'action' = 'login' and created_at >= now() - interval '30 days'
--   group by 1,2 order by 1 desc, 3 desc;
--
-- Se vier VAZIO, a trilha de auditoria do projeto foi limpa (ou o Supabase a expurgou) —
-- a aba Usuários vai avisar na tela em vez de mostrar uma coluna de zeros.
-- =============================================================================

-- Obs.: a função lê auth.users e auth.audit_log_entries via SECURITY DEFINER (dono =
-- postgres, que tem acesso ao schema auth). Se der erro de permissão:
--   grant usage on schema auth to postgres;  grant select on auth.audit_log_entries to postgres;
-- Obs. 2: NÃO criamos índice em auth.audit_log_entries de propósito — mexer no schema
-- `auth` briga com as migrações do próprio Supabase, e com este punhado de usuários a
-- varredura é irrelevante.
-- Obs. 3: o "total" é o que existe na trilha de auditoria. Login anterior a ela (ou
-- expurgado) não aparece — é o teto de história disponível, não uma escolha nossa.
