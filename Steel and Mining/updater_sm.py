#!/usr/bin/env python3
"""
updater_sm.py — Steel & Mining SECEX Auto-Updater
==================================================
Modos:
  --update      Reconfere a janela (REVISE_YEARS) no MDIC e aplica mês novo E revisões
  --reconcile   Só audita: compara a dash com o MDIC e sai 1 se divergir (não grava)
  --anos A B    Janela explícita (ex.: --anos 2025 2026), p/ reprocessar histórico
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

import sqlite3, sys, os, io, ssl, smtplib, argparse, warnings, time
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
# Quantos ANOS o --update reconfere a cada rodada (o corrente + os anteriores). O MDIC
# revisa meses já publicados; 2 anos cobre com folga o que ele mexe (medido: ano fechado
# não muda mais). Ver _janela_anos().
REVISE_YEARS = int(os.environ.get("SECEX_REVISE_YEARS", "2"))
# Quantas vezes tentar cada CSV do MDIC antes de desistir (ele corta conexão em arquivo grande).
MDIC_TENTATIVAS = 3
MDIC_ESPERA_S   = 5
# Fração máxima de linhas que pode "sumir" da fonte numa rodada antes de o updater
# recusar apagar (ver a trava em _sincroniza_country).
MAX_SUMICO_FRAC = 0.10

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
    usecols = ["CO_ANO", "CO_MES", "CO_NCM", "CO_PAIS", "CO_URF", "KG_LIQUIDO", "VL_FOB"]
    chunks  = None

    # O MDIC corta a conexão no meio de arquivo grande (visto em 08/09/2026:
    # "IncompleteRead(13,5 MB lidos, 106,6 MB esperados)" no IMP_2026, ~120 MB). Como
    # agora cada rodada baixa 4 arquivos (janela de 2 anos × 2 direções), uma queda
    # dessas passou a custar um ANO inteiro sem reconferir — daí a repetição. E o
    # download é conferido contra o Content-Length: arquivo cortado que o pandas
    # consegue parsear entraria como "ano com menos dados" e apagaria linhas boas.
    for tentativa in range(1, MDIC_TENTATIVAS + 1):
        sufixo = "" if tentativa == 1 else f" (tentativa {tentativa}/{MDIC_TENTATIVAS})"
        print(f"  Baixando: {prefix}_{year}.csv ...{sufixo}")
        try:
            resp = requests.get(url, verify=False, timeout=600,
                                headers={"User-Agent": "Mozilla/5.0"}, stream=True)
            resp.raise_for_status()
            bruto = resp.content
            esperado = int(resp.headers.get("Content-Length") or 0)
            if esperado and len(bruto) < esperado:
                raise IOError(f"download incompleto: {len(bruto):,} de {esperado:,} bytes")

            acc = []
            for chunk in pd.read_csv(
                io.StringIO(bruto.decode("latin-1", errors="replace")),
                sep=";", dtype=str, usecols=usecols,
                chunksize=150_000, low_memory=False,
            ):
                chunk["CO_NCM"] = chunk["CO_NCM"].str.strip().str.zfill(8)
                # NCMs de aço do dicionário (secex/sh6) + TODOS os NCMs sob os SH6 ANTIDUMPING
                # (previsão em nível SH6 — consolida códigos repetidos), mesmo fora do dicionário.
                mask = chunk["CO_NCM"].isin(ALL_NCM) | chunk["CO_NCM"].str[:6].isin(_AD_SH6)
                filtered = chunk[mask]
                if len(filtered):
                    acc.append(filtered)
            chunks = acc
            break
        except Exception as e:
            print(f"    ERRO em {url}: {e}")
            if tentativa < MDIC_TENTATIVAS:
                time.sleep(MDIC_ESPERA_S * tentativa)

    if chunks is None:
        print(f"    DESISTINDO de {prefix}_{year} após {MDIC_TENTATIVAS} tentativas.")
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
def _janela_anos(n=None) -> list:
    """Anos que o --update reconfere a cada rodada: o corrente e os (n-1) anteriores.

    Por que reconferir o ano inteiro em vez de "só o mês novo": o MDIC REVISA meses já
    publicados. Medido em 08/09/2026 contra o CSV ao vivo — 2025 (ano fechado) não mexe
    mais (0 divergências em 24 mês×direção), mas o ano CORRENTE revisa de verdade, e
    feio: a exportação de revestidos p/ a Argentina em 2026-04 caiu de 69,84 kt (o que a
    dash guardava) para 25,88 kt, −63%, confirmado pelo CSV bulk E pela API do Comex
    Stat. O `only_after=latest_in_db` antigo gravava só o mês novo e descartava a revisão
    em silêncio — a dash congelava no 1º número divulgado, o mesmo bug que o IABr teve.
    """
    n = n or REVISE_YEARS
    atual = datetime.utcnow().year
    return list(range(atual - n + 1, atual + 1))


def _sincroniza_country(conn, rows, direction, dry_run=False, forcar=False):
    """Grava secex_country SÓ ONDE O NÚMERO MUDOU, nos períodos que `rows` cobre.

    Reescrever linha igual mexeria no `updated_at` → o .db mudaria a cada rodada e o robô
    commitaria todo dia à toa. Devolve (novas, revisadas, removidas, periodos_mexidos).
    """
    periodos = sorted({r[0] for r in rows})
    if not periodos:
        return 0, 0, 0, set()
    marcas = ",".join("?" * len(periodos))
    atual = {
        (p, d, c, ctry): (round(kt or 0.0, 6), round(usd or 0.0, 6))
        for p, d, c, ctry, kt, usd in conn.execute(
            f"SELECT period,direction,category,country,volume_ktons,revenue_usd_mn "
            f"FROM secex_country WHERE direction=? AND period IN ({marcas})",
            (direction, *periodos))
    }
    gravar, novas, revisadas, mexidos, vivos = [], 0, 0, set(), set()
    for (p, d, cat, ctry, kt, usd, _ts) in rows:
        k = (p, d, cat, ctry)
        vivos.add(k)
        antes = atual.get(k)
        if antes is None:
            novas += 1
        elif antes != (round(kt, 6), round(usd, 6)):
            revisadas += 1
        elif not forcar:
            continue                      # igual: não toca (nem no updated_at)
        gravar.append((p, d, cat, ctry, kt, usd, NOW))
        mexidos.add(p)

    # Linha que existia e sumiu da fonte: dentro da janela o CSV do ano é a verdade
    # COMPLETA, então a órfã tem que sair (senão fica um número fantasma na dash).
    sumidas = [k for k in atual if k not in vivos]

    # ⚠️ TRAVA: só apaga se for POUCA coisa. Um CSV cortado no meio (o MDIC corta a
    # conexão em arquivo grande — visto em 08/09/2026) que ainda assim seja parseável
    # vira "meio ano de dados" e faria este passo APAGAR as linhas boas do resto do ano,
    # calado. Sumiço em massa é sinal de download truncado, não de revisão da fonte.
    if atual and len(sumidas) > MAX_SUMICO_FRAC * len(atual):
        print(f"    ⚠️  {len(sumidas)} de {len(atual)} linhas sumiram da fonte "
              f"({len(sumidas)/len(atual):.0%}) — NÃO apaguei nada. Fonte provavelmente "
              f"veio incompleta; confira e rode de novo.")
        sumidas = []

    if not dry_run:
        if gravar:
            upsert_country(conn, gravar)
        if sumidas:
            conn.executemany(
                "DELETE FROM secex_country WHERE period=? AND direction=? "
                "AND category=? AND country=?", sumidas)
            conn.commit()
    mexidos.update(k[0] for k in sumidas)
    return novas, revisadas, len(sumidas), mexidos


def _sincroniza_import_prediction(conn, rows, dry_run=False, forcar=False):
    """Mesma regra da _sincroniza_country, na linha laranja (import_prediction)."""
    periodos = sorted({r[0] for r in rows})
    if not periodos:
        return 0, 0, set()
    marcas = ",".join("?" * len(periodos))
    atual = {
        (p, prod, ctry): (round(v or 0.0, 6), round(kg or 0.0, 6))
        for p, prod, ctry, v, kg in conn.execute(
            f"SELECT period,product,country,value_usd,volume_kg FROM import_prediction "
            f"WHERE period IN ({marcas})", tuple(periodos))
    }
    gravar, novas, revisadas, mexidos = [], 0, 0, set()
    for (p, prod, ctry, usd, kg, _ts) in rows:
        antes = atual.get((p, prod, ctry))
        if antes is None:
            novas += 1
        elif antes != (round(usd, 6), round(kg, 6)):
            revisadas += 1
        elif not forcar:
            continue
        gravar.append((p, prod, ctry, usd, kg, NOW))
        mexidos.add(p)
    if gravar and not dry_run:
        upsert_import_prediction(conn, gravar)
    return novas, revisadas, mexidos


def _sincroniza_sh6(conn, acc_country, acc_urf, dry_run=False):
    """Reescreve as quebras SH6 da JANELA inteira, mas só quando o conjunto mudou.

    Aqui não dá para comparar linha a linha como nas outras: o top-15 de países é
    RECALCULADO a cada rodada, então um país pode entrar/sair de "Outros" e a linha
    antiga fica órfã (foi essa a armadilha que quase transformou exportação de placa
    para a Alemanha em "revisão" na auditoria de 08/09). Apagar e reescrever a janela é
    o que mantém a tabela internamente coerente.
    """
    if not acc_country:
        return 0, set()
    keep_by_dir = {"imp": _top_countries(conn, "imp"), "exp": _top_countries(conn, "exp")}
    novas_c = _sh6_country_rows(acc_country, keep_by_dir)
    novas_u = _sh6_urf_rows(acc_urf)
    janela = sorted({k[0] for k in acc_country})
    dirs   = sorted({k[1] for k in acc_country})
    mp, md = ",".join("?" * len(janela)), ",".join("?" * len(dirs))

    def _conjunto(tabela, col):
        return {(p, d, s, x, round(kt or 0.0, 6), round(usd or 0.0, 6))
                for p, d, s, x, kt, usd in conn.execute(
                    f"SELECT period,direction,sh6,{col},volume_ktons,revenue_usd_mn "
                    f"FROM {tabela} WHERE period IN ({mp}) AND direction IN ({md})",
                    (*janela, *dirs))}

    quer_c = {(p, d, s, x, round(kt, 6), round(usd, 6)) for p, d, s, x, kt, usd in novas_c}
    quer_u = {(p, d, s, x, round(kt, 6), round(usd, 6)) for p, d, s, x, kt, usd in novas_u}
    if (quer_c == _conjunto("secex_sh6_country", "country")
            and quer_u == _conjunto("secex_sh6_urf", "port")):
        return 0, set()
    if not dry_run:
        conn.execute(f"DELETE FROM secex_sh6_country WHERE period IN ({mp}) "
                     f"AND direction IN ({md})", (*janela, *dirs))
        conn.execute(f"DELETE FROM secex_sh6_urf     WHERE period IN ({mp}) "
                     f"AND direction IN ({md})", (*janela, *dirs))
        upsert_sh6_country(conn, novas_c)
        upsert_sh6_urf(conn, novas_u)
        # janela rolante: poda o que saiu dos ~6 anos (mantém o .db sob controle)
        conn.execute("DELETE FROM secex_sh6_country WHERE period < ?", (RECENT_FROM,))
        conn.execute("DELETE FROM secex_sh6_urf     WHERE period < ?", (RECENT_FROM,))
        conn.commit()
        # Apagar+reinserir a janela deixa páginas livres no arquivo; sem compactar, o .db
        # cresce a cada rodada e um dia bate no portão de 50 MB do sql.js (hoje em 47,5).
        conn.execute("VACUUM")
    return len(novas_c), set(janela)


def update_from_mdic(conn, force_reload=False, anos=None, dry_run=False):
    """Reconfere a janela de anos no MDIC e aplica o que mudou — mês NOVO e REVISÃO.

    Devolve (mudou: bool, ultimo_periodo: str | None).
    Com dry_run=True não escreve nada: é o modo --reconcile (auditoria).
    """
    anos = anos or _janela_anos()
    rotulo = "RECONCILE" if dry_run else "MDIC"
    print(f"\n[{rotulo}] Reconferindo {anos[0]}-{anos[-1]} no MDIC "
          f"({'sem gravar' if dry_run else 'grava so o que mudou'})...")

    pais_map = fetch_pais_lookup()
    port_map = build_port_map(fetch_urf_lookup())

    antes_max = get_latest_period(conn, "imp")
    print(f"  Ultimo periodo no DB antes desta rodada: {antes_max or '—'}")

    mes_novo, revisoes = None, {}
    tot_novas = tot_rev = tot_rem = 0
    acc_country, acc_urf = {}, {}
    falhou = []            # (ano, direção) que o MDIC não entregou nesta rodada

    for direction in ("imp", "exp"):
        for ano in anos:
            df = _download_mdic_year(ano, direction, pais_map, port_map)
            if df is None:
                falhou.append(f"{direction.upper()} {ano}")
                continue

            c_rows = _aggregate_df(df, direction, pais_map, only_after=None)
            novas, revs, rem, mexidos = _sincroniza_country(
                conn, c_rows, direction, dry_run=dry_run, forcar=force_reload)
            tot_novas += novas; tot_rev += revs; tot_rem += rem
            for p in mexidos:
                if antes_max and p <= antes_max:
                    revisoes[p] = revisoes.get(p, 0) + 1
            adiante = [p for p in mexidos if not antes_max or p > antes_max]
            if adiante:
                cand = max(adiante)
                mes_novo = cand if (mes_novo is None or cand > mes_novo) else mes_novo
            print(f"  {direction.upper()} {ano}: {novas} novas | {revs} REVISADAS | {rem} removidas")

            if direction == "imp":
                pn, pr, _ = _sincroniza_import_prediction(
                    conn, _aggregate_import_prediction(df), dry_run=dry_run, forcar=force_reload)
                if pn or pr:
                    print(f"      linha laranja (import_prediction): {pn} novas | {pr} revisadas")

            _accumulate_sh6(df, direction, acc_country, acc_urf)

    mudou_country = bool(tot_novas or tot_rev or tot_rem)
    if mudou_country and not dry_run:
        derive_aggregates(conn)

    n_sh6, _ = _sincroniza_sh6(conn, acc_country, acc_urf, dry_run=dry_run)
    if n_sh6:
        print(f"  secex_sh6_*: janela reescrita ({n_sh6:,} linhas SH6xPais)")

    mudou  = mudou_country or bool(n_sh6)
    ultimo = get_latest_period(conn, "imp") or antes_max

    if dry_run:
        # ⚠️ Sem o CSV não dá para certificar nada. Dizer "idêntica ao MDIC" porque o
        # download caiu seria o mesmo defeito que este updater existe para matar:
        # silêncio virando aprovação. Aqui a falta de dado é FALHA, não sucesso.
        if falhou:
            print(f"\n  [X] NÃO DEU PARA CONFERIR: o MDIC não entregou {', '.join(falhou)}. "
                  f"Sem esses arquivos não há como afirmar que a dash está certa.")
            return True, ultimo
        if mudou:
            print(f"\n  [X] DIVERGE do MDIC: {tot_novas} faltando | {tot_rev} desatualizadas "
                  f"| {tot_rem} sobrando" + (" | SH6 fora de sincronia" if n_sh6 else ""))
            if revisoes:
                print("      meses ja publicados que mudaram na fonte: "
                      + ", ".join(f"{p} ({n})" for p, n in sorted(revisoes.items())))
        else:
            print("\n  [OK] dash identica ao MDIC na janela conferida.")
        return mudou, ultimo

    if falhou:
        # Aviso do GitHub (aparece no resumo do run). NÃO derruba o job: o que baixou já
        # foi gravado e precisa ser commitado — a rodada seguinte reconfere o que faltou.
        print(f"::warning::MDIC não entregou {', '.join(falhou)} — esse período ficou "
              f"SEM reconferir nesta rodada; a próxima tenta de novo.")

    if mudou:
        print(f"\n  [OK] {tot_novas} linhas novas | {tot_rev} REVISADAS | {tot_rem} removidas")
        if mes_novo:
            print(f"      mes novo: {mes_novo}")
        if revisoes:
            print("      revisoes em meses ja publicados: "
                  + ", ".join(f"{p} ({n})" for p, n in sorted(revisoes.items())))
        _write_gh_env("true", ultimo, mes_novo, revisoes)
    else:
        print("\n  [--] Nada mudou (nem mes novo, nem revisao).")
        _write_gh_env("false", None, None, {})
    return mudou, ultimo


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


def _write_gh_env(new_data: str, period: str | None,
                  mes_novo: str | None = None, revisoes: dict | None = None):
    """Passa o resultado p/ os passos seguintes do workflow.

    NEW_DATA governa o commit e o e-mail. Separa MÊS NOVO de REVISÃO porque as duas
    coisas merecem commit, mas dizer "novo dado: 2026-04" quando o que houve foi uma
    revisão de abril seria mentira no assunto do e-mail.
    """
    gh_env = os.environ.get("GITHUB_ENV")
    if not gh_env:
        return
    with open(gh_env, "a", encoding="utf-8") as f:
        f.write(f"NEW_DATA={new_data}\n")
        if period:
            f.write(f"LATEST_PERIOD={period}\n")
        f.write(f"NEW_MONTH={mes_novo or ''}\n")
        resumo = ", ".join(f"{p} ({n})" for p, n in sorted((revisoes or {}).items()))
        f.write(f"REVISED={resumo}\n")


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
                        help="Reconfere a janela no MDIC e aplica mês novo + revisões")
    parser.add_argument("--reconcile",  action="store_true",
                        help="Só audita a janela contra o MDIC (não grava); sai 1 se divergir")
    parser.add_argument("--anos", type=int, nargs="+", metavar="ANO",
                        help="Janela explícita de anos p/ --update/--reconcile "
                             "(ex.: --anos 2025 2026). Padrão: os últimos "
                             f"{REVISE_YEARS} anos.")
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

    elif args.reconcile:
        diverge, _ = update_from_mdic(conn, anos=args.anos, dry_run=True)
        conn.close()
        # sai 1 p/ o job ficar VERMELHO: sem isso a divergência passa despercebida,
        # que foi exatamente como o CRC ficou 14 meses subestimado sem ninguém ver.
        sys.exit(1 if diverge else 0)

    elif args.update:
        new_data, new_period = update_from_mdic(conn, force_reload=args.force, anos=args.anos)

    elif args.derive:
        derive_aggregates(conn)

    if (new_data and new_period) or args.send_email:
        period_to_notify = new_period or "—"
        send_email(period_to_notify)

    conn.close()
    print("\nConcluído.")


if __name__ == "__main__":
    main()
