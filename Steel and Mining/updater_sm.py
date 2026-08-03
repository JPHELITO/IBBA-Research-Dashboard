#!/usr/bin/env python3
"""
updater_sm.py — Steel & Mining SECEX Auto-Updater
==================================================
Modos:
  --update      Baixa os CSVs bulk do MDIC e aplica novos meses ao DB
  --backfill    Reprocessa TODOS os anos históricos com a nova classificação NCM
  --check       Apenas verifica o último mês disponível no MDIC

Classificação NCM baseada no DICIONÁRIO NCM (272 códigos):
  Semi:  Ingot/Billet (9), Placa (3)
  Flat:  HRC (25), CRC (14), Coated (30), Heavy Plate (3), Others (75)
  Long:  Wire Rod (9), Rebar (2), Bar (23), Shapes (20), Others (59)

Tabela principal: secex_country (todas as subcategorias por país)
Derivadas:        secex_exports, secex_imports (volume+YoY por categoria)
Removido:         secex_port (não mais utilizado)

Dependências:
  pip install pandas openpyxl requests
"""

import sqlite3, sys, os, io, ssl, smtplib, argparse, warnings
from pathlib import Path
from datetime import datetime
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

try:
    import pandas as pd
    import requests
except ImportError:
    sys.exit("Faltando dependências: pip install pandas requests")

warnings.filterwarnings("ignore")  # ignora avisos SSL

# ── Caminhos ───────────────────────────────────────────────────────────────────
HERE    = Path(__file__).parent
DB_PATH = Path(os.environ.get("SECEX_DB") or (HERE / "steel_sm.db"))  # SECEX_DB p/ testar em cópia

# ── Dicionário de códigos (FONTE ÚNICA) ──────────────────────────────────────────
# A classificação NCM/SH6 (aço/celulose/minério) + a flag Antidumping vêm do
# dicionário _shared/dictionary_codes.csv (gerado por build_dictionary.py a partir
# de Standard_NCM_SH6_clmd.xlsx). Antes eram sets chumbados neste arquivo.
sys.path.insert(0, str(HERE.parent / "_shared"))
import dictionary as _dict
from ports import norm_port

# Conjunto de SH6 de aço (do dicionário) p/ as quebras SH6×País e SH6×URF.
STEEL_SH6 = _dict.sh6_set("steel")
# As quebras finas (SH6×País / SH6×URF) usam uma JANELA ROLANTE de ~6 anos p/ caber no
# limite do navegador (sql.js); períodos mais antigos são podados a cada --update.
RECENT_FROM = f"{datetime.utcnow().year - 6}-01"
# Quantos países "principais" manter por direção nas quebras SH6×País (resto = "Outros").
TOP_COUNTRIES_N = 15

# ── E-mail ─────────────────────────────────────────────────────────────────────
EMAIL_RECIPIENTS = ["joao.helito@itaubba.com"]   # 2026-08-03: só o e-mail do Itaú (sem gmail)
NOW = datetime.utcnow().isoformat()

# ── MDIC ───────────────────────────────────────────────────────────────────────
MDIC_BASE = "https://balanca.economia.gov.br/balanca/bd/comexstat-bd/ncm"
MDIC_TABS = "https://balanca.economia.gov.br/balanca/bd/tabelas"

# ─────────────────────────────────────────────────────────────────────────────
# CLASSIFICAÇÃO NCM/SH6 — FONTE ÚNICA = dicionário (_shared/dictionary_codes.csv)
# Os sets chumbados (272 NCM) foram REMOVIDOS em 2026-06-19. A classificação agora
# vem do dicionário do analista (build_dictionary.py a partir de
# Standard_NCM_SH6_clmd.xlsx) — editar o .xlsx + rodar build_dictionary.py.
# Equivalência provada por _shared/test_dictionary_equivalence.py.
# ─────────────────────────────────────────────────────────────────────────────
ALL_NCM = _dict.all_ncm_set()


def classify_ncm(ncm: str) -> list:
    """['segment', 'subcategory'] do NCM, via DICIONÁRIO (_shared/dictionary.py).
    Ex.: '72131000' → ['long', 'rebar']. (Antes eram sets chumbados; migrado 2026-06-19.)"""
    return _dict.classify_ncm(ncm)


# ══════════════════════════════════════════════════════════════════════════════
# PREVISÃO — importações Brasil ← Coreia/China dos SH6 ANTIDUMPING (linha laranja
# "SECEX" do Modelo Preditivo). REBASEADO 2026-06-19 (decisão do usuário): saiu de
# HRC/CRC (34 SH6 chumbados) p/ os 55 SH6 marcados "Antidumping" no dicionário;
# product = subcategoria do dicionário (HRC/CRC/Coated/...). MESMO conjunto da linha
# PRETA (pred_exports via update_korea.py + robô China) → comparação maçã-com-maçã.
# A previsão é em nível SH6 (consolida NCMs repetidos sob cada SH6).
# ══════════════════════════════════════════════════════════════════════════════
_AD_SH6 = _dict.antidumping_sh6_set()   # 55 SH6 (strings, 6 dígitos)


def _classify_sh6(ncm):
    """Subcategoria do dicionário (HRC/CRC/Coated/...) SE o SH6 do NCM for ANTIDUMPING;
    None caso contrário. (Antes: HRC/CRC/OTHER por 34 SH6 chumbados.)"""
    sh6 = str(ncm).strip().zfill(8)[:6]
    if sh6 not in _AD_SH6:
        return None
    return _dict.sh6_subcategory(sh6, "steel") or "other"


def _classify_pred_country(country) -> str:
    """Coreia / China / Other (mesma regra do extractor_sm.py p/ manter o histórico)."""
    c = str(country).lower()
    if "coreia" in c or "korea" in c:
        return "Korea"
    if "china" in c or "chin" in c:
        return "China"
    return "Other"


def _aggregate_import_prediction(df_raw, only_after=None):
    """Agrega o df MDIC de IMPORTAÇÃO (period,ncm,country,kg,usd) em linhas de
    import_prediction (period,product,country,value_usd,volume_kg) — só Coreia/China,
    só os SH6 ANTIDUMPING; product = subcategoria do dicionário. value_usd/volume_kg em
    unidade BRUTA (USD/kg), igual ao extractor (o front converte kg→kt ao plotar)."""
    agg = {}
    for _, row in df_raw.iterrows():
        period = str(row["period"]).strip()
        if only_after and period <= only_after:
            continue
        product = _classify_sh6(row["ncm"])
        if not product:
            continue
        country = _classify_pred_country(row.get("country", ""))
        if country == "Other":
            continue
        usd = float(row.get("usd", 0) or 0)
        kg  = float(row.get("kg", 0) or 0)
        key = (period, product, country)
        if key not in agg:
            agg[key] = [0.0, 0.0]
        agg[key][0] += usd
        agg[key][1] += kg
    return [(p, prod, ctry, v[0], v[1], NOW) for (p, prod, ctry), v in agg.items()]


def upsert_import_prediction(conn, rows):
    conn.executemany(
        "INSERT OR REPLACE INTO import_prediction "
        "(period,product,country,value_usd,volume_kg,updated_at) VALUES (?,?,?,?,?,?)",
        rows,
    )
    conn.commit()


# ─────────────────────────────────────────────────────────────────────────────
# BANCO DE DADOS
# ─────────────────────────────────────────────────────────────────────────────
def init_tables(conn):
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS secex_country (
        period         TEXT,
        direction      TEXT,
        category       TEXT,
        country        TEXT,
        volume_ktons   REAL,
        revenue_usd_mn REAL,
        updated_at     TEXT,
        PRIMARY KEY (period, direction, category, country)
    );
    CREATE TABLE IF NOT EXISTS secex_exports (
        period         TEXT,
        category       TEXT,
        volume_ktons   REAL,
        revenue_usd_mn REAL,
        price_usd_ton  REAL,
        yoy_volume     REAL,
        yoy_revenue    REAL,
        updated_at     TEXT,
        PRIMARY KEY (period, category)
    );
    CREATE TABLE IF NOT EXISTS secex_imports (
        period         TEXT,
        category       TEXT,
        volume_ktons   REAL,
        revenue_usd_mn REAL,
        price_usd_ton  REAL,
        yoy_volume     REAL,
        yoy_revenue    REAL,
        updated_at     TEXT,
        PRIMARY KEY (period, category)
    );
    CREATE TABLE IF NOT EXISTS secex_meta (
        key   TEXT PRIMARY KEY,
        value TEXT
    );
    CREATE TABLE IF NOT EXISTS import_prediction (
        period    TEXT,
        product   TEXT,
        country   TEXT,
        value_usd REAL,
        volume_kg REAL,
        updated_at TEXT,
        PRIMARY KEY (period, product, country)
    );
    CREATE TABLE IF NOT EXISTS secex_sh6_country (
        period         TEXT,
        direction      TEXT,
        sh6            TEXT,
        country        TEXT,
        volume_ktons   REAL,
        revenue_usd_mn REAL,
        PRIMARY KEY (period, direction, sh6, country)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS secex_sh6_urf (
        period         TEXT,
        direction      TEXT,
        sh6            TEXT,
        port           TEXT,
        volume_ktons   REAL,
        revenue_usd_mn REAL,
        PRIMARY KEY (period, direction, sh6, port)
    ) WITHOUT ROWID;
    """)
    # Limpeza: secex_port é tabela MORTA (deprecated; NÃO lida pelo frontend — só citada
    # em comentários). Removê-la poupa ~42k linhas no .db servido ao navegador.
    conn.execute("DROP TABLE IF EXISTS secex_port")
    conn.commit()


def get_latest_period(conn, direction="imp"):
    row = conn.execute(
        "SELECT MAX(period) FROM secex_country WHERE direction=?", (direction,)
    ).fetchone()
    return row[0] if row and row[0] else None


def upsert_country(conn, rows):
    conn.executemany(
        "INSERT OR REPLACE INTO secex_country "
        "(period,direction,category,country,volume_ktons,revenue_usd_mn,updated_at) "
        "VALUES (?,?,?,?,?,?,?)",
        rows,
    )
    conn.commit()


def upsert_agg(conn, table, rows):
    conn.executemany(
        f"INSERT OR REPLACE INTO {table} "
        "(period,category,volume_ktons,revenue_usd_mn,price_usd_ton,yoy_volume,yoy_revenue,updated_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        rows,
    )
    conn.commit()


# ─────────────────────────────────────────────────────────────────────────────
# DERIVAR secex_exports / secex_imports A PARTIR DE secex_country
# ─────────────────────────────────────────────────────────────────────────────
def derive_aggregates(conn):
    """
    Calcula volume/receita totais por (period, category) somando os países,
    computa YoY e grava em secex_exports e secex_imports.
    Categorias derivadas: flat, long, semi, hrc, crc, coated, heavy_plate,
                          flat_others, rebar, wire_rod, bar, shapes,
                          long_others, ingot_billet, placa, total
    """
    print("  [DERIVE] Calculando agregados por período+categoria...")

    for direction, table in [("exp", "secex_exports"), ("imp", "secex_imports")]:
        # Buscar todos os dados brutos de secex_country para esta direção
        df = pd.read_sql(
            "SELECT period, category, SUM(volume_ktons) as vol, "
            "       SUM(revenue_usd_mn) as rev "
            "FROM secex_country WHERE direction=? "
            "GROUP BY period, category ORDER BY period, category",
            conn, params=(direction,)
        )
        if df.empty:
            continue

        # Adicionar categoria "total" = flat + long + semi
        totals = (
            df[df["category"].isin(["flat", "long", "semi"])]
            .groupby("period")[["vol", "rev"]].sum()
            .reset_index()
        )
        totals["category"] = "total"
        df = pd.concat([df, totals], ignore_index=True)

        df = df.sort_values(["category", "period"]).reset_index(drop=True)

        # Computar YoY por categoria
        rows = []
        for cat, grp in df.groupby("category"):
            grp = grp.sort_values("period").copy()
            grp["vol_prev"]  = grp["vol"].shift(12)
            grp["rev_prev"]  = grp["rev"].shift(12)
            grp["yoy_vol"]   = (grp["vol"] - grp["vol_prev"]) / grp["vol_prev"].replace(0, float("nan"))
            grp["yoy_rev"]   = (grp["rev"] - grp["rev_prev"]) / grp["rev_prev"].replace(0, float("nan"))
            grp["price"]     = (grp["rev"] * 1000 / grp["vol"].replace(0, float("nan")))  # USD/ton

            for _, r in grp.iterrows():
                rows.append((
                    r["period"], cat,
                    round(float(r["vol"]),  4) if pd.notna(r["vol"])  else None,
                    round(float(r["rev"]),  4) if pd.notna(r["rev"])  else None,
                    round(float(r["price"]),2) if pd.notna(r["price"]) else None,
                    round(float(r["yoy_vol"]), 4) if pd.notna(r["yoy_vol"]) else None,
                    round(float(r["yoy_rev"]), 4) if pd.notna(r["yoy_rev"]) else None,
                    NOW,
                ))

        upsert_agg(conn, table, rows)
        print(f"    {table}: {len(rows)} linhas gravadas.")


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────
def _download_csv(url, encoding="latin-1"):
    resp = requests.get(url, verify=False, timeout=180,
                        headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    return pd.read_csv(
        io.StringIO(resp.content.decode(encoding, errors="replace")),
        sep=";", dtype=str, low_memory=False,
    )


def fetch_pais_lookup() -> dict:
    """Retorna {CO_PAIS: NO_PAIS} (português)."""
    df = _download_csv(f"{MDIC_TABS}/PAIS.csv")
    df.columns = [c.strip().strip('"') for c in df.columns]
    mapping = {}
    for _, r in df.iterrows():
        code = str(r.get("CO_PAIS", "")).strip().strip('"').zfill(3)
        name = str(r.get("NO_PAIS", "")).strip().strip('"')
        mapping[code] = name
    print(f"  [PAIS] {len(mapping)} países carregados.")
    return mapping


def fetch_urf_lookup() -> dict:
    """Retorna {CO_URF: NO_URF} (ex.: {'0817800': '0817800 - PORTO DE SANTOS'})."""
    df = _download_csv(f"{MDIC_TABS}/URF.csv")
    df.columns = [c.strip().strip('"') for c in df.columns]
    mapping = {}
    for _, r in df.iterrows():
        code = str(r.get("CO_URF", "")).strip().strip('"').zfill(7)
        name = str(r.get("NO_URF", "")).strip().strip('"')
        mapping[code] = name
    print(f"  [URF] {len(mapping)} unidades aduaneiras carregadas.")
    return mapping


def build_port_map(urf_map: dict) -> dict:
    """{CO_URF → nome de porto canônico} via norm_port (funde URFs do mesmo porto)."""
    return {code: norm_port(name) for code, name in urf_map.items()}


def _top_countries(conn, direction, n=TOP_COUNTRIES_N, recent_from=RECENT_FROM) -> set:
    """Top-N países por volume em secex_country (janela recente) p/ a direção dada."""
    rows = conn.execute(
        "SELECT country, SUM(volume_ktons) v FROM secex_country "
        "WHERE direction=? AND period>=? GROUP BY country ORDER BY v DESC LIMIT ?",
        (direction, recent_from, n),
    ).fetchall()
    return {r[0] for r in rows if r[0]}


def upsert_sh6_country(conn, rows):
    conn.executemany(
        "INSERT OR REPLACE INTO secex_sh6_country "
        "(period,direction,sh6,country,volume_ktons,revenue_usd_mn) "
        "VALUES (?,?,?,?,?,?)", rows,
    )
    conn.commit()


def upsert_sh6_urf(conn, rows):
    conn.executemany(
        "INSERT OR REPLACE INTO secex_sh6_urf "
        "(period,direction,sh6,port,volume_ktons,revenue_usd_mn) "
        "VALUES (?,?,?,?,?,?)", rows,
    )
    conn.commit()


def _accumulate_sh6(df, direction, acc_country, acc_urf, only_after=None):
    """Acumula df MDIC (com colunas sh6/port) em dois dicts (kg/usd brutos):
       acc_country[(period,dir,sh6,country)] e acc_urf[(period,dir,sh6,port)].
    Só SH6 de aço e período >= RECENT_FROM (e > only_after, se informado)."""
    for _, row in df.iterrows():
        period = str(row["period"]).strip()
        if period < RECENT_FROM:
            continue
        if only_after and period <= only_after:
            continue
        ncm = str(row["ncm"]).strip().zfill(8)
        if ncm not in ALL_NCM:          # mesmo universo do secex_country (NCMs do dicionário)
            continue
        sh6 = str(row["sh6"]).strip()
        country = str(row.get("country", "")).strip() or "Outros"
        port    = str(row.get("port", "")).strip() or "Outros"
        kg  = float(row.get("kg", 0) or 0)
        usd = float(row.get("usd", 0) or 0)
        ck = (period, direction, sh6, country)
        uk = (period, direction, sh6, port)
        acc_country.setdefault(ck, [0.0, 0.0]); acc_country[ck][0] += kg; acc_country[ck][1] += usd
        acc_urf.setdefault(uk, [0.0, 0.0]);     acc_urf[uk][0] += kg;     acc_urf[uk][1] += usd


def _sh6_country_rows(acc_country, keep_by_dir):
    """Fold país p/ top-N (resto='Outros') e gera linhas (kt, US$ mn)."""
    folded = {}
    for (p, d, sh6, country), v in acc_country.items():
        c = country if country in keep_by_dir.get(d, set()) else "Outros"
        k = (p, d, sh6, c)
        folded.setdefault(k, [0.0, 0.0]); folded[k][0] += v[0]; folded[k][1] += v[1]
    return [(p, d, sh6, c, round(v[0] / 1e6, 6), round(v[1] / 1e6, 6))
            for (p, d, sh6, c), v in folded.items()]


def _sh6_urf_rows(acc_urf):
    return [(p, d, sh6, port, round(v[0] / 1e6, 6), round(v[1] / 1e6, 6))
            for (p, d, sh6, port), v in acc_urf.items()]


# ─────────────────────────────────────────────────────────────────────────────
# PROCESSAMENTO DO CSV MDIC → secex_country
# ─────────────────────────────────────────────────────────────────────────────
def _aggregate_df(df_raw, direction, pais_map, only_after=None):
    """
    Agrega DataFrame MDIC (colunas: period, ncm, country, kg, usd) em linhas
    por (period, direction, category, country).
    Retorna lista de tuplas prontas para INSERT em secex_country.
    """
    country_agg = {}  # (period, direction, cat, country) → [kg, usd]

    for _, row in df_raw.iterrows():
        period  = str(row["period"]).strip()
        if only_after and period <= only_after:
            continue
        ncm     = str(row["ncm"]).strip().zfill(8)
        country = str(row.get("country", "")).strip() or "Não declarado"
        kg      = float(row.get("kg", 0) or 0)
        usd     = float(row.get("usd", 0) or 0)

        for cat in classify_ncm(ncm):
            ck = (period, direction, cat, country)
            if ck not in country_agg:
                country_agg[ck] = [0.0, 0.0]
            country_agg[ck][0] += kg
            country_agg[ck][1] += usd

    rows = [
        (p, d, cat, ctry,
         round(v[0] / 1_000_000, 6),   # kg → ktons
         round(v[1] / 1_000_000, 6),   # USD → USD mn
         NOW)
        for (p, d, cat, ctry), v in country_agg.items()
    ]
    return rows


def _download_mdic_year(year: int, direction: str, pais_map: dict,
                        port_map: dict | None = None) -> pd.DataFrame | None:
    """
    Baixa EXP_{year}.csv ou IMP_{year}.csv do MDIC bulk (latin-1, separador ;),
    filtra pelos NCMs de interesse e retorna DataFrame normalizado:
      period, ncm, country, kg, usd
    """
    prefix = "EXP" if direction == "exp" else "IMP"
    url    = f"{MDIC_BASE}/{prefix}_{year}.csv"
    print(f"  Baixando: {prefix}_{year}.csv ...")

    try:
        resp = requests.get(url, verify=False, timeout=300,
                            headers={"User-Agent": "Mozilla/5.0"}, stream=True)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"    ERRO ao baixar {url}: {e}")
        return None

    usecols = ["CO_ANO", "CO_MES", "CO_NCM", "CO_PAIS", "CO_URF", "KG_LIQUIDO", "VL_FOB"]
    chunks  = []
    try:
        for chunk in pd.read_csv(
            io.StringIO(resp.content.decode("latin-1", errors="replace")),
            sep=";", dtype=str, usecols=usecols,
            chunksize=150_000, low_memory=False,
        ):
            chunk["CO_NCM"] = chunk["CO_NCM"].str.strip().str.zfill(8)
            # NCMs de aço do dicionário (secex/sh6) + TODOS os NCMs sob os SH6 ANTIDUMPING
            # (previsão em nível SH6 — consolida códigos repetidos), mesmo fora do dicionário.
            mask = chunk["CO_NCM"].isin(ALL_NCM) | chunk["CO_NCM"].str[:6].isin(_AD_SH6)
            filtered = chunk[mask]
            if len(filtered):
                chunks.append(filtered)
    except Exception as e:
        print(f"    ERRO ao parsear {url}: {e}")
        return None

    if not chunks:
        print(f"    Nenhum dado Steel em {prefix}_{year}.csv")
        return None

    df = pd.concat(chunks, ignore_index=True)
    df["period"]  = df["CO_ANO"].str.strip() + "-" + df["CO_MES"].str.strip().str.zfill(2)
    df["country"] = df["CO_PAIS"].str.strip().str.zfill(3).map(pais_map).fillna("Outros")
    df["kg"]      = pd.to_numeric(df["KG_LIQUIDO"], errors="coerce").fillna(0)
    df["usd"]     = pd.to_numeric(df["VL_FOB"],     errors="coerce").fillna(0)
    df["ncm"]     = df["CO_NCM"]
    df["sh6"]     = df["CO_NCM"].str[:6]
    df["port"]    = (df["CO_URF"].str.strip().str.zfill(7).map(port_map).fillna("Outros")
                     if port_map is not None else "Outros")

    print(f"    {len(df):,} linhas | periodos: {df['period'].min()} a {df['period'].max()}")
    return df[["period", "ncm", "sh6", "country", "port", "kg", "usd"]]


# ─────────────────────────────────────────────────────────────────────────────
# ATUALIZAÇÃO INCREMENTAL
# ─────────────────────────────────────────────────────────────────────────────
def update_from_mdic(conn, force_reload=False):
    """
    Verifica se há novos meses publicados pelo MDIC e os insere no DB.
    Retorna (new_data: bool, new_period: str | None).
    """
    print("\n[MDIC] Verificando novos dados SECEX...")

    latest_in_db = get_latest_period(conn, "imp") or "2009-12"
    pred_latest = (conn.execute("SELECT MAX(period) FROM import_prediction").fetchone()[0]) or "1996-01"
    print(f"  Último período no DB: secex={latest_in_db} | import_prediction={pred_latest}")

    pais_map = fetch_pais_lookup()
    urf_map  = fetch_urf_lookup()
    port_map = build_port_map(urf_map)
    sh6_latest = conn.execute("SELECT MAX(period) FROM secex_sh6_country").fetchone()[0]
    print(f"  Último período SH6 (país/urf): {sh6_latest or '—'}")

    current_year = datetime.utcnow().year
    years_to_check = [current_year - 1, current_year] \
                     if datetime.utcnow().month <= 2 else [current_year]

    found_periods = set()
    pred_periods  = set()
    acc_country, acc_urf = {}, {}

    for direction in ("imp", "exp"):
        for year in years_to_check:
            df = _download_mdic_year(year, direction, pais_map, port_map)
            if df is None:
                continue

            max_period_csv = df["period"].max()
            print(f"  {direction.upper()} {year}: último período disponível = {max_period_csv}")

            # ── secex_country (gated pelo último período do secex) ──────────────
            if force_reload or max_period_csv > latest_in_db:
                threshold = latest_in_db if not force_reload else "1996-01"
                c_rows = _aggregate_df(df, direction, pais_map, only_after=threshold)
                upsert_country(conn, c_rows)
                new_ps = {r[0] for r in c_rows}
                found_periods.update(new_ps)
                print(f"  → secex: {len(new_ps)} períodos | {len(c_rows):,} linhas país")
            else:
                print(f"  → secex sem novidades (DB já tem até {latest_in_db})")

            # ── import_prediction (Coreia/China HRC/CRC) — INDEPENDENTE do secex:
            #    gated pelo PRÓPRIO último período da tabela, p/ auto-recuperar quando
            #    o secex já avançou mas a previsão ficou pra trás (e seguir junto daí). ─
            if direction == "imp" and (force_reload or max_period_csv > pred_latest):
                p_thr = "1996-01" if force_reload else pred_latest
                p_rows = _aggregate_import_prediction(df, only_after=p_thr)
                if p_rows:
                    upsert_import_prediction(conn, p_rows)
                    pp = sorted({r[0] for r in p_rows})
                    pred_periods.update(pp)
                    print(f"  → import_prediction: {len(p_rows)} linhas | períodos {pp}")

            # ── secex_sh6_country / secex_sh6_urf (quebra fina; gated pelo próprio máx.) ─
            if force_reload or max_period_csv > (sh6_latest or "0000-00"):
                _accumulate_sh6(df, direction, acc_country, acc_urf,
                                only_after=(None if force_reload else sh6_latest))

    if found_periods:
        derive_aggregates(conn)

    if acc_country:
        keep_by_dir = {"imp": _top_countries(conn, "imp"), "exp": _top_countries(conn, "exp")}
        upsert_sh6_country(conn, _sh6_country_rows(acc_country, keep_by_dir))
        upsert_sh6_urf(conn, _sh6_urf_rows(acc_urf))
        # janela rolante: poda períodos que saíram dos ~6 anos (mantém o .db sob controle)
        conn.execute("DELETE FROM secex_sh6_country WHERE period < ?", (RECENT_FROM,))
        conn.execute("DELETE FROM secex_sh6_urf     WHERE period < ?", (RECENT_FROM,))
        conn.commit()
        sh6_ps = sorted({k[0] for k in acc_country})
        print(f"  → secex_sh6: {len(sh6_ps)} períodos | sh6×país(pré-fold)={len(acc_country):,} "
              f"| sh6×urf={len(acc_urf):,}")

    all_new = found_periods | pred_periods
    if all_new:
        latest_new = sorted(all_new)[-1]
        print(f"\n  ✅ NOVO DADO: secex={sorted(found_periods)[-1] if found_periods else '—'}"
              f" | import_prediction={sorted(pred_periods)[-1] if pred_periods else '—'}")
        _write_gh_env("true", latest_new)
        return True, latest_new
    else:
        print("\n  ℹ️  Nenhum dado novo encontrado.")
        _write_gh_env("false", None)
        return False, None


# ─────────────────────────────────────────────────────────────────────────────
# BACKFILL HISTÓRICO
# ─────────────────────────────────────────────────────────────────────────────
def backfill(conn, start_year=2015):
    """
    Reprocessa todos os anos de start_year até o ano atual.
    Apaga e recria secex_country para garantir classificação atualizada.
    """
    print(f"\n[BACKFILL] Reprocessando histórico a partir de {start_year}...")
    print("  Limpando secex_country / secex_sh6_country / secex_sh6_urf...")
    conn.execute("DELETE FROM secex_country")
    conn.execute("DELETE FROM secex_sh6_country")
    conn.execute("DELETE FROM secex_sh6_urf")
    conn.commit()

    pais_map = fetch_pais_lookup()
    urf_map  = fetch_urf_lookup()
    port_map = build_port_map(urf_map)
    current_year = datetime.utcnow().year

    acc_country, acc_urf = {}, {}
    for year in range(start_year, current_year + 1):
        for direction in ("exp", "imp"):
            df = _download_mdic_year(year, direction, pais_map, port_map)
            if df is None:
                continue
            c_rows = _aggregate_df(df, direction, pais_map)
            upsert_country(conn, c_rows)
            _accumulate_sh6(df, direction, acc_country, acc_urf)
            print(f"  {direction.upper()} {year}: {len(c_rows):,} linhas inseridas")

    print("\n  Derivando agregados (secex_exports / secex_imports)...")
    derive_aggregates(conn)

    print("  Gravando quebras SH6×País / SH6×URF...")
    keep_by_dir = {"imp": _top_countries(conn, "imp"), "exp": _top_countries(conn, "exp")}
    upsert_sh6_country(conn, _sh6_country_rows(acc_country, keep_by_dir))
    upsert_sh6_urf(conn, _sh6_urf_rows(acc_urf))
    print(f"    sh6×país={len(acc_country):,} (pré-fold) | sh6×urf={len(acc_urf):,}")
    conn.commit()
    print("  Compactando o banco (VACUUM)...")
    conn.execute("VACUUM")
    print("[BACKFILL] Concluído.")


def backfill_sh6(conn, start_year=2015):
    """(Re)constrói as tabelas DERIVADAS sem tocar em secex_country: as quebras
    secex_sh6_country/secex_sh6_urf E a linha laranja import_prediction (rebaseada p/ os
    SH6 ANTIDUMPING), na janela rolante (~6 anos). O DELETE limpa produtos/países antigos
    (ex.: OTHER/Other que o --update incremental não remove)."""
    sy = max(start_year, datetime.utcnow().year - 6)  # não antes da janela rolante (~6 anos)
    print(f"\n[BACKFILL-SH6] Reconstruindo SH6×País/URF + import_prediction a partir de {sy}...")
    conn.execute("DELETE FROM secex_sh6_country")
    conn.execute("DELETE FROM secex_sh6_urf")
    conn.execute("DELETE FROM import_prediction")
    conn.commit()

    pais_map = fetch_pais_lookup()
    port_map = build_port_map(fetch_urf_lookup())
    current_year = datetime.utcnow().year

    acc_country, acc_urf, pred_rows = {}, {}, []
    for year in range(sy, current_year + 1):
        for direction in ("exp", "imp"):
            df = _download_mdic_year(year, direction, pais_map, port_map)
            if df is None:
                continue
            _accumulate_sh6(df, direction, acc_country, acc_urf)
            if direction == "imp":                        # linha laranja = Brasil IMPORTA
                pred_rows.extend(_aggregate_import_prediction(df))
            print(f"  {direction.upper()} {year}: acumulado ({len(acc_country):,} sh6×país)")

    keep_by_dir = {"imp": _top_countries(conn, "imp"), "exp": _top_countries(conn, "exp")}
    upsert_sh6_country(conn, _sh6_country_rows(acc_country, keep_by_dir))
    upsert_sh6_urf(conn, _sh6_urf_rows(acc_urf))
    if pred_rows:
        upsert_import_prediction(conn, pred_rows)
    print(f"  sh6×país={len(acc_country):,} (pré-fold) | sh6×urf={len(acc_urf):,} "
          f"| import_prediction={len(pred_rows)}")
    conn.commit()
    print("  Compactando o banco (VACUUM) p/ reclamar espaço de secex_port/old...")
    conn.execute("VACUUM")
    print("[BACKFILL-SH6] Concluído.")


# ─────────────────────────────────────────────────────────────────────────────
# E-MAIL DE NOTIFICAÇÃO
# ─────────────────────────────────────────────────────────────────────────────
def send_email(period: str):
    smtp_server = os.environ.get("SMTP_SERVER", "smtp.gmail.com")
    smtp_port   = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user   = os.environ.get("SMTP_USER", "")
    smtp_pass   = os.environ.get("SMTP_PASS", "")

    if not smtp_user or not smtp_pass:
        print("  [EMAIL] Credenciais SMTP não configuradas — pulando envio.")
        return

    year, month = period.split("-")
    month_names = {
        "01": "Janeiro", "02": "Fevereiro", "03": "Março",    "04": "Abril",
        "05": "Maio",    "06": "Junho",     "07": "Julho",    "08": "Agosto",
        "09": "Setembro","10": "Outubro",   "11": "Novembro", "12": "Dezembro",
    }
    mes_nome = month_names.get(month, month)
    subject  = f"🔔 SECEX Steel & Mining — novo dado: {mes_nome}/{year}"
    body = f"""Olá,

O SECEX (MDIC) publicou novos dados de comércio exterior de aço.

📅 Novo período disponível: {mes_nome} / {year}
📊 Dashboard atualizado: https://metals-mining-pulp-paper-dashboard.vercel.app/

Dados de importação e exportação por país foram atualizados automaticamente.

---
Itaú BBA — Equity Research | Steel & Mining
(e-mail gerado automaticamente)
"""
    msg = MIMEMultipart()
    msg["From"]    = smtp_user
    msg["To"]      = ", ".join(EMAIL_RECIPIENTS)
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain", "utf-8"))

    try:
        with smtplib.SMTP(smtp_server, smtp_port) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.sendmail(smtp_user, EMAIL_RECIPIENTS, msg.as_string())
        print(f"  [EMAIL] Enviado para {EMAIL_RECIPIENTS}")
    except Exception as e:
        print(f"  [EMAIL] Erro ao enviar: {e}")


def _write_gh_env(new_data: str, period: str | None):
    gh_env = os.environ.get("GITHUB_ENV")
    if not gh_env:
        return
    with open(gh_env, "a") as f:
        f.write(f"NEW_DATA={new_data}\n")
        if period:
            f.write(f"LATEST_PERIOD={period}\n")


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────
def main():
    try:  # evita UnicodeEncodeError no console cp1252 do Windows (→/emoji nos prints)
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    parser = argparse.ArgumentParser(description="Steel & Mining SECEX Auto-Updater")
    parser.add_argument("--update",     action="store_true",
                        help="Baixa CSVs MDIC e aplica novos meses")
    parser.add_argument("--backfill",   action="store_true",
                        help="Reprocessa histórico completo com nova classificação NCM")
    parser.add_argument("--backfill-sh6", action="store_true",
                        help="(Re)constroi quebras SH6xPais/URF + linha laranja antidumping (2015+), sem tocar no resto")
    parser.add_argument("--check",      action="store_true",
                        help="Apenas verifica o último mês disponível no MDIC (sem baixar)")
    parser.add_argument("--derive",     action="store_true",
                        help="Apenas recalcula secex_exports/imports a partir de secex_country")
    parser.add_argument("--send-email", action="store_true",
                        help="Envia e-mail de teste (requer variáveis SMTP_*)")
    parser.add_argument("--force",      action="store_true",
                        help="Recarrega todos os dados mesmo que já existam no DB")
    parser.add_argument("--start-year", type=int, default=2015,
                        help="Ano inicial para --backfill (padrão: 2015)")
    args = parser.parse_args()

    if args.check:
        # Verifica o último mês disponível sem baixar o CSV inteiro
        year = datetime.utcnow().year
        url  = f"{MDIC_BASE}/IMP_{year}.csv"
        resp = requests.get(url, verify=False, timeout=30, stream=True,
                            headers={"User-Agent": "Mozilla/5.0"})
        content = b""
        for chunk in resp.iter_content(65536):
            content += chunk
            if len(content) > 3_000_000:
                break
        df = pd.read_csv(
            io.StringIO(content.decode("latin-1", errors="replace")),
            sep=";", dtype=str, usecols=["CO_ANO", "CO_MES"], low_memory=False,
        )
        df["period"] = df["CO_ANO"].str.strip() + "-" + df["CO_MES"].str.strip().str.zfill(2)
        print(f"Último período disponível no MDIC: {df['period'].max()}")
        return

    conn = sqlite3.connect(DB_PATH)
    init_tables(conn)
    print(f"DB: {DB_PATH}")

    new_data, new_period = False, None

    if args.backfill:
        backfill(conn, start_year=args.start_year)
        new_data, new_period = True, get_latest_period(conn)

    elif args.backfill_sh6:
        backfill_sh6(conn, start_year=args.start_year)

    elif args.update:
        new_data, new_period = update_from_mdic(conn, force_reload=args.force)

    elif args.derive:
        derive_aggregates(conn)

    if (new_data and new_period) or args.send_email:
        period_to_notify = new_period or "—"
        send_email(period_to_notify)

    conn.close()
    print("\nConcluído.")


if __name__ == "__main__":
    main()
