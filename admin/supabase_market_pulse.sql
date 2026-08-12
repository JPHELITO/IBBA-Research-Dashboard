-- =============================================================================
-- MARKET PULSE v2 — tabelas do indicador que prevê o GAP DE ABERTURA
-- Rodar no SQL Editor do Supabase (projeto mmhkqkpjrvyxovpihnio). Idempotente.
-- REQUER: admin/supabase_admin_schema.sql (is_admin()) e supabase_config_schema.sql
--         (a flag `market_pulse` em dashboard_flags já existe — NÃO criar outra).
--
-- POR QUE ISTO EXISTE, em português:
--   O Market Pulse antigo contava takes de notícia. A auditoria mostrou que aquilo
--   media o retorno de ONTEM (correlação +0,18) e não sabia nada sobre hoje (+0,013,
--   p=0,71) — porque quase todo o material é assessment de preço, publicado DEPOIS
--   que o mercado se moveu. O indicador novo não usa notícia: ele olha o que Ásia,
--   Europa, commodities e futuros negociaram enquanto o Brasil dormia, e estima
--   quanto cada coberta deve ABRIR acima/abaixo do fechamento de ontem.
--
--   Validado em 205 pregões de holdout: IC 0,264 e 58,6% de acerto direcional.
--   Ele NÃO prevê a sessão depois da abertura (isso foi testado: IC 0,04).
--
-- AS TRÊS TABELAS, em uma frase cada:
--   pulse_snapshot → a "foto" do mundo às 07h e às 09h (preço de cada instrumento)
--   pulse_model    → os pesos que o treino semanal aprendeu, um jogo por empresa/corte
--   pulse_daily    → o resultado do dia: gap esperado, score, confiança e o "por quê"
--
-- Quem escreve: os workflows (pulse_daily.yml e pulse_train.yml) com a SERVICE KEY,
-- que ignora RLS — mesmo padrão de todos os ingestores do projeto.
-- Quem lê: a dashboard, só pela RPC get_market_pulse() (usuário logado).
--
-- DESFAZER TUDO (sem tocar em nada de notícia/clipping):
--   drop function if exists public.get_market_pulse();
--   drop table if exists public.pulse_daily, public.pulse_model, public.pulse_snapshot;
-- =============================================================================

-- ───────────── 1) SNAPSHOT: a foto do mundo antes da B3 abrir ─────────────────
-- Uma linha por (pregão, instrumento, corte). `cut` é o horário de Brasília em que a
-- foto foi tirada: '07' (preliminar) ou '09' (definitiva, uma hora antes da abertura).
-- Os dois cortes existem porque foram VALIDADOS EM SEPARADO (IC 0,273 às 07h contra
-- 0,290 às 09h) — cada um tem o seu próprio jogo de pesos em pulse_model.
create table if not exists public.pulse_snapshot (
  session_date  date        not null,
  symbol        text        not null,      -- ticker no Yahoo (ex.: 'FMG.AX', 'HG=F')
  cut           text        not null,      -- '07' | '09'
  price         numeric     not null,
  captured_at   timestamptz not null default now(),
  primary key (session_date, symbol, cut)
);
alter table public.pulse_snapshot enable row level security;

comment on table public.pulse_snapshot is
  'Preço de cada instrumento global no corte pré-abertura. A feature do modelo é a '
  'variação de 24h: price(D) / price(D-1) - 1, sempre dentro do mesmo corte.';
comment on column public.pulse_snapshot.cut is
  '''07'' = 07:00 BRT (10:00 UTC) · ''09'' = 09:00 BRT (12:00 UTC). NUNCA misturar os '
  'cortes numa mesma conta: o modelo de cada corte foi treinado com o insumo daquele corte.';

-- o scorer sempre pergunta "os dois últimos preços deste símbolo neste corte"
create index if not exists pulse_snapshot_sym_cut_date_idx
  on public.pulse_snapshot (symbol, cut, session_date desc);

-- ───────────── 2) MODELO: os pesos aprendidos pelo treino semanal ─────────────
-- Um ridge por (empresa, corte). Guardamos os pesos como JSON porque o caminho
-- diário é Python puro (sem numpy): pontuar é um produto escalar sobre 23 números.
create table if not exists public.pulse_model (
  company      text        not null,       -- ticker B3 (ex.: 'VALE3.SA')
  cut          text        not null,       -- '07' | '09'
  coefs        jsonb       not null,       -- {símbolo: beta}
  mu           jsonb       not null,       -- {símbolo: média da janela de TREINO}
  sd           jsonb       not null,       -- {símbolo: desvio-padrão do TREINO}
  sigma_pred   numeric     not null,       -- desvio-padrão das PREVISÕES (escala do score)
  conf_w       jsonb,                      -- pesos da logística de confiança
  n_train      int,                        -- pregões usados no treino
  ic_oos       numeric,                    -- IC fora da amostra (saúde do modelo)
  trained_at   timestamptz not null default now(),
  primary key (company, cut)
);
alter table public.pulse_model enable row level security;

comment on column public.pulse_model.mu is
  'Média calculada SÓ na janela de treino. Padronizar com estatística que inclua o dia '
  'previsto é look-ahead — o backtest inteiro foi construído para evitar exatamente isso.';
comment on column public.pulse_model.sigma_pred is
  'Escala do score: score = 100 x clip(previsão / (2 x sigma_pred), -1, +1). Ou seja, '
  '|score| = 100 equivale a uma previsão de 2 desvios-padrão. É o que faz "forte" ser raro.';
comment on column public.pulse_model.ic_oos is
  'Information Coefficient out-of-sample do walk-forward. Referência do holdout: '
  'AURA33 0,57 · VALE3 0,47 · CSNA3 0,37 · KLBN11 0,21 · SUZB3 e RANI3 ~0 (sem sinal).';

-- ───────────── 3) RESULTADO DO DIA ────────────────────────────────────────────
create table if not exists public.pulse_daily (
  session_date  date        not null,
  cut           text        not null,
  company       text        not null,
  status        text        not null default 'ok',   -- 'ok' | 'sem_sinal' | 'sem_dado'
  gap_expected  numeric,                             -- em % (ex.: 0.83 = +0,83%)
  score         numeric,                             -- -100 .. +100
  confidence    numeric,                             -- 0 .. 100 (prob. de acertar a direção)
  attribution   jsonb,                               -- {grupo econômico: contribuição em pp}
  snapshot_at   timestamptz,                         -- quando a foto foi tirada
  updated_at    timestamptz not null default now(),
  primary key (session_date, cut, company)
);
alter table public.pulse_daily enable row level security;

comment on column public.pulse_daily.status is
  '''ok'' = tem leitura · ''sem_sinal'' = empresa sem driver global validado (Suzano e Irani: '
  'o modelo erra MAIS que chutar zero, então não recebem número) · ''sem_dado'' = a captura '
  'daquela rodada falhou/veio incompleta. Falha fechada: melhor não publicar que publicar torto.';
comment on column public.pulse_daily.attribution is
  '{"grupos": {grupo: contribuição em pp}, "drivers": [[símbolo, contribuição], ...]}. '
  'Como o modelo é linear, a soma das contribuições é EXATAMENTE o gap esperado — não é '
  'aproximação nem importância estimada. É por isso que o ridge foi escolhido no lugar das '
  'árvores (que empatavam em acurácia e não explicam nada).';

create index if not exists pulse_daily_date_idx
  on public.pulse_daily (session_date desc, cut);

-- ───────────── 4) LEITURA PELA DASHBOARD ──────────────────────────────────────
-- Devolve a rodada mais recente que existe: pega o último pregão com resultado e,
-- dentro dele, prefere o corte das 09h (mais forte); se só houver o das 07h, usa ele.
-- Junta nome e setor de `quotes` para o front não precisar de um segundo pedido.
create or replace function public.get_market_pulse()
  returns table (
    session_date date,
    cut          text,
    company      text,
    name         text,
    sector       text,
    status       text,
    gap_expected numeric,
    score        numeric,
    confidence   numeric,
    attribution  jsonb,
    snapshot_at  timestamptz,
    ic_oos       numeric
  )
  language sql stable security definer set search_path = public, pg_temp as $$
  with alvo as (
    select d.session_date, d.cut
      from public.pulse_daily d
     order by d.session_date desc,
              case d.cut when '09' then 0 else 1 end      -- 09h ganha do 07h no mesmo dia
     limit 1
  )
  select d.session_date, d.cut, d.company,
         coalesce(q.name, d.company) as name,
         q.sector,
         d.status, d.gap_expected, d.score, d.confidence, d.attribution, d.snapshot_at,
         m.ic_oos
    from public.pulse_daily d
    join alvo a on a.session_date = d.session_date and a.cut = d.cut
    left join public.quotes q on q.ticker = d.company
    left join public.pulse_model m on m.company = d.company and m.cut = d.cut
   order by d.status, abs(coalesce(d.score, 0)) desc;
$$;
revoke all on function public.get_market_pulse() from public, anon;
grant execute on function public.get_market_pulse() to authenticated;

-- ───────────── 5) SAÚDE DO MODELO (admin) ─────────────────────────────────────
-- Usada pelo painel de admin da Fase 5. Só para quem é admin de verdade.
create or replace function public.admin_pulse_health()
  returns setof public.pulse_model
  language plpgsql stable security definer set search_path = public, pg_temp as $$
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    return query select * from public.pulse_model order by cut, ic_oos desc nulls last;
  end; $$;
revoke all on function public.admin_pulse_health() from public, anon;
grant execute on function public.admin_pulse_health() to authenticated;
