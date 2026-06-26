-- =============================================================================
-- STOCK GUIDE v4 — flags GRANULARES (sub-áreas que o admin liga/desliga p/ o cliente)
--
-- Idempotente. Requer dashboard_flags (admin/supabase_config_schema.sql).
--
-- Cada flag aparece SOZINHA no /admin → Funcionalidades (get_dashboard_flags devolve todas,
-- agrupadas por área no painel novo). Desligada (cliente), a sub-área mostra "indisponível"
-- (não some). Admin sempre vê. Mesmo padrão p/ adicionar MAIS granularidade no futuro:
-- inserir a flag aqui + checá-la na página.
-- =============================================================================

insert into public.dashboard_flags (key, label, sort_order, enabled) values
  ('stock_guide_sensitivity', 'Stock Guide — aba Sensitivity', 92, false),
  ('stock_guide_peers',       'Stock Guide — Global Peers',    93, true)
on conflict (key) do nothing;

-- VERIFICAÇÃO: select key, label, enabled from public.dashboard_flags order by sort_order;
-- =============================================================================
