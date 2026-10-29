-- =============================================================================
-- ÚLTIMOS RELATÓRIOS NA HOME — a função que entrega a lista do Clipping à Home
-- Rodar UMA vez no SQL Editor do Supabase (projeto mmhkqkpjrvyxovpihnio). Idempotente.
--
-- POR QUE ISTO EXISTE, em português
-- Desde 2026-10-20 o painel ao lado dos Eventos (onde ficava o Market Pulse) mostra os
-- relatórios mais recentes da casa. A lista é a "Recent Publications" que o analista já
-- mantém na aba Clipping: nome, setor (SM / PP / NR), link e data, guardados em
-- `clipping_config.settings.recent_publications`.
--
-- Essa tabela é FECHADA (RLS ligado, sem policy): guarda também a mensagem de abertura
-- do clipping, o rascunho do weekly e os destaques do blast — nada disso é para o
-- cliente. Por isso a Home não lê a tabela: chama esta função, que devolve SÓ as
-- quatro coisas que o painel mostra, de no máximo 20 relatórios.
--
-- Regras:
--   · mais de uma conta admin: junta as listas e não repete o mesmo link;
--   · ordem: data mais recente primeiro; relatório SEM data vai para o fim, na ordem
--     em que está na lista (o Clipping põe o novo em cima);
--   · link que não começa com http(s) volta vazio (a Home mostra o nome sem link);
--   · data inválida (ex.: 2026-02-30) vira "sem data" em vez de derrubar a lista.
-- Sem esta função a Home funciona normal e o painel diz "Reports unavailable".
-- =============================================================================

create or replace function public._try_date(p text) returns date
  language plpgsql immutable set search_path = public, pg_temp as $$
  begin
    if p is null or p !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
    return p::date;
  exception when others then return null;
  end; $$;
revoke all on function public._try_date(text) from public, anon, authenticated;

create or replace function public.get_recent_reports(p_limit int default 10)
  returns table(name text, sector text, link text, date date)
  language sql stable security definer set search_path = public, pg_temp as $$
  with itens as (
    select nullif(btrim(e.p->>'name'), '')                          as name,
           upper(coalesce(nullif(btrim(e.p->>'sector'), ''), 'SM')) as sector,
           nullif(btrim(e.p->>'link'), '')                          as link,
           public._try_date(e.p->>'date')                           as date,
           c.updated_at, e.ord
      from public.clipping_config c
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(c.settings->'recent_publications') = 'array'
             then c.settings->'recent_publications' else '[]'::jsonb end) with ordinality as e(p, ord)
  ), unicos as (
    select distinct on (coalesce(i.link, lower(i.name))) i.*
      from itens i
     where i.name is not null
     order by coalesce(i.link, lower(i.name)), i.date desc nulls last, i.updated_at desc, i.ord
  )
  select u.name,
         case when u.sector in ('SM', 'PP', 'NR') then u.sector else 'SM' end,
         case when u.link ~* '^https?://' then u.link end,
         u.date
    from unicos u
   order by u.date desc nulls last, u.updated_at desc, u.ord
   limit greatest(1, least(coalesce(p_limit, 10), 20));
$$;
revoke all on function public.get_recent_reports(int) from public, anon;
grant execute on function public.get_recent_reports(int) to authenticated;

comment on function public.get_recent_reports(int) is
  'Home da dashboard (2026-10-20): os últimos relatórios da lista Recent Publications da aba Clipping — '
  'só nome, setor, link e data. Lê clipping_config (fechada) por SECURITY DEFINER; nada mais da configuração sai.';

-- =============================================================================
-- 2ª VERSÃO (2026-10-21) — get_recent_reports_v2: entram também os relatórios do bloco
-- EARNINGS REVIEW da aba Clipping (o bloco que liga e desliga), SÓ enquanto ele estiver
-- LIGADO — a mesma regra do Weekly Recap. Pedido do usuário: "quero que dentro dos últimos
-- 10 relatórios apareça os relatórios extraordinários (que são da opção de ligar e desligar)".
--
-- Função NOVA de propósito: a Home de produção segue chamando a get_recent_reports (acima)
-- até o usuário aprovar a versão nova; o staging já chama esta. Depois que a produção passar
-- a usar a v2, a de cima pode sair (drop function public.get_recent_reports(int)).
--
-- Mesmas regras da de cima (só nome/setor/link/data, junta admins sem repetir link, data
-- inválida = sem data); na mesma data, a lista principal vem antes do Earnings Review.
-- Rodar este arquivo inteiro de novo é seguro (tudo é create or replace).
-- =============================================================================
create or replace function public.get_recent_reports_v2(p_limit int default 10)
  returns table(name text, sector text, link text, date date)
  language sql stable security definer set search_path = public, pg_temp as $$
  with fontes as (
    select c.updated_at, 0 as bloco, e.p, e.ord
      from public.clipping_config c
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(c.settings->'recent_publications') = 'array'
             then c.settings->'recent_publications' else '[]'::jsonb end) with ordinality as e(p, ord)
    union all
    select c.updated_at, 1 as bloco, e.p, e.ord
      from public.clipping_config c
      cross join lateral jsonb_array_elements(
        case when c.settings->'earnings_review'->'on' = 'true'::jsonb
              and jsonb_typeof(c.settings->'earnings_review'->'items') = 'array'
             then c.settings->'earnings_review'->'items' else '[]'::jsonb end) with ordinality as e(p, ord)
  ), itens as (
    select nullif(btrim(f.p->>'name'), '')                          as name,
           upper(coalesce(nullif(btrim(f.p->>'sector'), ''), 'SM')) as sector,
           nullif(btrim(f.p->>'link'), '')                          as link,
           public._try_date(f.p->>'date')                           as date,
           f.updated_at, f.bloco, f.ord
      from fontes f
  ), unicos as (
    select distinct on (coalesce(i.link, lower(i.name))) i.*
      from itens i
     where i.name is not null
     order by coalesce(i.link, lower(i.name)), i.date desc nulls last, i.updated_at desc, i.bloco, i.ord
  )
  select u.name,
         case when u.sector in ('SM', 'PP', 'NR') then u.sector else 'SM' end,
         case when u.link ~* '^https?://' then u.link end,
         u.date
    from unicos u
   order by u.date desc nulls last, u.updated_at desc, u.bloco, u.ord
   limit greatest(1, least(coalesce(p_limit, 10), 20));
$$;
revoke all on function public.get_recent_reports_v2(int) from public, anon;
grant execute on function public.get_recent_reports_v2(int) to authenticated;

comment on function public.get_recent_reports_v2(int) is
  'Home da dashboard (2026-10-21): os últimos relatórios = Recent Publications + o bloco Earnings Review da aba Clipping '
  '(só enquanto ligado) — só nome, setor, link e data. SECURITY DEFINER; nada mais da configuração sai.';

-- =============================================================================
-- 3ª VERSÃO (2026-10-29) — get_recent_reports_v3: igual à v2 + as EMPRESAS que o analista marcou
-- em cada publicação na aba Clipping (campo `companies`, lista de tickers de tela: VALE3, SCCO, ARA…).
-- A Home mostra essas empresas como etiquetas ao lado do nome do relatório — em vez de adivinhar pelo
-- texto do nome, que foi o que o usuário recusou. Sem marcação a lista vem vazia e a Home mostra só o nome.
-- Rodar este arquivo inteiro numa consulta NOVA do SQL Editor ("New query") — tudo é create or replace.
-- Enquanto esta função não existir, a Home cai sozinha na v2 (e, sem a v2, na v1).
-- =============================================================================
create or replace function public.get_recent_reports_v3(p_limit int default 10)
  returns table(name text, sector text, link text, date date, companies jsonb)
  language sql stable security definer set search_path = public, pg_temp as $$
  with fontes as (
    select c.updated_at, 0 as bloco, e.p, e.ord
      from public.clipping_config c
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(c.settings->'recent_publications') = 'array'
             then c.settings->'recent_publications' else '[]'::jsonb end) with ordinality as e(p, ord)
    union all
    select c.updated_at, 1 as bloco, e.p, e.ord
      from public.clipping_config c
      cross join lateral jsonb_array_elements(
        case when c.settings->'earnings_review'->'on' = 'true'::jsonb
              and jsonb_typeof(c.settings->'earnings_review'->'items') = 'array'
             then c.settings->'earnings_review'->'items' else '[]'::jsonb end) with ordinality as e(p, ord)
  ), itens as (
    select nullif(btrim(f.p->>'name'), '')                          as name,
           upper(coalesce(nullif(btrim(f.p->>'sector'), ''), 'SM')) as sector,
           nullif(btrim(f.p->>'link'), '')                          as link,
           public._try_date(f.p->>'date')                           as date,
           case when jsonb_typeof(f.p->'companies') = 'array'
                then (select coalesce(jsonb_agg(upper(btrim(x))), '[]'::jsonb)
                        from jsonb_array_elements_text(f.p->'companies') as x
                       where btrim(x) <> '')
                else '[]'::jsonb end                                 as companies,
           f.updated_at, f.bloco, f.ord
      from fontes f
  ), unicos as (
    select distinct on (coalesce(i.link, lower(i.name))) i.*
      from itens i
     where i.name is not null
     order by coalesce(i.link, lower(i.name)), i.date desc nulls last, i.updated_at desc, i.bloco, i.ord
  )
  select u.name,
         case when u.sector in ('SM', 'PP', 'NR') then u.sector else 'SM' end,
         case when u.link ~* '^https?://' then u.link end,
         u.date,
         u.companies
    from unicos u
   order by u.date desc nulls last, u.updated_at desc, u.bloco, u.ord
   limit greatest(1, least(coalesce(p_limit, 10), 20));
$$;
revoke all on function public.get_recent_reports_v3(int) from public, anon;
grant execute on function public.get_recent_reports_v3(int) to authenticated;

comment on function public.get_recent_reports_v3(int) is
  'Home da dashboard (2026-10-29): últimos relatórios (Recent Publications + Earnings Review ligado) com as EMPRESAS marcadas '
  'no Clipping (companies). Só nome, setor, link, data e tickers. SECURITY DEFINER; nada mais da configuração sai.';
notify pgrst, 'reload schema';
