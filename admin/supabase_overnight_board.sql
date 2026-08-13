-- =============================================================================
-- QUADRO OVERNIGHT — o que se moveu enquanto o Brasil dormia
-- Rodar no SQL Editor do Supabase. Idempotente. REQUER admin/supabase_market_pulse.sql.
--
-- O QUE É, em português:
--   A foto das 07h/09h que alimenta o Market Pulse já guarda 23 mercados globais
--   (Ásia, Europa, commodities, futuros, câmbio). Esta função devolve a variação de
--   24h de cada um no último corte publicado — é a tabela que um analista lê na
--   call da manhã para responder "por que a Vale vai abrir assim?".
--
--   Nada aqui é previsão: é descrição do que já aconteceu lá fora. Por isso pode
--   ir para o cliente sem depender da validação do modelo.
--
-- POR QUE DEVOLVE UM "z" ALÉM DA VARIAÇÃO:
--   Ordenar por tamanho bruto é enganoso — o VIX oscila 8,8% num dia normal e o DXY
--   0,4%. Medido nos 499 pregões da base: ordenando por variação bruta o VIX apareceria
--   no top-6 em 84% dos dias (não é informação, é a natureza dele); ordenando pelo
--   movimento relativo ao DESVIO-PADRÃO DELE MESMO, cai para 20%. O `z` é a variação
--   do dia dividida pelo desvio-padrão histórico daquele instrumento naquele corte:
--   |z| ≈ 1 é um dia comum, |z| ≥ 2 é um dia de fato atípico.
--
-- DESFAZER: drop function if exists public.get_overnight_board();
-- =============================================================================

create or replace function public.get_overnight_board()
  returns table (
    symbol       text,
    chg_pct      numeric,
    z            numeric,
    session_date date,
    cut          text,
    captured_at  timestamptz
  )
  language sql stable security definer set search_path = public, pg_temp as $$
  with serie as (
    select s.symbol, s.cut, s.session_date, s.price, s.captured_at,
           lag(s.price) over (partition by s.symbol, s.cut order by s.session_date) as anterior
      from public.pulse_snapshot s
  ),
  variacao as (
    select symbol, cut, session_date, captured_at,
           (price / nullif(anterior, 0) - 1) * 100 as chg
      from serie
     where anterior is not null
  ),
  dispersao as (
    select symbol, cut, stddev_samp(chg) as dp
      from variacao
     group by symbol, cut
  ),
  alvo as (                         -- último pregão publicado; 09h ganha do 07h no mesmo dia
    select v.session_date, v.cut
      from variacao v
     order by v.session_date desc, case v.cut when '09' then 0 else 1 end
     limit 1
  )
  select v.symbol,
         round(v.chg, 2)                        as chg_pct,
         round(v.chg / nullif(d.dp, 0), 2)      as z,
         v.session_date,
         v.cut,
         v.captured_at
    from variacao v
    join alvo a       on a.session_date = v.session_date and a.cut = v.cut
    left join dispersao d on d.symbol = v.symbol and d.cut = v.cut
   order by abs(v.chg / nullif(d.dp, 0)) desc nulls last;
$$;

revoke all on function public.get_overnight_board() from public, anon;
grant execute on function public.get_overnight_board() to authenticated;
