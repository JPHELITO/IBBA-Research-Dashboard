-- =============================================================================
-- RECOMENDAÇÕES DA CASA NA ABA MARKET (2026-11-05)
--   · botão "Since last update" no Range da Performance (desempenho da ação desde a
--     última atualização de modelo, com a nossa recomendação e o preço-alvo);
--   · liga/desliga "Ratings" no gráfico: etiquetas OP / MP / UP nas datas das
--     atualizações + a faixa da recomendação em vigor ao longo do tempo.
--
-- Rodar UMA vez no SQL Editor do Supabase (projeto mmhkqkpjrvyxovpihnio). Idempotente:
-- rodar de novo não apaga nada nem duplica nada.
--
-- POR QUE ISTO EXISTE, em português
-- A tabela do Stock Guide (stock_guide_companies) guarda só o ESTADO ATUAL de cada
-- empresa: cada upload do .xlsm sobrescreve a recomendação e o preço-alvo. Não sobrava
-- rastro de quando a casa trocou de OP para MP. Esta tabela guarda os EVENTOS:
-- uma linha por (empresa, data da publicação) com a recomendação e o preço-alvo do dia.
--
-- COMO ELA ENCHE
--   1. Sozinha, a cada upload do Stock Guide: um gatilho na stock_guide_companies grava
--      um evento — com a data da "Last Model Update Release" (célula E2 de cada aba de
--      empresa) — SÓ SE a recomendação ou o preço-alvo forem diferentes do último evento do
--      histórico (regra do usuário, 2026-11-06: mudar só a data não conta). Regravar igual
--      não cria nada; Stock Guide com data anterior ao último evento não reescreve o passado.
--      SEM DATA NÃO HÁ EVENTO — "preço sem data não é preço": um upload que não traga a
--      data (leitor antigo) não inventa "hoje".
--   2. À mão, no /admin → Stock Guide → ⭐ Recomendações: o histórico ANTERIOR (a planilha
--      só conhece a atualização mais recente) e as empresas fora do Stock Guide
--      (Aclara, Viridis). Dá para colar várias linhas do Excel de uma vez.
--
-- QUEM VÊ
--   · admin: sempre.
--   · cliente: só com a flag `market_ratings` LIGADA (/admin → Funcionalidades). Nasce
--     DESLIGADA, para você conferir o histórico antes de ele aparecer para os clientes.
--     Com a flag desligada a função devolve vazio para o cliente — não é só a tela que esconde.
--   · empresa OCULTA no Stock Guide (is_visible = false): o cliente não recebe o histórico dela.
-- =============================================================================

-- 1. A TABELA ------------------------------------------------------------------
create table if not exists public.stock_guide_rating_history (
  id             bigserial primary key,
  ticker         text not null,          -- a empresa, na chave do Stock Guide (VALE, CSNA3, AUGO…) ou ARA / VMM
  effective_date date not null,          -- data da publicação (a "Last Model Update Release")
  rating         text check (rating in ('OP','MP','UP','NR')),   -- NR = sem recomendação (restrito / em revisão)
  target_price   numeric check (target_price is null or target_price > 0),
  currency       text,                   -- moeda do preço-alvo (BRL, USD, CLP, MXN, CAD, AUD)
  listing        text,                   -- linha (símbolo do Yahoo) a que o preço-alvo se refere: a Vale é a ADR (VALE)
  note           text,                   -- livre: "Initiation", "Upgrade", "3Q26 review"…
  source         text not null default 'manual' check (source in ('stock_guide','manual','import')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid,
  unique (ticker, effective_date)
);
alter table public.stock_guide_rating_history enable row level security;   -- sem policy: só pelas funções abaixo
comment on table public.stock_guide_rating_history is
  'Histórico de recomendações da casa (OP/MP/UP + preço-alvo) por data de publicação. Enche sozinha a cada upload '
  'do Stock Guide (gatilho sg_capture_rating) e à mão pelo /admin. Lida pela aba Market (get_rating_history).';

-- 2. O GATILHO: cada upload do Stock Guide vira evento — SÓ SE MUDAR a recomendação ou o alvo
--    (regra do usuário em 2026-11-06; a mesma do supabase_market_ratings_v2_so_se_mudar.sql) ----------
create or replace function public._sg_capture_rating() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_last public.stock_guide_rating_history%rowtype;
begin
  -- renomeou a empresa (botão "Renomear" do /admin, ou VALE3 → VALE no upload): o histórico acompanha
  if tg_op = 'UPDATE' and new.ticker is distinct from old.ticker then
    update public.stock_guide_rating_history h set ticker = new.ticker
     where h.ticker = old.ticker
       and not exists (select 1 from public.stock_guide_rating_history x
                        where x.ticker = new.ticker and x.effective_date = h.effective_date);
    delete from public.stock_guide_rating_history where ticker = old.ticker;
  end if;
  -- sem data ou sem recomendação não há evento (nunca inventar "hoje")
  if new.last_update is null or new.recommendation is null then return new; end if;
  -- regravou igual (o mesmo arquivo de novo): nada a registrar
  if tg_op = 'UPDATE'
     and new.ticker         is not distinct from old.ticker
     and new.last_update    is not distinct from old.last_update
     and new.recommendation is not distinct from old.recommendation
     and new.target_price   is not distinct from old.target_price then
    return new;
  end if;
  -- SÓ SE MUDAR: compara com o ÚLTIMO evento do histórico (que pode ter sido corrigido à mão no /admin)
  select * into v_last from public.stock_guide_rating_history h
   where h.ticker = new.ticker
   order by h.effective_date desc limit 1;
  if found then
    if v_last.rating is not distinct from new.recommendation
       and v_last.target_price is not distinct from new.target_price then
      return new;                                   -- mesma recomendação e mesmo alvo: só a data mudou
    end if;
    if new.last_update < v_last.effective_date then
      return new;                                   -- Stock Guide atrás do histórico: não reescreve o passado
    end if;
  end if;
  insert into public.stock_guide_rating_history as h
         (ticker, effective_date, rating, target_price, currency, listing, source, updated_by)
  values (new.ticker, new.last_update, new.recommendation, new.target_price,
          new.trade_ccy, new.yahoo_symbol, 'stock_guide', auth.uid())
  on conflict (ticker, effective_date) do update
     set rating       = excluded.rating,
         target_price = excluded.target_price,
         currency     = coalesce(excluded.currency, h.currency),
         listing      = coalesce(excluded.listing, h.listing),
         updated_at   = now(),
         updated_by   = excluded.updated_by;   -- a nota escrita à mão fica
  return new;
end $$;
-- (sem REVOKE aqui: função de gatilho não pode ser chamada pela API, e mexer na permissão dela
--  arriscaria travar o upload do Stock Guide, que é quem a dispara)

drop trigger if exists sg_capture_rating on public.stock_guide_companies;
create trigger sg_capture_rating
  after insert or update on public.stock_guide_companies
  for each row execute function public._sg_capture_rating();

-- 2b. a ORDEM dos passos não importa: se a planilha (já com a data da E2) foi subida ANTES deste SQL, o
-- gatilho não existia para ver. O que o Stock Guide já sabe vira o 1º evento agora. Sem data, nada entra.
-- SÓ para empresa SEM histórico nenhum: rodar este arquivo de novo não recria datas corrigidas à mão.
insert into public.stock_guide_rating_history (ticker, effective_date, rating, target_price, currency, listing, source)
select c.ticker, c.last_update, c.recommendation, c.target_price, c.trade_ccy, c.yahoo_symbol, 'stock_guide'
  from public.stock_guide_companies c
 where c.last_update is not null and c.recommendation is not null
   and not exists (select 1 from public.stock_guide_rating_history h where h.ticker = c.ticker)
on conflict (ticker, effective_date) do nothing;

-- 3. LEITURA da aba Market (cliente logado) -------------------------------------
create or replace function public.get_rating_history()
  returns table(ticker text, company_name text, yahoo_symbol text, effective_date date, rating text,
                target_price numeric, currency text, listing text, note text)
  language sql stable security definer set search_path = public, pg_temp as $$
  select h.ticker, c.company_name, c.yahoo_symbol, h.effective_date, h.rating, h.target_price,
         h.currency, coalesce(h.listing, c.yahoo_symbol), h.note
    from public.stock_guide_rating_history h
    left join public.stock_guide_companies c on c.ticker = h.ticker
   where ((select public.is_admin())
          or exists (select 1 from public.dashboard_flags f where f.key = 'market_ratings' and f.enabled))
     and (c.ticker is null or c.is_visible or (select public.is_admin()))
   order by h.ticker, h.effective_date;
$$;
revoke all on function public.get_rating_history() from public, anon;
grant execute on function public.get_rating_history() to authenticated;

-- 4. ADMIN: listar, gravar um evento, apagar, importar várias linhas --------------
create or replace function public.admin_list_rating_history()
  returns table(id bigint, ticker text, effective_date date, rating text, target_price numeric,
                currency text, listing text, note text, source text, updated_at timestamptz)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
    select h.id, h.ticker, h.effective_date, h.rating, h.target_price, h.currency, h.listing, h.note,
           h.source, h.updated_at
      from public.stock_guide_rating_history h
     order by h.ticker, h.effective_date desc;
end $$;
revoke all on function public.admin_list_rating_history() from public, anon;
grant execute on function public.admin_list_rating_history() to authenticated;

-- regra única de validação (gravar 1 e importar N usam a mesma)
create or replace function public._rh_clean(p jsonb) returns jsonb
  language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_ticker text := upper(nullif(btrim(p->>'ticker'), ''));
  v_rating text := upper(nullif(btrim(p->>'rating'), ''));
  v_date   text := nullif(btrim(p->>'effective_date'), '');
  v_tp     text := nullif(btrim(p->>'target_price'), '');
  v_ccy    text := upper(nullif(btrim(p->>'currency'), ''));
begin
  if v_ticker is null or v_ticker !~ '^[A-Z0-9.]{1,15}$' then
    raise exception 'ticker_invalido: %', coalesce(p->>'ticker', '(vazio)') using errcode = '22023'; end if;
  if v_date is null or v_date !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'data_invalida (%): %', v_ticker, coalesce(p->>'effective_date', '(vazia)') using errcode = '22023'; end if;
  begin
    perform v_date::date;   -- 2026-02-30 → erro aqui, não uma data torta no gráfico
  exception when others then
    raise exception 'data_invalida (%): %', v_ticker, v_date using errcode = '22023';
  end;
  if v_date::date > (now() at time zone 'America/Sao_Paulo')::date then
    raise exception 'data_no_futuro (%): %', v_ticker, v_date using errcode = '22023'; end if;
  if v_rating is null or v_rating not in ('OP','MP','UP','NR') then
    raise exception 'recomendacao_invalida (% %): %', v_ticker, v_date, coalesce(p->>'rating', '(vazia)') using errcode = '22023'; end if;
  -- CASE e não OR: o OR do SQL não promete ordem, e "1,110"::numeric derrubaria com erro feio
  if v_tp is not null and (case when v_tp ~ '^\d+(\.\d+)?$' then v_tp::numeric <= 0 else true end) then
    raise exception 'preco_alvo_invalido (% %): %', v_ticker, v_date, v_tp using errcode = '22023'; end if;
  if v_ccy is not null and v_ccy !~ '^[A-Z]{3}$' then
    raise exception 'moeda_invalida (% %): %', v_ticker, v_date, v_ccy using errcode = '22023'; end if;
  return jsonb_build_object('ticker', v_ticker, 'effective_date', v_date, 'rating', v_rating,
           'target_price', v_tp, 'currency', v_ccy,
           'listing', nullif(btrim(p->>'listing'), ''), 'note', left(nullif(btrim(p->>'note'), ''), 200));
end $$;
revoke all on function public._rh_clean(jsonb) from public, anon, authenticated;

-- p_id nulo = novo evento (ou substitui o da mesma empresa+data); p_id dado = corrige aquele evento
create or replace function public.admin_save_rating_event(p_id bigint, p_data jsonb)
  returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare v jsonb; v_id bigint;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  v := public._rh_clean(p_data);
  if p_id is null then
    insert into public.stock_guide_rating_history as h
           (ticker, effective_date, rating, target_price, currency, listing, note, source, updated_by)
    values (v->>'ticker', (v->>'effective_date')::date, v->>'rating', (v->>'target_price')::numeric,
            v->>'currency', v->>'listing', v->>'note', 'manual', auth.uid())
    on conflict (ticker, effective_date) do update
       set rating = excluded.rating, target_price = excluded.target_price, currency = excluded.currency,
           listing = coalesce(excluded.listing, h.listing), note = excluded.note,
           source = 'manual', updated_at = now(), updated_by = excluded.updated_by
    returning h.id into v_id;
  else
    begin
      update public.stock_guide_rating_history
         set ticker = v->>'ticker', effective_date = (v->>'effective_date')::date, rating = v->>'rating',
             target_price = (v->>'target_price')::numeric, currency = v->>'currency',
             listing = coalesce(v->>'listing', listing), note = v->>'note',
             source = 'manual', updated_at = now(), updated_by = auth.uid()
       where id = p_id
      returning id into v_id;
    exception when unique_violation then
      raise exception 'ja_existe_evento_nessa_data (% %)', v->>'ticker', v->>'effective_date' using errcode = '23505';
    end;
    if v_id is null then raise exception 'evento_nao_encontrado: %', p_id using errcode = '22023'; end if;
  end if;
  return v_id;
end $$;
revoke all on function public.admin_save_rating_event(bigint, jsonb) from public, anon;
grant execute on function public.admin_save_rating_event(bigint, jsonb) to authenticated;

create or replace function public.admin_delete_rating_event(p_id bigint)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.stock_guide_rating_history where id = p_id;
end $$;
revoke all on function public.admin_delete_rating_event(bigint) from public, anon;
grant execute on function public.admin_delete_rating_event(bigint) to authenticated;

-- várias linhas coladas do Excel, NUMA transação: uma linha ruim = nada gravado (a mensagem diz qual)
create or replace function public.admin_import_rating_history(p_rows jsonb)
  returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare e jsonb; v jsonb; n int := 0;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'rows_must_be_array' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'linhas_demais (máx. 2000)' using errcode = '22023'; end if;
  for e in select * from jsonb_array_elements(p_rows) loop
    v := public._rh_clean(e);
    insert into public.stock_guide_rating_history as h
           (ticker, effective_date, rating, target_price, currency, listing, note, source, updated_by)
    values (v->>'ticker', (v->>'effective_date')::date, v->>'rating', (v->>'target_price')::numeric,
            v->>'currency', v->>'listing', v->>'note', 'import', auth.uid())
    on conflict (ticker, effective_date) do update
       set rating = excluded.rating, target_price = excluded.target_price,
           currency = coalesce(excluded.currency, h.currency), listing = coalesce(excluded.listing, h.listing),
           note = coalesce(excluded.note, h.note), source = 'import', updated_at = now(), updated_by = excluded.updated_by;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.admin_import_rating_history(jsonb) from public, anon;
grant execute on function public.admin_import_rating_history(jsonb) to authenticated;

-- 5. A FLAG (nasce DESLIGADA: o admin vê, o cliente só depois de você ligar) ------
insert into public.dashboard_flags (key, label, sort_order, enabled) values
  ('market_ratings', 'Market: recomendações da casa ("Since last update" + histórico OP/MP/UP no gráfico)', 26, false)
on conflict (key) do nothing;

-- 6. CONFERÊNCIA (opcional, rode depois do upload do Stock Guide):
--   select ticker, effective_date, rating, target_price, currency, source
--     from public.stock_guide_rating_history order by ticker, effective_date;
