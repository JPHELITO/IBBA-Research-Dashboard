-- ─────────────────────────────────────────────────────────────────────────
-- commodities.daily — série histórica diária p/ o SPREAD ação×commodity (aba Market)
-- Rodar UMA vez no Supabase (SQL Editor). Idempotente.
--
-- Quem preenche: hunter/prices.py → update_commodity_history() (no hunt-loop, ~1×/dia):
--   • COPPER/GOLD  → histórico completo do Yahoo (consistente com o preço ao vivo, também Yahoo)
--   • Platts (iron ore 62%/HRC China/rebar/met coal) → ACUMULA pra frente (append do assessment
--     do dia, dedup por data; o Platts não tem API de histórico). A série cresce a partir do deploy.
-- O front (market.html, modo "Spread vs Index") usa commodities.daily do driver do setor quando
-- houver histórico (≥5 pontos); senão cai no índice. Ex.: VALE − minério 62%.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.commodities add column if not exists daily jsonb;
alter table public.commodities add column if not exists daily_updated_at timestamptz;
