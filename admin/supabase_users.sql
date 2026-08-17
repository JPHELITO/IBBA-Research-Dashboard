-- =============================================================================
-- A4 Fase C — GESTÃO DE USUÁRIOS (listar, papel, último acesso, nº de acessos, promover)
-- Rodar no SQL Editor do Supabase. Idempotente. Requer is_admin() + profiles.
--
-- 2026-08-17 — ACESSO = LOGIN. Decisão do usuário: "acesso" é a quantidade de vezes
-- que alguém DIGITOU A SENHA e entrou com aquele login.
--
-- 🔴 2026-08-17 (2) — A TRILHA DE AUDITORIA DO SUPABASE ESTÁ VAZIA. A 1ª tentativa
-- contava `auth.audit_log_entries` (ação 'login'), que é onde o GoTrue grava cada
-- sign-in. Verificado na tela: ZERO para todo mundo, inclusive gente com
-- `last_sign_in_at` recente → aquela tabela foi expurgada (é do Supabase, não nossa,
-- e ele limpa quando quer). **Passamos a registrar por conta própria**: `login_events`
-- + `log_login()`, chamado pelo `login.html` logo após o `signInWithPassword` dar certo.
-- A auditoria continua sendo lida como HISTÓRICO — só as linhas ANTERIORES ao nosso
-- 1º registro próprio, p/ não contar o mesmo login duas vezes se ela voltar a encher.
--
-- ⚠️ NÃO usa `page_visits`: aquilo conta ABERTURA DE PÁGINA (a Home), então um F5
-- somava "acesso" sem ninguém digitar senha. O `page_visits` segue existindo e
-- alimentando os acessos gerais da aba Visão geral (get_visit_stats).
-- =============================================================================

-- page_visits segue com user_id (usado pela Visão geral); mantido por idempotência
alter table public.page_visits add column if not exists user_id uuid;
create or replace function public.log_visit(p_path text)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin insert into public.page_visits(path, user_id) values (left(coalesce(p_path,'/'),200), auth.uid()); end; $$;
revoke all on function public.log_visit(text) from public;
grant execute on function public.log_visit(text) to anon, authenticated;

-- ───────────── LOGINS (o "acesso" da aba Usuários) ─────────────
create table if not exists public.login_events (
  id         bigserial primary key,
  user_id    uuid not null,
  created_at timestamptz not null default now()
);
alter table public.login_events enable row level security;   -- sem policy: ninguém lê direto
create index if not exists login_events_user_created_idx
  on public.login_events(user_id, created_at desc);

-- grava UM login do usuário autenticado. Sem parâmetro: quem é vem do token (auth.uid()),
-- então ninguém consegue lançar login no nome de outro.
-- Debounce de 10s: protege contra clique/retry duplo do front e contra alguém chamando a
-- RPC em looping p/ inflar o próprio número. Re-login legítimo em 10s não existe na prática.
create or replace function public.log_login()
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  declare v_uid uuid := auth.uid();
  begin
    if v_uid is null then return; end if;
    if exists (select 1 from public.login_events
               where user_id = v_uid and created_at > now() - interval '10 seconds') then
      return;
    end if;
    insert into public.login_events(user_id) values (v_uid);
  end; $$;
revoke all on function public.log_login() from public, anon;
grant execute on function public.log_login() to authenticated;

-- lista de usuários (só admin): email, papel, último login, criado, LOGINS por janela
-- ⚠️ o conjunto de colunas MUDOU em relação à versão original → precisa do drop;
--    `create or replace` recusa trocar o tipo de retorno (42P13).
drop function if exists public.get_users_list();
create or replace function public.get_users_list()
  returns table(id uuid, email text, role text,
                last_sign_in_at timestamptz, created_at timestamptz,
                visits bigint, v24h bigint, v7d bigint, v30d bigint)
  language sql stable security definer set search_path = public, pg_temp as $$
  -- ⚠️ os apelidos `uid`/`ts` são DE PROPÓSITO: numa função `language sql` os nomes do
  --    RETURNS TABLE (id, created_at…) ficam visíveis no corpo e uma coluna homônima vira
  --    "column reference is ambiguous" em tempo de execução.
  with cut as (   -- desde quando nós mesmos registramos; antes disso vale a auditoria
    select min(created_at) as t0 from public.login_events
  ), l as (
    select e.user_id as uid, e.created_at as ts
    from public.login_events e
    where public.is_admin()
    union all
    select (a.payload->>'actor_id')::uuid, a.created_at
    from auth.audit_log_entries a, cut
    where public.is_admin()
      and a.payload->>'action' = 'login'          -- login de verdade; 'token_refreshed' fora
      and (cut.t0 is null or a.created_at < cut.t0)   -- sem dupla contagem
  ), agg as (
    select l.uid,
           count(*)                                                    as n_total,
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

-- assinaturas novas/alteradas → avisa o PostgREST na hora (senão PGRST202 por cache)
notify pgrst, 'reload schema';

-- =============================================================================
-- CONFERÊNCIA (opcional), depois de fazer 1 logout + login:
--   select u.email, count(e.*) as logins, max(e.created_at) as ultimo
--   from auth.users u left join public.login_events e on e.user_id = u.id
--   group by 1 order by 2 desc;
-- =============================================================================

-- Obs.: a função lê auth.users e auth.audit_log_entries via SECURITY DEFINER (dono =
-- postgres, que tem acesso ao schema auth).
-- Obs. 2: NÃO criamos índice em auth.audit_log_entries de propósito — mexer no schema
-- `auth` briga com as migrações do próprio Supabase.
-- Obs. 3: o "total" começa do zero agora (a história anterior não existe em lugar nenhum
-- deste projeto). Daqui p/ frente é registro nosso e não depende do Supabase.
