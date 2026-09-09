-- =============================================================================
-- RÉGUA DO TERMÔMETRO DE NOTÍCIAS — o agregado diário do Market Pulse
-- Rodar no SQL Editor do Supabase. Idempotente. Não depende de nenhum outro SQL.
--
-- O QUE É, em português:
--   Uma linha por (pregão, setor, corte) com a MESMA conta que o card da home faz ao vivo
--   sobre as manchetes: quantas positivas, negativas, neutras, sem take, pendentes; o
--   ponteiro (ou nulo, quando havia menos de 20 pontuadas); a contagem por empresa coberta;
--   e a IMPRESSÃO DIGITAL do instrumento — quantas manchetes vieram de cada fonte e quantos
--   takes de cada modelo de IA naquele dia.
--
-- POR QUE EXISTE (2026-09-09):
--   O ponteiro mudou de nível com o próprio robô (mediana mensal 39 → 45 → 51 → 54 conforme
--   entraram fontes e a cadeia de IAs foi reordenada). Calibrar por história — "hoje está
--   no percentil X dos últimos 60 pregões" — só é honesto quando se sabe em que dias o
--   instrumento mudou. É isso que `sources` e `models` registram, dia a dia. Quem escreve é o
--   news-hunter (hunter/news_pulse.py, dentro do pulse_daily.yml); a home só lê, e só quando
--   houver ~3 meses de instrumento estável para comparar.
--
-- JANELAS:
--   cut 'close' = 17:00 BRT do dia útil anterior → 17:00 de D (uma sessão = tudo entre dois
--   fechamentos; segunda começa na sexta). cut '07' e '09' = o mesmo início → 07:00 / 09:00
--   de D, que é o que o card mostra de manhã.
--
-- DESFAZER: drop function if exists public.get_news_pulse_daily(int, text, text);
--           drop table if exists public.news_pulse_daily;
-- =============================================================================

create table if not exists public.news_pulse_daily (
  session_date  date        not null,   -- o pregão D (dia útil; feriado entra como dia magro)
  sector        text        not null,   -- 'all' | 'sm' (steel+mining) | 'pp'
  cut           text        not null,   -- '07' | '09' | 'close'
  window_start  timestamptz not null,   -- 17:00 BRT do dia útil anterior
  window_end    timestamptz not null,   -- o corte
  n_items       int         not null,   -- tudo que entrou (include_in_report)
  pos           int         not null,
  neg           int         not null,
  neu           int         not null,
  notake        int         not null,   -- 'no take' / 'review': presença sem leitura de mercado
  pending       int         not null,   -- ainda sem IA quando a linha foi calculada
  scored        int         not null,   -- pos + neg + neu
  gauge         int,                    -- 50 + (pos−neg)/scored×50; nulo se scored < 20
  covered       jsonb       not null default '{}'::jsonb,   -- {"VALE":{"n":3,"pos":1,...}, ...}
  sources       jsonb       not null default '{}'::jsonb,   -- {"S&P Platts": 41, "Valor": 12, ...}
  models        jsonb       not null default '{}'::jsonb,   -- {"gemini-2.5-flash-lite": 98, ...}
  formula       int         not null default 1,             -- versão da conta (portão 20, neutro ancora)
  computed_at   timestamptz not null default now(),
  primary key (session_date, sector, cut)
);

-- Só o robô (service_role) escreve; ninguém lê a tabela direto — a leitura é pela RPC abaixo.
alter table public.news_pulse_daily enable row level security;
revoke all on table public.news_pulse_daily from anon, authenticated;

-- Leitura para usuário logado. São contagens, nada pago — mas passa pela RPC para o front
-- nunca depender de policy na tabela (mesmo molde do Stock Guide / Market Watch).
create or replace function public.get_news_pulse_daily(
    p_days   int  default 90,
    p_sector text default 'all',
    p_cut    text default 'close')
  returns setof public.news_pulse_daily
  language sql stable security definer set search_path = public, pg_temp as $$
  select *
    from public.news_pulse_daily
   where sector = p_sector
     and cut = p_cut
     and session_date >= current_date - p_days
   order by session_date;
$$;

revoke all on function public.get_news_pulse_daily(int, text, text) from public, anon;
grant execute on function public.get_news_pulse_daily(int, text, text) to authenticated;
