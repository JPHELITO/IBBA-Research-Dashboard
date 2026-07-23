# -*- coding: utf-8 -*-
"""registry.py — REGISTRO ÚNICO de todas as fontes de dados da dashboard.

É a fonte da verdade (uma lista de dicts) que alimenta:
  • o resumo por e-mail (status_digest.py) — o "panorama de tudo";
  • os avisos por e-mail (notify.py) — destinatários/rótulo por fonte;
  • o watchdog (via a tabela Supabase source_registry, semeada por scripts/seed_registry.py);
  • o painel de admin (via o RPC get_source_registry).

Como adicionar/mudar uma fonte: edite SÓ este arquivo e rode
  python scripts/seed_registry.py     (espelha para o Supabase)

Campos de cada fonte:
  key          id curto e estável (ex.: "secex_steel")
  label        nome humano (aparece no e-mail/painel)
  sector       "steel" | "pulp" | "live"
  db           "steel" (steel_sm.db) | "pulp" (pulp_paper.db) | "supabase"
  table        tabela onde ler MAX(period)/frescor (None p/ feeds sem período)
  period_col   coluna de período (default "period")
  cadence      "monthly" | "live"
  how_pulled   como o dado entra (ver COMO_PUXA)
  confidence   "high" | "medium" | "brittle" | "manual"
  auto         True se hoje se atualiza sozinho; False se depende de humano
  overdue_days [monthly] idade máx. (dias) do último período antes de "atrasado"
  stale_min    [live] frescor máx. (min) do updated_at antes de "parado"
  note         observação curta
"""
from __future__ import annotations

# Destinatários padrão de todos os e-mails (mesma lista em todo o projeto hoje).
DEFAULT_RECIPIENTS = ["jphelito@gmail.com", "joao.helito@itaubba.com"]

# Onde vive cada banco versionado (caminho relativo à raiz do repo do frontend).
DB_PATHS = {
    "steel": "Steel and Mining/steel_sm.db",
    "pulp":  "Pulp and Paper/pulp_paper.db",
}

# Glossário de "como puxa" (só documentação legível).
COMO_PUXA = {
    "mdic_api":     "API do governo (MDIC/Comex Stat, CSV em massa)",
    "site_scrape":  "raspagem de site + download de Excel",
    "gov_api":      "API oficial de governo",
    "manual_excel": "planilha baixada por humano",
    "yahoo":        "Yahoo Finance (chart API)",
    "vision":       "visão de máquina lê o PDF-imagem (Gemini) + checksums",
    "pdf":          "baixa um PDF público e lê com o Gemini + checksums",
    "news":         "lê o número nas notícias já coletadas (news-hunter) + regex + checksums",
    "playwright":   "login automatizado (Playwright)",
    "bcb":          "API do Banco Central (BCB)",
    "mixed":        "várias fontes",
    "pipeline":     "pipeline de coleta (news-hunter)",
}

# ── AS FONTES ─────────────────────────────────────────────────────────────────
REGISTRY: list[dict] = [
    # ═══ STEEL & MINING (steel_sm.db) ═══
    dict(key="secex_steel", label="SECEX Aço (comércio exterior)", sector="steel",
         db="steel", table="secex_country", cadence="monthly",
         how_pulled="mdic_api", confidence="high", auto=True, overdue_days=45,
         note="MDIC Comex Stat. Deriva secex_exports/imports/sh6_* e a linha laranja."),
    dict(key="import_prediction", label="Modelo — linha laranja (import. BR←KR/CN)", sector="steel",
         db="steel", table="import_prediction", cadence="monthly",
         how_pulled="mdic_api", confidence="high", auto=True, overdue_days=45,
         note="Importações antidumping (55 SH6), mesma base do SECEX."),
    dict(key="iron_ore", label="Minério de ferro (Fines/Pellets)", sector="steel",
         db="steel", table="secex_iron_ore", cadence="monthly",
         how_pulled="mdic_api", confidence="high", auto=True, overdue_days=45,
         note="MDIC SH6 260111/260112."),
    dict(key="iabr", label="Aço Brasil / IABr (produção etc.)", sector="steel",
         db="steel", table="iabr_production", cadence="monthly",
         how_pulled="site_scrape", confidence="brittle", auto=True, overdue_days=80,
         note="Workflow PRÓPRIO update_iabr.yml (horário dias 8-28 — sai na 2ª/3ª semana, mês N-1, NÃO 1-10). "
              "Detecta por 2 sinais: link do Excel + cabeçalho 'MÊS ANO - PRODUÇÃO BRASILEIRA' (confere e avisa "
              "se descompassar). Parsing por índices fixos de linha (ainda frágil). Trava steel-sm-db c/ o SECEX."),
    dict(key="pred_korea", label="Modelo — linha preta (Coreia)", sector="steel",
         db="steel", table="pred_exports", period_col="period", cadence="monthly",
         how_pulled="gov_api", confidence="manual", auto=False, overdue_days=60,
         note="data.go.kr — DORMENTE (cron comentado, sem KOREA_SERVICE_KEY). Ligar = vitória fácil."),
    dict(key="pred_china", label="Modelo — linha preta (China)", sector="steel",
         db="steel", table="pred_exports", period_col="period", cadence="monthly",
         how_pulled="manual_excel", confidence="manual", auto=False, overdue_days=60,
         note="Excel (aba CHINA) via upload, ou Comtrade (defasado). Sem feed ao vivo limpo."),
    dict(key="inda", label="INDA (distribuição de aço plano)", sector="steel",
         db="steel", table="inda_distribution", cadence="monthly",
         how_pulled="pdf", confidence="medium", auto=True, overdue_days=80,
         note="In Data PDF (público) lido por Gemini + 2 checksums (soma dos produtos=total; giro≈estoque/vendas); "
              "preenche TODOS os meses faltantes em ordem (sales_ltm/sales_ma3 calculados). Lag ~2 meses. update_inda.py."),

    # ═══ PULP & PAPER (pulp_paper.db) ═══
    dict(key="pulp_secex", label="Celulose por porto (SECEX)", sector="pulp",
         db="pulp", table="secex_pulp_port", cadence="monthly",
         how_pulled="mdic_api", confidence="high", auto=True, overdue_days=45,
         note="MDIC Comex Stat, 17 SH6 de celulose."),
    dict(key="iba_paper", label="IBÁ — papel", sector="pulp",
         db="pulp", table="iba_paper", cadence="monthly",
         how_pulled="vision", confidence="medium", auto=True, overdue_days=80,
         note="PDF imagem lido por VISÃO (Gemini, escalona modelo) + 3 checksums; auto-publica se bater. "
              "Publica o dado ~2 meses após o mês (lag da fonte) → overdue_days folgado (80). update_iba_auto.py."),
    dict(key="empapel", label="Empapel (papelão ondulado)", sector="pulp",
         db="pulp", table="empapel", cadence="monthly",
         how_pulled="news", confidence="medium", auto=True, overdue_days=75,
         note="Número mensal (índice IBPO) extraído das NOTÍCIAS já coletadas: Fastmarkets=preliminar "
              "(~dia 15), Valor/CNN/ABTCP=oficial (~mês seguinte). Regex + checksum de %a/a; publica o "
              "preliminar e REVISA p/ o oficial. dias úteis = seg-sáb. update_empapel_news.py. "
              "O antigo update_empapel.py (Excel ABPO) fica de reserva."),
    dict(key="gacc", label="GACC — cavaco China (woodchips)", sector="pulp",
         db="pulp", table="gacc_woodchips", cadence="monthly",
         how_pulled="manual_excel", confidence="manual", auto=False, overdue_days=75,
         note="Alfândega China (portal c/ WAF+CAPTCHA → download é manual, exige humano). "
              "montar_gacc.py lê o CSV do customs e monta a base (pivô em código, validado 922/922; "
              "sem Excel, sem rebuild). watch_gacc.py avisa por e-mail quando deve ter saído mês novo."),

    # ═══ FEEDS AO VIVO (Supabase, via news-hunter) ═══
    dict(key="quotes", label="Cotações (ações/índices)", sector="live",
         db="supabase", table="quotes", cadence="live",
         how_pulled="yahoo", confidence="high", auto=True, stale_min=180,
         note="Yahoo Finance, ~5 min (hunt-loop)."),
    dict(key="commodities", label="Commodities (Platts/Yahoo/TE)", sector="live",
         db="supabase", table="commodities", cadence="live",
         how_pulled="mixed", confidence="medium", auto=True, stale_min=240,
         note="Platts (~30 min, sessão Okta frágil) + Yahoo Cu/Au + minério 62% (token TE quebradiço)."),
    dict(key="macro", label="Macro (FX + BCB)", sector="live",
         db="supabase", table="macro_indicators", cadence="live",
         how_pulled="bcb", confidence="high", auto=True, stale_min=240,
         note="Yahoo FX + US10Y + BCB (SELIC/CDI/IPCA/PIB)."),
    dict(key="news", label="Notícias (News Hunter)", sector="live",
         db="supabase", table="news_articles", cadence="live", fresh_col="found_at",
         how_pulled="pipeline", confidence="high", auto=True, stale_min=360,
         note="RSS+sitemaps+scrapers+Playwright. Auto-cura. Coluna de frescor = found_at."),
]

# ── acessores ────────────────────────────────────────────────────────────────
def _norm(s: dict) -> dict:
    s.setdefault("period_col", "period")
    s.setdefault("recipients", DEFAULT_RECIPIENTS)
    if s["cadence"] == "live":
        s.setdefault("fresh_col", "updated_at")   # quotes/commodities/macro; news usa found_at
    return s

REGISTRY = [_norm(s) for s in REGISTRY]
BY_KEY = {s["key"]: s for s in REGISTRY}


def all_sources() -> list[dict]:
    return REGISTRY


def get(key: str) -> dict | None:
    return BY_KEY.get(key)


def by_sector(sector: str) -> list[dict]:
    return [s for s in REGISTRY if s["sector"] == sector]


def manual_sources() -> list[dict]:
    """Fontes que ainda dependem de humano (auto=False) — os alvos de automação."""
    return [s for s in REGISTRY if not s.get("auto")]


def db_path(sector_or_db: str) -> str | None:
    return DB_PATHS.get(sector_or_db)


if __name__ == "__main__":
    # `python _shared/registry.py` → tabela rápida no terminal (sanidade).
    print(f"{len(REGISTRY)} fontes ({len(manual_sources())} ainda manuais)\n")
    print(f"{'key':18} {'setor':6} {'db':9} {'tabela':20} {'cad.':8} {'auto':5} conf.")
    for s in REGISTRY:
        print(f"{s['key']:18} {s['sector']:6} {s['db']:9} {str(s['table']):20} "
              f"{s['cadence']:8} {str(s['auto']):5} {s['confidence']}")
