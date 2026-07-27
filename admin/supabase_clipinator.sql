-- =============================================================================
-- CLIPINATOR — geração do clipping diário (ÁREA EXCLUSIVA DO ADMIN)
-- Rodar no SQL Editor do Supabase (projeto mmhkqkpjrvyxovpihnio). Idempotente.
-- REQUER: admin/supabase_admin_schema.sql (is_admin) + supabase_config_schema.sql (dashboard_flags).
-- Padrão (molde Executive Calendar): RLS habilitado SEM policy; acesso SÓ por RPC SECURITY DEFINER.
--   • Frontend (admin logado): RPCs guardadas por is_admin() (só authenticated).
--   • Backend (GitHub Actions): usa a SERVICE KEY, que IGNORA RLS → lê/atualiza a tabela direto
--     (não precisa de RPC). NENHUMA service key vai ao browser.
-- Esta área NUNCA é exposta ao cliente: a página exige is_admin() (a flag abaixo só controla o
-- link/menu; o portão de acesso é o admin, não a flag).
-- =============================================================================

-- ───────────── 1) TABELA DE JOBS (RLS on, SEM policy → acesso só pelas RPCs / service key) ─────────────
-- Um "job" = um pedido de clipping. O frontend enfileira (pending); o robô do Actions
-- reivindica (running), gera os arquivos, sobe no Storage e marca done/error.
create table if not exists public.clipping_jobs (
  id            uuid primary key default gen_random_uuid(),
  status        text not null default 'pending',   -- pending | running | done | error
  ref_date      date not null default (now() at time zone 'America/Sao_Paulo')::date,
  -- payload = a seleção curada pelo admin: [{url,title,source_name,take,sector,pos}]
  --   take  ∈ '+','=','-'   ·   sector ∈ 'SM','PP','NR','CEMENT' (ou '' = auto-detect no motor)
  payload       jsonb not null default '[]'::jsonb,
  docx_path     text,                               -- caminho no Storage quando pronto
  eml_path      text,
  error         text,                               -- mensagem legível quando status='error'
  requested_by  uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  claimed_at    timestamptz,                        -- quando o robô reivindicou
  finished_at   timestamptz
);
alter table public.clipping_jobs enable row level security;
create index if not exists clipping_jobs_status_idx  on public.clipping_jobs (status);
create index if not exists clipping_jobs_created_idx on public.clipping_jobs (created_at desc);
-- colunas adicionais (idempotente p/ tabelas já criadas)
alter table public.clipping_jobs add column if not exists config jsonb;   -- {intro, recent_publications, earnings_review}
alter table public.clipping_jobs add column if not exists errors jsonb;   -- [{url,reason}] corpos que falharam (Onda 4)
alter table public.clipping_jobs add column if not exists preview_path text;  -- URL assinada do HTML de prévia (Opção A)

-- ───────────── 1b) CORREÇÕES DE TAKE (Onda 5 — a IA aprende com o analista) ─────────────
-- Cada vez que você gera um clipping, grava-se 1 linha por notícia: o take que a IA sugeriu
-- (take_ai) vs. o que você escolheu (take_analyst). changed = você trocou (erro da IA) → esses
-- viram FEW-SHOT dinâmico no motor (hunter/llm_take.py), sem gastar as IAs. Definida ANTES da
-- admin_enqueue_clipping porque a função a referencia (check_function_bodies valida no CREATE).
-- RLS on, SEM policy: só a service key (motor lê) e a RPC SECURITY DEFINER (grava).
create table if not exists public.take_corrections (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  url             text unique,               -- 1 linha por notícia (re-gerar faz upsert)
  headline        text,
  source_name     text,
  sector          text,
  take_ai         text,                      -- +/-/= sugerido pela IA (news_articles.take_llm)
  take_analyst    text,                      -- +/-/= escolhido pelo analista no clipping
  changed         boolean not null default false,   -- take_ai <> take_analyst (a IA errou)
  used_in_fewshot boolean not null default false    -- p/ o passo futuro de promoção ao gabarito
);
alter table public.take_corrections enable row level security;
create index if not exists take_corrections_recent_idx on public.take_corrections (created_at desc);

-- ───────────── 1c) CORPOS GUARDADOS (velocidade — 100% À PARTE do news hunter) ─────────────
-- O clipping ganha o SEU PRÓPRIO armazém de corpos. Um "aquecedor" (clipping/warm_bodies.py, num
-- workflow separado) LÊ os candidatos (só leitura do news_articles — não escreve lá) e raspa+guarda
-- o corpo aqui. Depois: clicar na headline = corpo já pronto (instantâneo); Gerar = reusa (Word rápido).
-- NÃO toca no news_articles nem no pipeline do hunter. RLS on, SEM policy: service key grava (aquecedor)
-- + RPC SECURITY DEFINER lê (admin).
create table if not exists public.clipping_bodies (
  url               text primary key,
  title             text,
  source_name       text,
  body              text,               -- HTML seguro (article_to_safe_html), pronto p/ o Word/preview
  translated_title  text,               -- tradução EN (Valor/Estadão) — guardada p/ o Word sair instantâneo
  translated_body   text,
  status            text default 'ok',  -- ok | empty | error
  char_len          int  default 0,
  fetched_at        timestamptz not null default now()
);
alter table public.clipping_bodies enable row level security;
create index if not exists clipping_bodies_fetched_idx on public.clipping_bodies (fetched_at desc);

-- prévia por-notícia (admin clica na headline → corpo guardado, instantâneo)
create or replace function public.admin_get_clipping_body(p_url text)
  returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case when public.is_admin()
      then coalesce((select to_jsonb(b) from public.clipping_bodies b where b.url = p_url), '{}'::jsonb)
      else '{}'::jsonb end;
$$;
revoke all on function public.admin_get_clipping_body(text) from public, anon;
grant execute on function public.admin_get_clipping_body(text) to authenticated;

-- ───────────── 2) FEATURE FLAG (nasce DESLIGADA; só controla o link no menu — acesso é por is_admin) ─────────────
insert into public.dashboard_flags (key, label, sort_order, enabled) values
  ('clipinator', 'Clipinator (gerador de clipping — só admin)', 120, false)
on conflict (key) do nothing;

-- ───────────── 3) ENFILEIRAR (frontend admin → cria um job pending) ─────────────
-- p_payload: array JSON com a seleção curada. p_ref_date: data do clipping (default = hoje BRT).
drop function if exists public.admin_enqueue_clipping(jsonb, date);   -- substituída pela versão com p_config
create or replace function public.admin_enqueue_clipping(p_payload jsonb, p_ref_date date default null, p_config jsonb default null)
  returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
  declare v_id uuid;
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    if jsonb_typeof(p_payload) is distinct from 'array' or jsonb_array_length(p_payload) = 0 then
      raise exception 'payload vazio ou inválido' using errcode='22023';
    end if;
    insert into public.clipping_jobs (status, ref_date, payload, config, requested_by)
    values ('pending',
            coalesce(p_ref_date, (now() at time zone 'America/Sao_Paulo')::date),
            p_payload, p_config, auth.uid())
    returning id into v_id;

    -- Onda 5: registra as correções de take (IA sugeriu vs. analista escolheu) → few-shot dinâmico.
    -- Só quando a IA deu um take direcional (+/-/=); URL vira chave (re-gerar = upsert do mesmo item).
    insert into public.take_corrections (url, headline, source_name, sector, take_ai, take_analyst, changed)
    select e->>'url', left(coalesce(e->>'title',''), 400), e->>'source_name', e->>'sector',
           e->>'take_ai', e->>'take',
           (e->>'take_ai') is distinct from (e->>'take')
    from jsonb_array_elements(p_payload) e
    where e->>'take_ai' in ('+','-','=') and coalesce(e->>'url','') <> ''
    on conflict (url) do update set
      headline = excluded.headline, source_name = excluded.source_name, sector = excluded.sector,
      take_ai = excluded.take_ai, take_analyst = excluded.take_analyst,
      changed = excluded.changed, created_at = now(), used_in_fewshot = false;

    return v_id;
  end; $$;
revoke all on function public.admin_enqueue_clipping(jsonb, date, jsonb) from public, anon;
grant execute on function public.admin_enqueue_clipping(jsonb, date, jsonb) to authenticated;

-- ───────────── 4) LER JOBS (frontend admin → histórico + polling) ─────────────
create or replace function public.admin_get_clipping_jobs(p_limit int default 20)
  returns setof public.clipping_jobs
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.clipping_jobs
  where public.is_admin()
  order by created_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 200));
$$;
revoke all on function public.admin_get_clipping_jobs(int) from public, anon;
grant execute on function public.admin_get_clipping_jobs(int) to authenticated;

-- um job específico (polling depois de "Gerar")
create or replace function public.admin_get_clipping_job(p_id uuid)
  returns setof public.clipping_jobs
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.clipping_jobs where public.is_admin() and id = p_id;
$$;
revoke all on function public.admin_get_clipping_job(uuid) from public, anon;
grant execute on function public.admin_get_clipping_job(uuid) to authenticated;

-- ───────────── 5) CANCELAR / LIMPAR (opcional — admin) ─────────────
create or replace function public.admin_delete_clipping_job(p_id uuid)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    delete from public.clipping_jobs where id = p_id;
  end; $$;
revoke all on function public.admin_delete_clipping_job(uuid) from public, anon;
grant execute on function public.admin_delete_clipping_job(uuid) to authenticated;

-- ───────────── 6) CANDIDATOS (frontend admin → notícias recentes já classificadas) ─────────────
-- Lê news_articles das últimas p_hours (default 24h, teto 168h=7d), só as incluídas no report,
-- trazendo o take da IA (take_llm) e o setor como SUGESTÃO editável. Datas devolvidas como text
-- (robusto ao tipo real da coluna); comparação/ordem via ::timestamptz (funciona p/ text ou tstz).
-- ganhou a coluna has_body (2026-07-27) → o retorno mudou; create-or-replace não troca tipo de
-- retorno de função existente → precisa DROP antes (idempotente).
drop function if exists public.admin_get_clipping_candidates(int);
create or replace function public.admin_get_clipping_candidates(p_hours int default 24)
  returns table(
    url text, domain text, title text, source_name text, snippet text,
    published_at text, found_at text, sector text, take text, take_llm text, has_body boolean
  )
  language sql stable security definer set search_path = public, pg_temp as $$
  select n.url, n.domain, n.title, n.source_name, n.snippet,
         n.published_at::text, n.found_at::text, n.sector, n.take, n.take_llm,
         (b.char_len is not null and b.char_len > 80) as has_body   -- corpo já guardado (aquecedor)?
  from public.news_articles n
  left join public.clipping_bodies b on b.url = n.url
  where public.is_admin()
    and n.include_in_report is distinct from false
    -- Clipping usa SÓ estas 6 fontes (decisão do usuário 2026-07-27): scraping dedicado/liso
    and n.source_name = any (array['S&P Platts','Fastmarkets','Valor Econômico','Mining.com','Portal Celulose','Estadão'])
    and coalesce(n.published_at::timestamptz, n.found_at::timestamptz)
        >= now() - make_interval(hours => greatest(1, least(coalesce(p_hours, 24), 168)))
  order by coalesce(n.published_at::timestamptz, n.found_at::timestamptz) desc
  limit 400;
$$;
revoke all on function public.admin_get_clipping_candidates(int) from public, anon;
grant execute on function public.admin_get_clipping_candidates(int) to authenticated;

-- ───────────── 8) RASCUNHO PERSISTENTE (a pré-seleção fica salva até você gerar) ─────────────
-- Um rascunho por admin (auth.uid()): pré-seleciona na véspera → volta pronto na manhã seguinte.
create table if not exists public.clipping_drafts (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  payload     jsonb not null default '[]'::jsonb,   -- [{url,title,source_name,take,sector,pos}]
  updated_at  timestamptz not null default now()
);
alter table public.clipping_drafts enable row level security;

create or replace function public.admin_get_clipping_draft()
  returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case when public.is_admin()
              then coalesce((select payload from public.clipping_drafts where user_id = auth.uid()), '[]'::jsonb)
              else '[]'::jsonb end;
$$;
revoke all on function public.admin_get_clipping_draft() from public, anon;
grant execute on function public.admin_get_clipping_draft() to authenticated;

create or replace function public.admin_save_clipping_draft(p_payload jsonb)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    insert into public.clipping_drafts (user_id, payload, updated_at)
    values (auth.uid(), coalesce(p_payload, '[]'::jsonb), now())
    on conflict (user_id) do update set payload = excluded.payload, updated_at = now();
  end; $$;
revoke all on function public.admin_save_clipping_draft(jsonb) from public, anon;
grant execute on function public.admin_save_clipping_draft(jsonb) to authenticated;

-- ───────────── 9) CONFIG DO CLIPPING (intro/mensagem + Recent Publications + Earnings Review) ─────────────
-- Um registro por admin (auth.uid()): a caixa de mensagem, as publicações e o toggle/nome do
-- Earnings Review ficam salvos e voltam prontos. Vão no job via p_config do enqueue.
create table if not exists public.clipping_config (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  settings    jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
alter table public.clipping_config enable row level security;

create or replace function public.admin_get_clipping_config()
  returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case when public.is_admin()
              then coalesce((select settings from public.clipping_config where user_id = auth.uid()), '{}'::jsonb)
              else '{}'::jsonb end;
$$;
revoke all on function public.admin_get_clipping_config() from public, anon;
grant execute on function public.admin_get_clipping_config() to authenticated;

create or replace function public.admin_save_clipping_config(p_settings jsonb)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    insert into public.clipping_config (user_id, settings, updated_at)
    values (auth.uid(), coalesce(p_settings, '{}'::jsonb), now())
    on conflict (user_id) do update set settings = excluded.settings, updated_at = now();
  end; $$;
revoke all on function public.admin_save_clipping_config(jsonb) from public, anon;
grant execute on function public.admin_save_clipping_config(jsonb) to authenticated;

-- ───────────── 7) BACKEND: reivindicar o próximo job (só service_role — o robô do Actions) ─────────────
-- Claim atômico (FOR UPDATE SKIP LOCKED) → nunca dois runners pegam o mesmo job.
create or replace function public.claim_next_clipping_job()
  returns setof public.clipping_jobs
  language plpgsql security definer set search_path = public, pg_temp as $$
  declare v_id uuid;
  begin
    select id into v_id from public.clipping_jobs
      where status = 'pending' order by created_at
      for update skip locked limit 1;
    if v_id is null then return; end if;
    return query
      update public.clipping_jobs
        set status = 'running', claimed_at = now(), updated_at = now()
      where id = v_id
      returning *;
  end; $$;
revoke all on function public.claim_next_clipping_job() from public, anon, authenticated;
grant execute on function public.claim_next_clipping_job() to service_role;

-- =============================================================================
-- FIM. Idempotente (create-or-replace) → pode rodar o arquivo inteiro de novo com segurança.
-- A flag 'clipinator' pode ficar OFF — o acesso é por is_admin(); a flag só controla o link no menu.
-- O robô do Actions usa a SERVICE KEY (ignora RLS): reivindica via claim_next_clipping_job(),
-- gera os arquivos, sobe no Storage (bucket admin-uploads) e faz PATCH do job p/ done/error.
-- =============================================================================
