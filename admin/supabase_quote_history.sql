-- =============================================================================
-- QUOTE HISTORY — o histórico DIÁRIO completo de cada papel da aba Market
-- Rodar no SQL Editor do Supabase (projeto mmhkqkpjrvyxovpihnio). Idempotente.
--
-- POR QUE ISTO EXISTE, em português:
--   A aba Market só tinha detalhe DIÁRIO de ~1 ano. Antes disso a linha virava
--   mensal — e não por escolha nossa: o Yahoo IGNORA o `interval=1d` quando a
--   janela pedida é `range=max` e devolve barras mensais (VALE3 = 320 pontos em
--   26 anos). O jeito de obter diário de verdade é pedir por `period1`/`period2`,
--   que devolve 6.681 pontos para a mesma VALE3, desde 2000-01-03.
--
--   Só que esse histórico é PESADO: ~133 KB por papel. Se ele morasse em
--   `quotes.daily`, toda visita à home E à Market baixaria os 47 papéis de uma
--   vez — 1,96 MB por visita contra os 0,18 MB de hoje (11×). É exatamente a
--   armadilha do steel_sm.db de 47 MB, que o navegador se recusa a cachear.
--
--   Por isso o histórico longo mora AQUI, numa tabela à parte, e a dashboard lê
--   dele SÓ os papéis que estão no gráfico (no modo Ratio são dois). A home, o
--   heatmap e a watchlist continuam lendo `quotes.daily` e não mudam de peso.
--
-- QUEM ESCREVE (sempre com a SERVICE KEY, que ignora RLS — padrão dos ingestores):
--   • scripts/backfill_quote_history.py  → uma vez, puxa a série inteira de cada papel
--   • hunter/prices.py::update_quote_history → todo dia, faz APPEND do fechamento novo
-- QUEM LÊ: a dashboard (market.html), com o token do usuário logado.
--
-- ⚠️ HISTÓRICO NÃO É IMUTÁVEL: quando uma empresa faz DESDOBRAMENTO (split), o
--    Yahoo reescreve a série inteira para trás (medido: o fechamento da NVDA em
--    01/03/2024 aparece hoje como 82,28; na época foi ~822). Por isso a coluna
--    `last_split_ts`: a manutenção diária lê `events.splits` na mesma chamada
--    barata do dia e, se detectar um split novo naquele papel, re-puxa a série
--    inteira DELE. Sem isso o gráfico ganharia um degrau falso, silencioso.
--
-- DESFAZER TUDO (não toca em nada de cotação, notícia ou clipping):
--   drop table if exists public.quote_history;
-- =============================================================================

create table if not exists public.quote_history (
  ticker         text        primary key,   -- mesmo ticker de public.quotes (ex.: 'VALE3.SA')
  daily          jsonb       not null,      -- [[epoch_utc, close], ...] em ordem crescente
  points         int         not null default 0,
  first_ts       bigint,                    -- epoch do 1º fechamento da série
  last_ts        bigint,                    -- epoch do último (o append compara com isto)
  last_split_ts  bigint,                    -- epoch do split mais recente já incorporado
  source         text        not null default 'yahoo',
  updated_at     timestamptz not null default now()
);

alter table public.quote_history enable row level security;

-- A dashboard lê direto (restGet manda o access_token do usuário logado). Sem esta
-- policy o cliente receberia 0 linhas — o mesmo comportamento de leitura anônima.
drop policy if exists "quote_history read for logged users" on public.quote_history;
create policy "quote_history read for logged users"
  on public.quote_history for select
  to authenticated
  using (true);

comment on table public.quote_history is
  'Histórico diário COMPLETO por papel, carregado sob demanda pela aba Market. Não '
  'misturar com quotes.daily, que é a série leve (mensal + 1 ano diário) baixada de '
  'uma vez para os 47 papéis pela home e pela watchlist.';
comment on column public.quote_history.daily is
  'Fechamentos [[epoch, close]] em ordem crescente. É o `close` do Yahoo: ajustado por '
  'desdobramento, NÃO por dividendo — a mesma régua de quotes.daily, para as duas '
  'séries poderem ser costuradas sem degrau.';
comment on column public.quote_history.last_split_ts is
  'Epoch do último split já refletido na série. A manutenção diária compara com o que '
  'o Yahoo reporta em events.splits; se vier um mais novo, a série inteira do papel é '
  're-puxada, porque o split reescreve o histórico retroativamente.';

-- ───────────── APPEND do dia, feito DENTRO do Postgres ──────────────────────
-- Por que uma função e não "baixa, junta em Python, sobe de volta": a série tem
-- ~133 KB. Baixar e devolver todo dia, para os 47 papéis, seriam ~12 MB/dia de
-- vaivém — puxando histórico que já aconteceu, exatamente o que este desenho
-- quer evitar. Assim o robô manda só os fechamentos NOVOS (~1 KB) e o banco costura.
--
-- Regra da costura: um ponto por DIA, e o ponto NOVO vence o antigo do mesmo dia
-- (o fechamento de hoje ainda em formação é substituído pelo definitivo amanhã).
-- Compara por DIA, não por epoch: o epoch do Yahoo carrega o horário de abertura
-- do pregão, que muda com horário de verão — por epoch cru o mesmo dia entraria 2×.
-- A função mantém as DUAS séries no mesmo passo: a longa (quote_history.daily) e a
-- leve (quotes.daily), que é uma REDUÇÃO da longa — mensal até 1 ano atrás, diário no
-- último ano. Derivar uma da outra tem um efeito que vale registrar: as duas nunca
-- divergem, então a linha do gráfico não tem emenda ao passar do trecho leve para o
-- longo. (É a mesma lição do clipping: duas saídas do mesmo conteúdo não se montam em
-- paralelo — deriva-se uma da outra.)
create or replace function public.append_quote_history(
  p_ticker         text,
  p_points         jsonb,
  p_last_split_ts  bigint  default null,
  p_replace        boolean default false   -- true = ignora o guardado (backfill / pós-split)
) returns table (n_points int, ts_first bigint, ts_last bigint, n_light int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_daily jsonb;
  v_light jsonb;
  v_len   int;
  v_cut   bigint := extract(epoch from now())::bigint - 372 * 86400;   -- = o range '1Y' do front
begin
  with base as (
    select elem, 0 as prio, ((elem->>0)::bigint / 86400) as d
      from public.quote_history qh, lateral jsonb_array_elements(qh.daily) elem
     where qh.ticker = p_ticker and not p_replace
    union all
    select elem, 1 as prio, ((elem->>0)::bigint / 86400) as d
      from jsonb_array_elements(coalesce(p_points, '[]'::jsonb)) elem
  ), pick as (
    select distinct on (d) elem, d from base order by d, prio desc
  )
  select coalesce(jsonb_agg(elem order by d), '[]'::jsonb) into v_daily from pick;

  v_len := jsonb_array_length(v_daily);
  if v_len < 1 then
    return;                                   -- nada guardado e nada novo: não cria linha vazia
  end if;

  insert into public.quote_history as q
        (ticker,   daily,   points, first_ts,                  last_ts,                          last_split_ts,   source,  updated_at)
  values (p_ticker, v_daily, v_len,  (v_daily->0->>0)::bigint,  (v_daily->(v_len-1)->>0)::bigint, p_last_split_ts, 'yahoo', now())
  on conflict (ticker) do update
     set daily         = excluded.daily,
         points        = excluded.points,
         first_ts      = excluded.first_ts,
         last_ts       = excluded.last_ts,
         -- nunca ANDA PARA TRÁS: um split já incorporado continua registrado
         last_split_ts = greatest(coalesce(excluded.last_split_ts, 0), coalesce(q.last_split_ts, 0)),
         updated_at    = now();

  -- SÉRIE LEVE derivada: último pregão de cada mês (antes do corte) + diário do último ano
  with pts as (
    select ((elem->>0)::bigint) as ts, elem from jsonb_array_elements(v_daily) elem
  ), tag as (
    select ts, elem, (ts >= v_cut) as recente,
           to_char(to_timestamp(ts) at time zone 'UTC', 'YYYY-MM') as ym
      from pts
  ), mensal as (
    select distinct on (ym) ts, elem from tag where not recente order by ym, ts desc
  )
  select coalesce(jsonb_agg(elem order by ts), '[]'::jsonb) into v_light
    from (select ts, elem from mensal union all select ts, elem from tag where recente) s;

  -- quotes já tem a linha (update_quotes roda antes); UPDATE não conflita com o NOT NULL
  -- de name/price, que um upsert parcial violaria (23502) — a mesma razão do PATCH antigo.
  update public.quotes
     set daily = v_light, daily_updated_at = now()
   where ticker = p_ticker;

  return query
    select qh.points, qh.first_ts, qh.last_ts, jsonb_array_length(v_light)
      from public.quote_history qh where qh.ticker = p_ticker;
end $$;

-- Só o ingestor (service key) escreve. O cliente logado só faz SELECT na tabela.
revoke all on function public.append_quote_history(text, jsonb, bigint, boolean) from public, anon, authenticated;
grant execute on function public.append_quote_history(text, jsonb, bigint, boolean) to service_role;

comment on function public.append_quote_history(text, jsonb, bigint, boolean) is
  'Costura os fechamentos novos na série longa (1 ponto por dia, o novo vencendo) e '
  'regrava a série LEVE de quotes.daily como redução dela. O robô manda ~1 KB por dia '
  'em vez de baixar e devolver os 133 KB da série inteira.';

-- ───────────────────────── conferência pós-execução ─────────────────────────
-- Depois de rodar o backfill, isto mostra o que entrou:
--   select ticker, points, to_timestamp(first_ts)::date as desde,
--          to_timestamp(last_ts)::date as ate, updated_at
--     from public.quote_history order by points desc;
