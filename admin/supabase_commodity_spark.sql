-- =============================================================================
-- RISQUINHO DAS COMMODITIES — histórico privado + forma pública
-- Rodar UMA vez no SQL Editor do Supabase (projeto mmhkqkpjrvyxovpihnio). Idempotente.
--
-- POR QUE UMA TABELA SEPARADA
-- O carrossel da home mostra um gráfico por assessment. O desenho vem da coluna
-- `commodities.spark`, que é só a FORMA da curva (inteiros 0..1000, sem escala e sem
-- datas) — essa pode ir para o navegador.
-- O HISTÓRICO EM NÚMEROS não pode: é assessment Platts, e o cliente não tem direito a
-- ele. Guardar em `commodities` não serve, porque a aba Market faz `select=*` nessa
-- tabela — o histórico iria junto para o navegador. Por isso ele mora aqui, numa tabela
-- com RLS ligado e SEM POLICY: nem `anon` nem `authenticated` enxergam uma linha.
-- Só o `service_role` (o robô do news-hunter, que ignora RLS) lê e escreve.
--
-- QUEM PREENCHE
--   1) `seed_platts_history.py` (local, na máquina do analista) — tira a "fotografia":
--      lê a planilha PLATTS - Price Database.xlsm e semeia esta tabela + o `spark`.
--   2) `hunter/prices.py` → update_commodity_spark() (no hunt-loop, ~1×/dia) — daí em
--      diante acrescenta o assessment de cada dia e recalcula a forma sozinho.
-- =============================================================================

create table if not exists public.commodity_history (
  code        text primary key,
  -- [[epoch_utc, valor], ...] em ordem crescente de data. Guarda uma JANELA de ~2 anos
  -- (SPARK_KEEP em prices.py), não a série inteira: é só o que o desenho precisa, e o
  -- robô lê esta tabela todo dia — série cheia viraria egress à toa.
  series      jsonb       not null default '[]'::jsonb,
  source      text,       -- 'platts_xlsm' (fotografia) | 'daily' (semeado do accrual)
  updated_at  timestamptz not null default now()
);

comment on table public.commodity_history is
  'Histórico em NÚMEROS das commodities (Platts). Privado: RLS sem policy, só service_role. '
  'O que o cliente vê é a forma normalizada em commodities.spark.';

alter table public.commodity_history enable row level security;

-- Cinto e suspensório: RLS já barraria a leitura, mas sem GRANT a tabela nem aparece
-- para o PostgREST com o token do cliente.
revoke all on public.commodity_history from anon, authenticated;

-- A forma pública já existe em `commodities` desde o schema original; garante aqui para
-- quem for aplicar este arquivo num projeto novo.
alter table public.commodities add column if not exists spark jsonb;
