-- =============================================================================
-- DATA DESK (abas de dados de Metals & Mining e Pulp & Paper) — flag de lançamento.
-- Rodar 1× no SQL Editor do Supabase.
--
-- Com a flag DESLIGADA o cliente vê as abas de dados como sempre foram; o admin já vê
-- a "mesa de leitura" nova (Overview, números do topo, palco, painel de leitura, Builder),
-- para revisar antes. Depois de rodar, liga/desliga em /admin → Funcionalidades.
-- Idempotente: rodar outra vez não muda nada (on conflict do nothing).
-- Motor: data-desk.js · estilo: data-desk.css · plano: IBBA-Dashboard/data-desk/PLANO.md
-- Desvios só para conferência (admin ou prévia local): ?desk=0 força a tela antiga, ?desk=1 a mesa.
-- =============================================================================
insert into public.dashboard_flags (key, label, sort_order, enabled) values
  ('data_desk', 'Data Desk (abas de dados M&M / P&P)', 110, false)
on conflict (key) do nothing;
