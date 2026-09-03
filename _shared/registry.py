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
# 2026-08-03 (pedido do usuário): SÓ o e-mail do Itaú — tirado o jphelito@gmail.com.
DEFAULT_RECIPIENTS = ["joao.helito@itaubba.com"]

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
    "inbox":        "humano baixa o arquivo e arrasta no _inbox/customs/ — a nuvem processa",
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
         how_pulled="site_scrape", confidence="medium", auto=True, overdue_days=80,
         note="Workflow PRÓPRIO update_iabr.yml (horário dias 8-28 — sai na 2ª/3ª semana, mês N-1, NÃO 1-10). "
              "Detecta por 2 sinais: link do Excel + cabeçalho 'MÊS ANO - PRODUÇÃO BRASILEIRA' (confere e avisa "
              "se descompassar). Parsing acha as linhas por RÓTULO ancorado por seção (resolve_rows) → tolera "
              "reordenação/inserção; cai no índice fixo se não achar o âncora. Trava steel-sm-db c/ o SECEX."),
    dict(key="pred_korea", label="Modelo — linha preta (Coreia)", sector="steel",
         db="steel", table="pred_exports", period_col="period", cadence="monthly",
         how_pulled="inbox", confidence="medium", auto=False, overdue_days=60,
         note="INBOX: baixe o xlsx da KITA e arraste em _inbox/customs/ com 'steelcoreia' no nome — "
              "process_customs.yml lê e publica sozinho. (update_korea.py/data.go.kr fica dormente, exigia CPF coreano.)"),
    dict(key="pred_china", label="Modelo — linha preta (China)", sector="steel",
         db="steel", table="pred_exports", period_col="period", cadence="monthly",
         how_pulled="inbox", confidence="medium", auto=False, overdue_days=60,
         note="INBOX: baixe o CSV do customs da China (HS 72, destino Brazil) e arraste em _inbox/customs/ "
              "com 'steelchina' no nome — process_customs.yml lê e publica sozinho."),
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
         how_pulled="inbox", confidence="medium", auto=False, overdue_days=75,
         note="INBOX: o portal do customs tem CAPTCHA (download exige humano). Baixe o CSV e arraste em "
              "_inbox/customs/ com 'woodchip' no nome — process_customs.yml pivota e publica sozinho "
              "(validado 922/922). watch_gacc.py avisa por e-mail quando deve ter saído mês novo."),

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
    dict(key="market_watch", label="Market Watch (aluguel B3 · recompras/insiders/float CVM · comunicados)", sector="live",
         db="supabase", table="mw_short_interest", cadence="live", fresh_col="updated_at",
         how_pulled="mixed", confidence="medium", auto=True, stale_min=2880,
         note="_shared/market_watch.py + update_market_watch.yml. Aluguel: API do BDI (últimos 21 dias úteis) "
              "+ PDF diário do capítulo p/ histórico (desde dez/2025). CVM dados abertos: recompra (diário), "
              "VLMO insiders (a CVM reatualiza semanalmente), FRE free float. Comunicados: Plantão de Notícias "
              "da B3 (tempo real) com link do documento na CVM. Tudo público, sem login."),
    dict(key="b3_calendar", label="Cronograma de earnings (B3)", sector="live",
         db="supabase", table="exec_calendar_events", cadence="live",
         fresh_col="updated_at", how_pulled="site_scrape", confidence="medium",
         auto=True, stale_min=64800,
         # 45 dias: o updated_at só muda quando a B3 muda uma DATA (~mensal); o robô checa todo
         # dia. Com 3 dias (valor antigo) a fonte aparecia PARADA na página Data sem estar.
         note="Datas previstas de entrega de ITR/DFP das 7 empresas B3 da cobertura. "
              "A B3 não declara frequência; observado ~mensal (dia ~5). O robô checa "
              "1×/dia e nunca sobrescreve evento cadastrado à mão. CSN e Aura não "
              "estão na fonte (segmento tradicional / BDR) e seguem manuais."),
]

# ── texto p/ o CLIENTE (página "Data" da dashboard — inglês, sem jargão interno) ────────
# key → (label, o que é / de onde vem, cadência esperada). O robô status_digest.py --publish
# leva isto junto com o estado (verde/amarelo/vermelho) p/ a tabela data_source_status.
CLIENT_INFO = {
    "secex_steel":       ("Brazil steel foreign trade (SECEX)",
                          "Monthly imports and exports of steel products by country and product, from the Ministry of Development's Comex Stat database.",
                          "Monthly · published in the first ~10 days of the month for the previous month"),
    "import_prediction": ("Import model — orange line",
                          "Our model of Brazilian imports of the 55 anti-dumping steel products from Korea and China, built on the same SECEX base.",
                          "Monthly · together with SECEX"),
    "iron_ore":          ("Iron ore exports (SECEX)",
                          "Brazilian iron ore fines and pellet exports by destination, from Comex Stat.",
                          "Monthly · first ~10 days of the month"),
    "iabr":              ("Brazil steel output & sales (Aço Brasil / IABr)",
                          "Crude steel production, domestic sales, apparent consumption and import penetration published by the Brazil Steel Institute.",
                          "Monthly · 2nd–3rd week, for the previous month; retroactive revisions are incorporated"),
    "pred_korea":        ("Korea customs — steel shipped to Brazil (black line)",
                          "Korean export declarations of steel to Brazil (KITA) — the 'black line' that anticipates SECEX imports.",
                          "Monthly · after month-end, entered by the team"),
    "pred_china":        ("China customs — steel shipped to Brazil (black line)",
                          "Chinese export declarations of steel (HS 72) to Brazil from the General Administration of Customs.",
                          "Monthly · ~20th of the following month, entered by the team"),
    "inda":              ("Flat steel distributors (INDA)",
                          "Distributor purchases, sales and inventories of flat steel, from the In Data report of the distributors' association.",
                          "Monthly · mid-month, ~2 months after the reference month"),
    "pulp_secex":        ("Brazil pulp exports by port (SECEX)",
                          "Monthly pulp export volume and revenue by port of shipment, from Comex Stat (17 tariff lines).",
                          "Monthly · first ~12 days of the month"),
    "iba_paper":         ("Brazil paper statistics (IBÁ)",
                          "Paper production, sales, imports, exports and apparent consumption from the Brazilian Tree Industry monthly report.",
                          "Monthly · ~2 months after the reference month"),
    "empapel":           ("Corrugated board shipments (Empapel)",
                          "Corrugated packaging shipments (IBPO index) — the preliminary figure comes ~mid-month and is revised to the official number.",
                          "Monthly · preliminary ~15th, official the following month"),
    "gacc":              ("China woodchip imports (GACC)",
                          "Chinese customs imports of hardwood and softwood woodchips by origin — a read on pulp fibre demand.",
                          "Monthly · ~20th of the following month"),
    "quotes":            ("Share prices",
                          "Prices of the covered companies, peers and indices (B3, NYSE, Santiago, Mexico) from Yahoo Finance.",
                          "Continuous · ~5 minutes during trading hours"),
    "commodities":       ("Commodity prices",
                          "Iron ore, steel, coal, pulp, copper, gold, oil and aluminium — S&P Platts, Fastmarkets, SGX/LME (via Sina) and Yahoo Finance.",
                          "Continuous · Platts/Yahoo intraday; Fastmarkets pulp weekly"),
    "macro":             ("Macro & FX",
                          "Exchange rates and US yields (Yahoo Finance) plus Selic, CDI, IPCA and GDP from the Central Bank of Brazil.",
                          "Continuous · a few times a day"),
    "news":              ("News Hunter",
                          "Headlines from the Brazilian and international press, sector publications, Platts and Fastmarkets, classified by our AI take.",
                          "Continuous · every ~5 minutes"),
    "b3_calendar":       ("Earnings calendar (B3)",
                          "Expected filing dates of quarterly and annual results from B3's corporate events schedule.",
                          "Daily check · B3 updates roughly monthly"),
    "market_watch":      ("Market Watch (B3 & CVM)",
                          "Securities lending (short interest), buyback programs, insider trading and official filings of the covered companies.",
                          "Lending & filings every 30 min on business days; CVM datasets daily"),
}


# ── acessores ────────────────────────────────────────────────────────────────
def _norm(s: dict) -> dict:
    s.setdefault("period_col", "period")
    s.setdefault("recipients", DEFAULT_RECIPIENTS)
    if s["cadence"] == "live":
        s.setdefault("fresh_col", "updated_at")   # quotes/commodities/macro; news usa found_at
    ci = CLIENT_INFO.get(s["key"])
    if ci:
        s.setdefault("client_label", ci[0])
        s.setdefault("client_desc", ci[1])
        s.setdefault("client_cadence", ci[2])
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
