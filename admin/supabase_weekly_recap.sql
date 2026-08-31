-- =============================================================================
-- WEEKLY RECAP — a única coisa que a página /weekly.html não consegue ler sozinha
-- Rodar UMA vez no SQL Editor do Supabase (projeto mmhkqkpjrvyxovpihnio). Idempotente.
--
-- POR QUE ISTO EXISTE, em português
-- O weekly compara DOIS fechamentos de cada commodity: o da sexta passada e o
-- desta. A variação da semana a dashboard já publica (`commodities.spark`, chave
-- "w"), mas ela é só o PERCENTUAL — o e-mail manda os dois preços em números.
--
-- Esses números moram em `commodity_history`, que é PRIVADA de propósito: é
-- assessment pago do Platts e da Fastmarkets, e o cliente da dashboard não tem
-- direito a ele. A tabela tem RLS ligado e NENHUMA policy — nem `anon` nem
-- `authenticated` enxergam uma linha (ver admin/supabase_commodity_spark.sql).
--
-- Então em vez de abrir a tabela, abre-se UMA JANELA: esta função devolve só os
-- pontos do intervalo pedido, e só para quem é admin. Um weekly pede ~10 dias de
-- 5 séries — o histórico de 2 anos continua fora do alcance do navegador.
--
-- DESFAZER (não toca em dado nenhum):
--   drop function if exists public.admin_commodity_window(text[], date, date);
-- =============================================================================

create or replace function public.admin_commodity_window(
  p_codes text[],
  p_from  date,
  p_to    date
) returns table (code text, points jsonb)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
begin
  -- Mesma trava dos outros RPCs de admin: quem não é admin leva 'forbidden' em vez
  -- de receber zero linhas em silêncio (erro mudo vira "sumiu o preço" na tela).
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
    select h.code,
           coalesce(jsonb_agg(p order by (p ->> 0)::bigint), '[]'::jsonb)
      from public.commodity_history h
      cross join lateral jsonb_array_elements(h.series) p
     where h.code = any (p_codes)
       -- `series` é [[epoch_utc, valor], ...]; o filtro é por DIA, em UTC, que é o
       -- fuso em que o robô carimba o assessment.
       and jsonb_typeof(p) = 'array'
       and (p ->> 0) ~ '^[0-9]+$'
       and to_timestamp((p ->> 0)::bigint) at time zone 'UTC' >= p_from::timestamp
       and to_timestamp((p ->> 0)::bigint) at time zone 'UTC' <  (p_to + 1)::timestamp
     group by h.code;
end;
$$;

revoke all on function public.admin_commodity_window(text[], date, date) from public, anon;
grant execute on function public.admin_commodity_window(text[], date, date) to authenticated;

comment on function public.admin_commodity_window(text[], date, date) is
  'Janela de preços em NÚMEROS das commodities privadas (Platts/Fastmarkets), para o '
  'Weekly Recap montar a tabela de fechamentos. Admin-only; devolve só o intervalo pedido.';

-- =============================================================================
-- O QUE ESTE ARQUIVO **NÃO** PRECISA CRIAR
--
-- • Tabela de rascunho do weekly — o estado da página (intro, os 3 bullets, os
--   textos das notícias, a assinatura) é gravado dentro de
--   `clipping_config.settings`, na chave "weekly", pelos RPCs que já existem:
--   admin_get_clipping_config() / admin_save_clipping_config(jsonb).
--
-- • Lista de relatórios — é a MESMA `recent_publications` que o Clipping já
--   mantém, no mesmo `clipping_config.settings`. Decisão do analista em
--   31/08/2026: um lugar só para cadastrar publicação.
--
-- • Cotações — `quotes` (o `daily` leve, mensal + 1 ano diário) já é legível por
--   usuário logado. As ações do weekly saem de lá, sem RPC.
-- =============================================================================
