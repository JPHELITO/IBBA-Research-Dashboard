-- =============================================================================
-- STOCK GUIDE v4 — flag GRANULAR p/ a aba Sensitivity (separada do comp table)
--
-- Idempotente. Requer dashboard_flags (admin/supabase_config_schema.sql).
--
-- Cria a flag `stock_guide_sensitivity` → no /admin (aba Funcionalidades) você liga/desliga
-- a aba **Sensitivity** do Stock Guide SEM mexer no comp table. Desligada (default), o cliente
-- ainda VÊ a aba "Sensitivity" mas ela mostra "indisponível" (não some). Admin sempre vê.
--
-- Padrão p/ MAIS granularidade: é só inserir outra flag aqui (key + label) e o /admin já a lista
-- automaticamente (get_dashboard_flags devolve todas). Cada página/sub-área respeita a sua flag.
-- =============================================================================

insert into public.dashboard_flags (key, label, sort_order, enabled) values
  ('stock_guide_sensitivity', 'Stock Guide: aba Sensitivity (comp table fica separada)', 92, false)
on conflict (key) do nothing;

-- VERIFICAÇÃO: select key, enabled from public.dashboard_flags where key like 'stock_guide%';
-- =============================================================================
