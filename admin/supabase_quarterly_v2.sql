-- =============================================================================
-- QUARTERLY v2 — página própria de resultados trimestrais (quarterly.html)
--
-- Rodar no SQL Editor do Supabase (projeto mmhkqkpjrvyxovpihnio). IDEMPOTENTE: pode rodar de novo.
-- REQUER (já rodados antes): supabase_admin_schema.sql (is_admin) · supabase_config_schema.sql
--   (dashboard_flags) · supabase_stock_guide.sql + _v2_upload (stock_guide_companies com base_ccy)
--   · supabase_stock_guide_rename_ticker.sql · supabase_quarterly.sql (quarterly_kpis).
--
-- O QUE CRIA
--   quarterly_imports        cada upload de modelo vira uma VERSÃO: staging → active → superseded
--                            (ou reverted). Publicar e desfazer = trocar o status, nada é apagado.
--   quarterly_import_series  as séries de cada versão: uma linha por (versão, série), valores em jsonb
--                            {"2026Q2": 53012, ...}.
--   quarterly_annotations    notas de evento curadas pelo admin (texto em inglês, aparecem no gráfico)
--   quarterly_fx             câmbio médio e de fim de cada trimestre (PTAX), para o botão US$
--   quarterly_kpis           + 3 colunas de ações (o robô da CVM preenche)
--   RPCs de leitura (cliente, hide-aware e só com a flag `quarterly` ligada) e de escrita (só admin)
--
-- PADRÃO DA CASA: RLS ligado e SEM policy → ninguém lê tabela direto; leitura por RPC SECURITY
-- DEFINER; escrita por RPC guardada por is_admin().
--
-- ⚠️ TRAVAS NO SERVIDOR (valem mesmo que o navegador erre): trimestre no formato AAAAQn, nunca
-- depois do corte do upload nem do trimestre corrente (projeção não entra), só número, e nada com
-- cara de dado pago (platts, fastmarkets, foex, pix, lme) ou de consenso/guidance.
--
-- ⚠️ A flag `quarterly` vale DENTRO das RPCs de leitura, e não só na tela: o Preview do staging e
-- a produção usam o MESMO banco.
--
-- ⚠️ Este arquivo REDEFINE admin_rename_stock_guide_company (acrescenta as tabelas novas). Se um
-- dia mexer no supabase_stock_guide_rename_ticker.sql, rodar este aqui de novo depois.
--
-- DESFAZER TUDO (a flag `quarterly` já existia e FICA):
--   drop function if exists public.get_quarterly_boot(int), public.get_quarterly_company(text),
--     public.get_quarterly_metric(text[]), public.admin_quarterly_begin(text, jsonb),
--     public.admin_quarterly_chunk(bigint, int, jsonb), public.admin_quarterly_commit(bigint, int, int),
--     public.admin_quarterly_abort(bigint), public.admin_quarterly_history(text),
--     public.admin_quarterly_revert(bigint), public.admin_get_quarterly_annotations(text),
--     public.admin_upsert_quarterly_annotation(bigint, text, text, text, text, text, text, boolean),
--     public.admin_delete_quarterly_annotation(bigint), public._q_can_read(), public._q_current(),
--     public._q_add(text, int), public._q_is_denied(text), public._q_filed_ticker(text);
--   drop table if exists public.quarterly_import_series, public.quarterly_imports,
--     public.quarterly_annotations, public.quarterly_fx;
--   alter table public.quarterly_kpis drop column if exists shares_total,
--     drop column if exists shares_treasury, drop column if exists shares_out;
--   (e rodar de novo o supabase_stock_guide_rename_ticker.sql para voltar a RPC de renomear)
-- =============================================================================


-- ───────────── 1) TABELAS ─────────────

alter table public.quarterly_kpis add column if not exists shares_total    numeric;
alter table public.quarterly_kpis add column if not exists shares_treasury numeric;
alter table public.quarterly_kpis add column if not exists shares_out      numeric;

create table if not exists public.quarterly_imports (
  id            bigserial primary key,
  company       text not null,                        -- ticker do Stock Guide (VALE3, AUGO, CMPC…)
  status        text not null default 'staging'
                check (status in ('staging','active','superseded','reverted','aborted')),
  file_name     text,
  file_sha256   text,
  manifest_id   text,
  manifest_v    int,
  lib_v         text,
  first_q       text check (first_q is null or first_q ~ '^\d{4}Q[1-4]$'),
  cutoff_q      text not null check (cutoff_q ~ '^\d{4}Q[1-4]$'),
  cutoff_basis  text,                                 -- de onde veio o corte (filed, calendário, manual)
  n_series      int,
  n_values      int,
  checks        jsonb not null default '[]'::jsonb,    -- avisos da prévia (bloqueio/atenção/info)
  diff          jsonb,                                -- o que mudou contra a versão ativa
  created_at    timestamptz not null default now(),
  created_by    uuid,
  committed_at  timestamptz,
  committed_by  uuid,
  reverted_at   timestamptz
);
alter table public.quarterly_imports enable row level security;
-- no máximo UMA versão ativa por empresa
create unique index if not exists quarterly_imports_one_active
  on public.quarterly_imports (company) where status = 'active';
create index if not exists quarterly_imports_company_idx
  on public.quarterly_imports (company, created_at desc);

create table if not exists public.quarterly_import_series (
  import_id    bigint not null references public.quarterly_imports(id) on delete cascade,
  series_key   text not null check (series_key ~ '^[a-z0-9_.]{1,80}$'),   -- chave ESTÁVEL do manifesto
  std_key      text,                                  -- métrica comparável (revenue, adj_ebitda…)
  def          text,                                  -- definição (ex.: brl_ex_downtime), p/ o Compare
  section      text,
  segment      text,
  label_en     text,                                  -- rótulo em inglês para a tela
  label_model  text,                                  -- rótulo exatamente como está no modelo
  unit         text not null,
  ccy          text check (ccy is null or ccy ~ '^[A-Z]{3}$'),
  agg          text not null default 'flow' check (agg in ('flow','stock','rate')),
  role         text not null default 'series' check (role in ('series','overlay')),
  headline     boolean not null default false,        -- entra na visão inicial (Season board)
  is_calc      boolean not null default false,        -- recalculada pelo importador (preço = receita ÷ volume)
  ord          int not null default 0,
  vals         jsonb not null default '{}'::jsonb,
  cell_flags   jsonb not null default '{}'::jsonb,    -- esparso: {"2026Q2":"analyst_adj"}
  primary key (import_id, series_key)
);
alter table public.quarterly_import_series add column if not exists is_calc boolean not null default false;
alter table public.quarterly_import_series enable row level security;

create table if not exists public.quarterly_annotations (
  id          bigserial primary key,
  company     text not null,
  q_from      text not null check (q_from ~ '^\d{4}Q[1-4]$'),
  q_to        text check (q_to is null or q_to ~ '^\d{4}Q[1-4]$'),
  scope_key   text,                                   -- série ou métrica; vazio = a empresa inteira
  kind        text not null default 'event' check (kind in ('event','break','stoppage','adjustment')),
  text_en     text not null check (length(text_en) between 3 and 280),
  origin      text not null default 'admin',
  is_visible  boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
alter table public.quarterly_annotations enable row level security;
create index if not exists quarterly_annotations_company_idx on public.quarterly_annotations (company, q_from);

create table if not exists public.quarterly_fx (
  ccy         text not null check (ccy ~ '^[A-Z]{3}$'),   -- moeda por 1 US$ (BRL = PTAX)
  quarter     text not null check (quarter ~ '^\d{4}Q[1-4]$'),
  avg_rate    numeric,
  eop_rate    numeric,
  source      text not null default 'PTAX',
  updated_at  timestamptz not null default now(),
  primary key (ccy, quarter)
);
alter table public.quarterly_fx enable row level security;


-- ───────────── 2) AJUDANTES ─────────────

-- trimestre corrente no relógio de São Paulo ('2026Q3')
create or replace function public._q_current() returns text
  language sql stable set search_path = public, pg_temp as $$
  select to_char(timezone('America/Sao_Paulo', now()), 'YYYY') || 'Q'
      || extract(quarter from timezone('America/Sao_Paulo', now()))::int::text
$$;

-- '2026Q2' + n trimestres
create or replace function public._q_add(q text, n int) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select (s.i / 4)::text || 'Q' || (s.i % 4 + 1)::text
    from (select substr(q, 1, 4)::int * 4 + substr(q, 6, 1)::int - 1 + n as i) s
$$;

-- o cliente pode ler? (flag ligada) — admin sempre pode
create or replace function public._q_can_read() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_admin()
      or exists (select 1 from public.dashboard_flags where key = 'quarterly' and enabled)
$$;

-- rótulo/chave com cara de dado pago ou de consenso → recusado
create or replace function public._q_is_denied(t text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select coalesce(t, '') ~* '(platts|fastmarkets|foex|(^|[^a-z])pix([^a-z]|$)|(^|[^a-z])lme([^a-z]|$)|consensus|guidance)'
$$;

-- quarterly_kpis guarda o ticker da CVM; a página usa o do Stock Guide (Aura = AUGO)
create or replace function public._q_filed_ticker(t text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select case t when 'AURA33' then 'AUGO' else t end
$$;

revoke all on function public._q_can_read() from public;


-- ───────────── 3) LEITURA (cliente) ─────────────

-- VISÃO INICIAL: empresas + séries de manchete dos últimos p_last trimestres (+4 para o YoY)
-- + o "as filed" da mesma janela + câmbio + notas. ~40 KB cru para as 14.
drop function if exists public.get_quarterly_boot(int);
create function public.get_quarterly_boot(p_last int default 12)
  returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_admin boolean := public.is_admin();
  v_last  int     := greatest(4, least(coalesce(p_last, 12), 80));
  v_from  text;
begin
  if not public._q_can_read() then return jsonb_build_object('enabled', false); end if;
  v_from := public._q_add(public._q_current(), -(v_last + 4));
  return jsonb_build_object(
    'enabled', true,
    'current_q', public._q_current(),
    'from_q', v_from,
    'companies', coalesce((
      select jsonb_agg(jsonb_build_object(
               'ticker', c.ticker, 'name', c.company_name, 'sector', c.sector,
               'base_ccy', c.base_ccy, 'display_order', c.display_order,
               'model', (select jsonb_build_object('import_id', i.id, 'first_q', i.first_q,
                                 'cutoff_q', i.cutoff_q, 'committed_at', i.committed_at)
                           from public.quarterly_imports i
                          where i.company = c.ticker and i.status = 'active'),
               'filed_last', (select max(k.quarter) from public.quarterly_kpis k
                               where public._q_filed_ticker(k.company) = c.ticker))
             order by c.display_order, c.ticker)
        from public.stock_guide_companies c
       where c.is_visible or v_admin), '[]'::jsonb),
    'series', coalesce((
      select jsonb_agg(jsonb_build_object(
               'company', i.company, 'key', s.series_key, 'std', s.std_key, 'def', s.def,
               'unit', s.unit, 'ccy', s.ccy, 'agg', s.agg, 'label', s.label_en, 'calc', s.is_calc,
               'vals', (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                          from jsonb_each(s.vals) e where e.key >= v_from))
             order by i.company, s.ord)
        from public.quarterly_imports i
        join public.quarterly_import_series s on s.import_id = i.id
        join public.stock_guide_companies c on c.ticker = i.company
       where i.status = 'active' and s.headline and s.role = 'series'
         and (c.is_visible or v_admin)), '[]'::jsonb),
    'filed', coalesce((
      select jsonb_agg(jsonb_build_object(
               'company', public._q_filed_ticker(k.company), 'q', k.quarter, 'ccy', k.currency,
               'rev', round(k.net_revenue / 1000.0, 1), 'ni', round(k.net_income / 1000.0, 1),
               'ebitda', round(k.ebitda / 1000.0, 1), 'nd', round(k.net_debt / 1000.0, 1),
               'src', k.source)
             order by k.company, k.quarter)
        from public.quarterly_kpis k
        join public.stock_guide_companies c on c.ticker = public._q_filed_ticker(k.company)
       where k.quarter >= v_from and (c.is_visible or v_admin)), '[]'::jsonb),
    'fx', coalesce((
      select jsonb_object_agg(x.ccy, x.m) from (
        select f.ccy, jsonb_object_agg(f.quarter, jsonb_build_array(f.avg_rate, f.eop_rate)) as m
          from public.quarterly_fx f where f.quarter >= v_from group by f.ccy) x), '{}'::jsonb),
    'notes', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'company', a.company, 'q_from', a.q_from,
               'q_to', a.q_to, 'scope', a.scope_key, 'kind', a.kind, 'text', a.text_en)
             order by a.company, a.q_from)
        from public.quarterly_annotations a
        join public.stock_guide_companies c on c.ticker = a.company
       where a.is_visible and (c.is_visible or v_admin)), '[]'::jsonb)
  );
end $$;
revoke all on function public.get_quarterly_boot(int) from public;
grant execute on function public.get_quarterly_boot(int) to anon, authenticated;

-- UMA EMPRESA, histórico inteiro (aberta sob demanda). 80–240 KB cru.
drop function if exists public.get_quarterly_company(text);
create function public.get_quarterly_company(p_ticker text)
  returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_admin boolean := public.is_admin();
  v_co    public.stock_guide_companies%rowtype;
begin
  if not public._q_can_read() then return jsonb_build_object('enabled', false); end if;
  select * into v_co from public.stock_guide_companies where ticker = p_ticker and (is_visible or v_admin);
  if v_co.ticker is null then return jsonb_build_object('enabled', true, 'company', null); end if;
  return jsonb_build_object(
    'enabled', true,
    'company', jsonb_build_object('ticker', v_co.ticker, 'name', v_co.company_name, 'sector', v_co.sector,
                 'base_ccy', v_co.base_ccy,
                 'model', (select jsonb_build_object('import_id', i.id, 'first_q', i.first_q,
                                   'cutoff_q', i.cutoff_q, 'committed_at', i.committed_at,
                                   'file_name', case when v_admin then i.file_name end)
                             from public.quarterly_imports i
                            where i.company = v_co.ticker and i.status = 'active')),
    'series', coalesce((
      select jsonb_agg(jsonb_build_object(
               'key', s.series_key, 'std', s.std_key, 'def', s.def, 'section', s.section,
               'segment', s.segment, 'label', s.label_en, 'label_model', s.label_model,
               'unit', s.unit, 'ccy', s.ccy, 'agg', s.agg, 'role', s.role, 'headline', s.headline,
               'ord', s.ord, 'calc', s.is_calc, 'vals', s.vals, 'flags', s.cell_flags)
             order by s.ord, s.series_key)
        from public.quarterly_imports i
        join public.quarterly_import_series s on s.import_id = i.id
       where i.company = v_co.ticker and i.status = 'active'), '[]'::jsonb),
    'filed', coalesce((
      select jsonb_agg(jsonb_build_object(
               'q', k.quarter, 'ccy', k.currency, 'src', k.source,
               'rev', round(k.net_revenue / 1000.0, 1), 'ebit', round(k.ebit / 1000.0, 1),
               'da', round(k.d_a / 1000.0, 1), 'ebitda', round(k.ebitda / 1000.0, 1),
               'ni', round(k.net_income / 1000.0, 1), 'ocf', round(k.ocf / 1000.0, 1),
               'capex', round(k.capex / 1000.0, 1), 'cash', round(k.cash / 1000.0, 1),
               'debt', round(k.debt / 1000.0, 1), 'nd', round(k.net_debt / 1000.0, 1),
               'shares', k.shares_out)
             order by k.quarter)
        from public.quarterly_kpis k
       where public._q_filed_ticker(k.company) = v_co.ticker), '[]'::jsonb),
    'fx', coalesce((
      select jsonb_object_agg(x.ccy, x.m) from (
        select f.ccy, jsonb_object_agg(f.quarter, jsonb_build_array(f.avg_rate, f.eop_rate)) as m
          from public.quarterly_fx f group by f.ccy) x), '{}'::jsonb),
    'notes', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'q_from', a.q_from, 'q_to', a.q_to,
               'scope', a.scope_key, 'kind', a.kind, 'text', a.text_en) order by a.q_from)
        from public.quarterly_annotations a
       where a.company = v_co.ticker and a.is_visible), '[]'::jsonb)
  );
end $$;
revoke all on function public.get_quarterly_company(text) from public;
grant execute on function public.get_quarterly_company(text) to anon, authenticated;

-- ATÉ 3 MÉTRICAS comparáveis em todas as empresas (visão Compare)
drop function if exists public.get_quarterly_metric(text[]);
create function public.get_quarterly_metric(p_keys text[])
  returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_admin boolean := public.is_admin();
begin
  if not public._q_can_read() then return jsonb_build_object('enabled', false); end if;
  if p_keys is null or cardinality(p_keys) = 0 or cardinality(p_keys) > 3 then
    raise exception 'keys_1_to_3' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'enabled', true,
    'series', coalesce((
      select jsonb_agg(jsonb_build_object(
               'company', i.company, 'key', s.series_key, 'std', s.std_key, 'def', s.def,
               'label', s.label_en, 'unit', s.unit, 'ccy', s.ccy, 'agg', s.agg, 'calc', s.is_calc, 'vals', s.vals)
             order by c.display_order, s.ord)
        from public.quarterly_imports i
        join public.quarterly_import_series s on s.import_id = i.id
        join public.stock_guide_companies c on c.ticker = i.company
       where i.status = 'active' and s.role = 'series' and s.std_key = any(p_keys)
         and (c.is_visible or v_admin)), '[]'::jsonb),
    'filed', coalesce((
      select jsonb_agg(jsonb_build_object(
               'company', public._q_filed_ticker(k.company), 'q', k.quarter, 'ccy', k.currency,
               'rev', round(k.net_revenue / 1000.0, 1), 'ni', round(k.net_income / 1000.0, 1),
               'ebitda', round(k.ebitda / 1000.0, 1), 'nd', round(k.net_debt / 1000.0, 1),
               'ocf', round(k.ocf / 1000.0, 1), 'capex', round(k.capex / 1000.0, 1),
               'da', round(k.d_a / 1000.0, 1))
             order by k.company, k.quarter)
        from public.quarterly_kpis k
        join public.stock_guide_companies c on c.ticker = public._q_filed_ticker(k.company)
       where (c.is_visible or v_admin)), '[]'::jsonb),
    'fx', coalesce((
      select jsonb_object_agg(x.ccy, x.m) from (
        select f.ccy, jsonb_object_agg(f.quarter, jsonb_build_array(f.avg_rate, f.eop_rate)) as m
          from public.quarterly_fx f group by f.ccy) x), '{}'::jsonb)
  );
end $$;
revoke all on function public.get_quarterly_metric(text[]) from public;
grant execute on function public.get_quarterly_metric(text[]) to anon, authenticated;


-- ───────────── 4) ESCRITA (só admin): begin → lotes → commit ─────────────

drop function if exists public.admin_quarterly_begin(text, jsonb);
create function public.admin_quarterly_begin(p_company text, p_meta jsonb)
  returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_cut   text := p_meta->>'cutoff_q';
  v_first text := nullif(p_meta->>'first_q', '');
  v_id    bigint;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.stock_guide_companies where ticker = p_company) then
    raise exception 'company_not_found: %', p_company using errcode = '22023';
  end if;
  if v_cut is null or v_cut !~ '^\d{4}Q[1-4]$' then
    raise exception 'cutoff_invalid: %', v_cut using errcode = '22023';
  end if;
  if v_cut >= public._q_current() then
    raise exception 'cutoff_not_past: % (o trimestre corrente é %)', v_cut, public._q_current()
      using errcode = '22023';
  end if;
  if v_first is not null and (v_first !~ '^\d{4}Q[1-4]$' or v_first > v_cut) then
    raise exception 'first_q_invalid: %', v_first using errcode = '22023';
  end if;
  -- upload anterior da mesma empresa que ficou no meio (aba fechada) vira aborted
  update public.quarterly_imports set status = 'aborted'
   where company = p_company and status = 'staging' and created_at < now() - interval '1 hour';
  delete from public.quarterly_import_series
   where import_id in (select id from public.quarterly_imports where company = p_company and status = 'aborted');
  insert into public.quarterly_imports (company, status, file_name, file_sha256, manifest_id, manifest_v,
         lib_v, first_q, cutoff_q, cutoff_basis, checks, diff, created_by)
  values (p_company, 'staging', left(p_meta->>'file_name', 200), p_meta->>'file_sha256',
          p_meta->>'manifest_id', nullif(p_meta->>'manifest_v', '')::int, p_meta->>'lib_v',
          v_first, v_cut, left(p_meta->>'cutoff_basis', 200),
          coalesce(p_meta->'checks', '[]'::jsonb), p_meta->'diff', auth.uid())
  returning id into v_id;
  return v_id;
end $$;

drop function if exists public.admin_quarterly_chunk(bigint, int, jsonb);
create function public.admin_quarterly_chunk(p_import bigint, p_seq int, p_series jsonb)
  returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_company text;
  v_cut     text;
  e         jsonb;
  kv        record;
  n         int := 0;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select company, cutoff_q into v_company, v_cut
    from public.quarterly_imports where id = p_import and status = 'staging';
  if v_company is null then raise exception 'import_not_staging: %', p_import using errcode = '22023'; end if;
  if jsonb_typeof(p_series) is distinct from 'array' then
    raise exception 'series_must_be_array (lote %)', p_seq using errcode = '22023';
  end if;
  for e in select value from jsonb_array_elements(p_series) loop
    if coalesce(e->>'series_key', '') !~ '^[a-z0-9_.]{1,80}$' then
      raise exception 'series_key_invalid: %', e->>'series_key' using errcode = '22023';
    end if;
    if coalesce(e->>'unit', '') !~ '^[A-Za-z0-9_/%.]{1,16}$' then
      raise exception 'unit_invalid: % (%)', e->>'unit', e->>'series_key' using errcode = '22023';
    end if;
    if public._q_is_denied(e->>'series_key') or public._q_is_denied(e->>'label_en')
       or public._q_is_denied(e->>'label_model') or public._q_is_denied(e->>'std_key')
       or public._q_is_denied(e->>'def') then
      raise exception 'denied_label (dado pago ou consenso): %', e->>'series_key' using errcode = '22023';
    end if;
    if jsonb_typeof(coalesce(e->'vals', '{}'::jsonb)) <> 'object' then
      raise exception 'vals_must_be_object: %', e->>'series_key' using errcode = '22023';
    end if;
    for kv in select key, value from jsonb_each(coalesce(e->'vals', '{}'::jsonb)) loop
      if kv.key !~ '^\d{4}Q[1-4]$' then
        raise exception 'quarter_invalid: % em %', kv.key, e->>'series_key' using errcode = '22023';
      end if;
      if kv.key > v_cut then
        raise exception 'after_cutoff: % > % em %', kv.key, v_cut, e->>'series_key' using errcode = '22023';
      end if;
      if jsonb_typeof(kv.value) <> 'number' then
        raise exception 'value_not_number: % em %', kv.key, e->>'series_key' using errcode = '22023';
      end if;
    end loop;
    insert into public.quarterly_import_series (import_id, series_key, std_key, def, section, segment,
           label_en, label_model, unit, ccy, agg, role, headline, is_calc, ord, vals, cell_flags)
    values (p_import, e->>'series_key', nullif(e->>'std_key', ''), nullif(e->>'def', ''),
            nullif(e->>'section', ''), nullif(e->>'segment', ''), left(e->>'label_en', 120),
            left(e->>'label_model', 120), e->>'unit', nullif(e->>'ccy', ''),
            coalesce(nullif(e->>'agg', ''), 'flow'), coalesce(nullif(e->>'role', ''), 'series'),
            coalesce((e->>'headline')::boolean, false), coalesce((e->>'is_calc')::boolean, false),
            coalesce((e->>'ord')::int, 0),
            coalesce(e->'vals', '{}'::jsonb), coalesce(e->'cell_flags', '{}'::jsonb))
    on conflict (import_id, series_key) do update set
      std_key = excluded.std_key, def = excluded.def, section = excluded.section,
      segment = excluded.segment, label_en = excluded.label_en, label_model = excluded.label_model,
      unit = excluded.unit, ccy = excluded.ccy, agg = excluded.agg, role = excluded.role,
      headline = excluded.headline, is_calc = excluded.is_calc, ord = excluded.ord, vals = excluded.vals,
      cell_flags = excluded.cell_flags;
    n := n + 1;
  end loop;
  return n;
end $$;

drop function if exists public.admin_quarterly_commit(bigint, int, int);
create function public.admin_quarterly_commit(p_import bigint, p_n_series int, p_n_values int)
  returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_company text;
  v_ns      int;
  v_nv      int;
  v_prev    bigint;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select company into v_company from public.quarterly_imports where id = p_import and status = 'staging';
  if v_company is null then raise exception 'import_not_staging: %', p_import using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('quarterly:' || v_company));
  -- o servidor reconta o que recebeu: lote perdido no caminho não vira versão ativa
  select count(distinct s.series_key), count(k.k)
    into v_ns, v_nv
    from public.quarterly_import_series s
    left join lateral jsonb_object_keys(s.vals) as k(k) on true
   where s.import_id = p_import;
  if v_ns = 0 then raise exception 'empty_import' using errcode = '22023'; end if;
  if v_ns <> p_n_series or v_nv <> p_n_values then
    raise exception 'count_mismatch: servidor % séries/% valores, navegador %/%',
      v_ns, v_nv, p_n_series, p_n_values using errcode = '22023';
  end if;
  update public.quarterly_imports set status = 'superseded'
   where company = v_company and status = 'active'
  returning id into v_prev;
  update public.quarterly_imports
     set status = 'active', committed_at = now(), committed_by = auth.uid(),
         n_series = v_ns, n_values = v_nv
   where id = p_import;
  return jsonb_build_object('id', p_import, 'company', v_company, 'n_series', v_ns,
                            'n_values', v_nv, 'superseded', v_prev);
end $$;

drop function if exists public.admin_quarterly_abort(bigint);
create function public.admin_quarterly_abort(p_import bigint)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.quarterly_imports set status = 'aborted' where id = p_import and status = 'staging';
  delete from public.quarterly_import_series
   where import_id = p_import
     and exists (select 1 from public.quarterly_imports i where i.id = p_import and i.status = 'aborted');
end $$;

drop function if exists public.admin_quarterly_history(text);
create function public.admin_quarterly_history(p_company text default null)
  returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(x.j order by x.created_at desc) from (
      select i.created_at, jsonb_build_object(
               'id', i.id, 'company', i.company, 'status', i.status, 'file_name', i.file_name,
               'manifest', i.manifest_id || ' v' || coalesce(i.manifest_v::text, '?'),
               'lib_v', i.lib_v, 'first_q', i.first_q, 'cutoff_q', i.cutoff_q,
               'cutoff_basis', i.cutoff_basis, 'n_series', i.n_series, 'n_values', i.n_values,
               'n_block', (select count(*) from jsonb_array_elements(i.checks) c where c->>'level' = 'block'),
               'n_warn',  (select count(*) from jsonb_array_elements(i.checks) c where c->>'level' = 'warn'),
               'created_at', i.created_at, 'committed_at', i.committed_at,
               'reverted_at', i.reverted_at) as j
        from public.quarterly_imports i
       where (p_company is null or i.company = p_company) and i.status <> 'aborted'
       order by i.created_at desc
       limit 200) x), '[]'::jsonb);
end $$;

drop function if exists public.admin_quarterly_revert(bigint);
create function public.admin_quarterly_revert(p_import bigint)
  returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_company text;
  v_status  text;
  v_cur     bigint;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select company, status into v_company, v_status from public.quarterly_imports where id = p_import;
  if v_company is null then raise exception 'import_not_found: %', p_import using errcode = '22023'; end if;
  if v_status not in ('superseded', 'reverted') then
    raise exception 'import_not_revertible: % (%)', p_import, v_status using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('quarterly:' || v_company));
  update public.quarterly_imports set status = 'reverted', reverted_at = now()
   where company = v_company and status = 'active'
  returning id into v_cur;
  update public.quarterly_imports set status = 'active', reverted_at = null where id = p_import;
  return jsonb_build_object('company', v_company, 'active', p_import, 'reverted', v_cur);
end $$;

-- notas de evento
drop function if exists public.admin_get_quarterly_annotations(text);
create function public.admin_get_quarterly_annotations(p_company text default null)
  returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'company', a.company, 'q_from', a.q_from,
             'q_to', a.q_to, 'scope', a.scope_key, 'kind', a.kind, 'text', a.text_en,
             'origin', a.origin, 'is_visible', a.is_visible, 'updated_at', a.updated_at)
           order by a.company, a.q_from)
      from public.quarterly_annotations a
     where p_company is null or a.company = p_company), '[]'::jsonb);
end $$;

drop function if exists public.admin_upsert_quarterly_annotation(bigint, text, text, text, text, text, text, boolean);
create function public.admin_upsert_quarterly_annotation(p_id bigint, p_company text, p_q_from text,
    p_q_to text, p_scope_key text, p_kind text, p_text_en text, p_is_visible boolean)
  returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id bigint;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.stock_guide_companies where ticker = p_company) then
    raise exception 'company_not_found: %', p_company using errcode = '22023';
  end if;
  if public._q_is_denied(p_text_en) then
    raise exception 'denied_text (dado pago ou consenso)' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.quarterly_annotations (company, q_from, q_to, scope_key, kind, text_en,
           is_visible, updated_by)
    values (p_company, p_q_from, nullif(p_q_to, ''), nullif(p_scope_key, ''),
            coalesce(nullif(p_kind, ''), 'event'), trim(p_text_en), coalesce(p_is_visible, true), auth.uid())
    returning id into v_id;
  else
    update public.quarterly_annotations
       set company = p_company, q_from = p_q_from, q_to = nullif(p_q_to, ''),
           scope_key = nullif(p_scope_key, ''), kind = coalesce(nullif(p_kind, ''), 'event'),
           text_en = trim(p_text_en), is_visible = coalesce(p_is_visible, true),
           updated_at = now(), updated_by = auth.uid()
     where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'annotation_not_found: %', p_id using errcode = '22023'; end if;
  end if;
  return v_id;
end $$;

drop function if exists public.admin_delete_quarterly_annotation(bigint);
create function public.admin_delete_quarterly_annotation(p_id bigint)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.quarterly_annotations where id = p_id;
end $$;

-- permissões das escritas: só usuário logado (e a função confere is_admin por dentro)
do $$
declare f text;
begin
  foreach f in array array[
    'public.admin_quarterly_begin(text, jsonb)',
    'public.admin_quarterly_chunk(bigint, int, jsonb)',
    'public.admin_quarterly_commit(bigint, int, int)',
    'public.admin_quarterly_abort(bigint)',
    'public.admin_quarterly_history(text)',
    'public.admin_quarterly_revert(bigint)',
    'public.admin_get_quarterly_annotations(text)',
    'public.admin_upsert_quarterly_annotation(bigint, text, text, text, text, text, text, boolean)',
    'public.admin_delete_quarterly_annotation(bigint)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke execute on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ───────────── 5) RENOMEAR TICKER: agora também nas tabelas do Quarterly ─────────────
-- Cópia da versão de supabase_stock_guide_rename_ticker.sql + as 2 tabelas novas.
create or replace function public.admin_rename_stock_guide_company(p_from text, p_to text)
  returns text language plpgsql security definer set search_path = public, pg_temp as $$
  declare
    v_from text := nullif(trim(p_from), '');
    v_to   text := nullif(trim(p_to), '');
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    if v_from is null or v_to is null then
      raise exception 'ticker_required' using errcode='22023'; end if;
    if v_from !~ '^[A-Za-z0-9]{1,12}$' or v_to !~ '^[A-Za-z0-9]{1,12}$' then
      raise exception 'invalid_ticker_format (só letras e números, até 12): % -> %', v_from, v_to
        using errcode='22023'; end if;
    if v_from = v_to then return v_to; end if;
    if not exists (select 1 from public.stock_guide_companies where ticker = v_from) then
      raise exception 'company_not_found: %', v_from using errcode='22023'; end if;
    if exists (select 1 from public.stock_guide_companies where ticker = v_to) then
      raise exception 'ticker_already_exists: %', v_to using errcode='23505'; end if;

    update public.stock_guide_companies
       set ticker = v_to, updated_at = now(), updated_by = auth.uid()
     where ticker = v_from;

    update public.stock_guide_scenario_grid
       set ticker = v_to
     where ticker = v_from;

    update public.stock_guide_sensitivities
       set companies  = array_replace(companies, v_from, v_to),
           definition = replace(definition::text, '"' || v_from || '"', '"' || v_to || '"')::jsonb,
           title      = regexp_replace(title, '\m' || v_from || '\M', v_to, 'g'),
           updated_at = now(), updated_by = auth.uid()
     where v_from = any(companies)
        or definition::text like '%"' || v_from || '"%'
        or title like '%' || v_from || '%';

    update public.quarterly_imports     set company = v_to where company = v_from;
    update public.quarterly_annotations set company = v_to where company = v_from;

    return v_to;
  end; $$;
revoke all     on function public.admin_rename_stock_guide_company(text, text) from public;
revoke execute on function public.admin_rename_stock_guide_company(text, text) from anon;
grant  execute on function public.admin_rename_stock_guide_company(text, text) to authenticated;


-- ───────────── 6) FLAG (já existia; só o rótulo do /admin muda) ─────────────
insert into public.dashboard_flags (key, enabled) values ('quarterly', false)
on conflict (key) do nothing;
update public.dashboard_flags set label = 'Página: Quarterly (resultados trimestrais)'
 where key = 'quarterly';

notify pgrst, 'reload schema';


-- ───────────── VERIFICAÇÃO (rodar depois; nada aqui grava) ─────────────
--   select public._q_current();                         -- trimestre corrente, ex.: 2026Q3
--   select public._q_add('2026Q1', -1);                 -- 2025Q4
--   select public._q_is_denied('pulp.pix_china'), public._q_is_denied('fin.revenue');   -- true | false
--   select jsonb_pretty(public.get_quarterly_boot(8)) ;  -- no editor (sem login) → {"enabled": false} com a flag OFF
--   select count(*) from public.quarterly_imports;       -- 0 antes do primeiro upload
-- =============================================================================
