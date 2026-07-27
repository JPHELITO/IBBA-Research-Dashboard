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

-- ───────────── 2) FEATURE FLAG (nasce DESLIGADA; só controla o link no menu — acesso é por is_admin) ─────────────
insert into public.dashboard_flags (key, label, sort_order, enabled) values
  ('clipinator', 'Clipinator (gerador de clipping — só admin)', 120, false)
on conflict (key) do nothing;

-- ───────────── 3) ENFILEIRAR (frontend admin → cria um job pending) ─────────────
-- p_payload: array JSON com a seleção curada. p_ref_date: data do clipping (default = hoje BRT).
create or replace function public.admin_enqueue_clipping(p_payload jsonb, p_ref_date date default null)
  returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
  declare v_id uuid;
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    if jsonb_typeof(p_payload) is distinct from 'array' or jsonb_array_length(p_payload) = 0 then
      raise exception 'payload vazio ou inválido' using errcode='22023';
    end if;
    insert into public.clipping_jobs (status, ref_date, payload, requested_by)
    values ('pending',
            coalesce(p_ref_date, (now() at time zone 'America/Sao_Paulo')::date),
            p_payload, auth.uid())
    returning id into v_id;
    return v_id;
  end; $$;
revoke all on function public.admin_enqueue_clipping(jsonb, date) from public, anon;
grant execute on function public.admin_enqueue_clipping(jsonb, date) to authenticated;

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
create or replace function public.admin_get_clipping_candidates(p_hours int default 24)
  returns table(
    url text, domain text, title text, source_name text, snippet text,
    published_at text, found_at text, sector text, take text, take_llm text
  )
  language sql stable security definer set search_path = public, pg_temp as $$
  select n.url, n.domain, n.title, n.source_name, n.snippet,
         n.published_at::text, n.found_at::text, n.sector, n.take, n.take_llm
  from public.news_articles n
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
