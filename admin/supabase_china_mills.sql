-- ════════════════════════════════════════════════════════════════════════════
-- USINAS CHINESAS — pesquisa semanal da Mysteel com 247 usinas (M&M › Steel › China mills, na mesa de dados)
-- ────────────────────────────────────────────────────────────────────────────
-- Uma linha por semana (a sexta-feira), com os quatro números do boletim "钢厂高炉检修调查统计":
--   profitable_pct ..... % das usinas com lucro caixa no produto principal (sem ponderar pela produção)
--   bf_util_pct ........ % da capacidade de gusa dos altos-fornos em uso
--   bf_operating_pct ... % dos altos-fornos ligados
--   hot_metal_kt ....... produção de gusa, mil toneladas por dia
-- Semana sem leitura (Ano Novo Chinês) fica gravada como furo: sem número, source_kind = 'none'.
--
-- Mysteel é agência paga: a tabela NÃO tem leitura direta para ninguém (RLS sem policy). A página lê pela função
-- get_china_mills(), que só responde ao ADMIN ou, quando a chave `china_mills` estiver ligada, a qualquer usuário logado.
-- Nada disto vai para o repositório do site (ele é público). Histórico carregado da planilha do analista; o robô
-- _shared/update_china_mills.py acrescenta o boletim de cada sexta.
--
-- Rodar UMA vez no editor SQL do Supabase. Pode rodar de novo sem estragar nada (idempotente).
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.china_mills (
  week             date        primary key,                 -- a sexta-feira da semana
  obs_date         date,                                    -- a data original do boletim (às vezes quarta ou quinta, em feriado); null = sem leitura
  profitable_pct   numeric,
  bf_operating_pct numeric,
  bf_util_pct      numeric,
  hot_metal_kt     numeric,
  source_kind      text        not null default 'mysteel' check (source_kind in ('mysteel', 'secondary', 'none')),
  source_url       text,
  note             text,
  source           text        not null default 'robot',   -- spreadsheet | robot | manual
  updated_at       timestamptz not null default now()
);

alter table public.china_mills enable row level security;
-- sem policy nenhuma: leitura só pela função abaixo; escrita só pela chave de serviço (robô e carga da planilha).

-- A chave que abre a aba para os clientes (nasce DESLIGADA: só o admin vê).
insert into public.dashboard_flags (key, label, sort_order, enabled)
values ('china_mills', 'Steel: China mills (Mysteel)', 115, false)
on conflict (key) do nothing;

-- A série inteira numa resposta só, compacta:
--   [[semana, data do boletim, % com lucro, % altos-fornos ligados, % utilização, gusa kt/dia, tipo de fonte], …]
create or replace function public.get_china_mills()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'login required' using errcode = '42501';
  end if;
  if not (public.is_admin() or exists (select 1 from public.dashboard_flags where key = 'china_mills' and enabled)) then
    raise exception 'not available' using errcode = '42501';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_array(week, obs_date, profitable_pct, bf_operating_pct, bf_util_pct, hot_metal_kt, source_kind) order by week), '[]'::jsonb)
    from public.china_mills
  );
end;
$$;

revoke all on function public.get_china_mills() from public, anon;
grant execute on function public.get_china_mills() to authenticated, service_role;
