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
DB_PATH = HERE / "steel_sm.db"

# ── E-mail ─────────────────────────────────────────────────────────────────────
EMAIL_RECIPIENTS = ["jphelito@gmail.com", "joao.helito@itaubba.com"]
NOW = datetime.utcnow().isoformat()

# ── MDIC ───────────────────────────────────────────────────────────────────────
MDIC_BASE = "https://balanca.economia.gov.br/balanca/bd/comexstat-bd/ncm"
MDIC_TABS = "https://balanca.economia.gov.br/balanca/bd/tabelas"

# ─────────────────────────────────────────────────────────────────────────────
# CLASSIFICAÇÃO NCM — baseada no DICIONÁRIO NCM fornecido
# Cada NCM pertence a EXATAMENTE UMA subcategoria dentro de seu segmento
# ─────────────────────────────────────────────────────────────────────────────

# ── SEMI (12 NCMs) ────────────────────────────────────────────────────────────
INGOT_BILLET_NCM = {
    "72072000", "72061000", "72241000", "72189900", "72071190",
    "72071900", "72069000", "72071110", "72181000",
}
PLACA_NCM = {
    "72071200", "72249000", "72189100",
}
SEMI_NCM = INGOT_BILLET_NCM | PLACA_NCM

# ── FLAT (147 NCMs) ───────────────────────────────────────────────────────────
HRC_NCM = {
    "72081000", "72082500", "72082610", "72082690", "72082710",
    "72082790", "72083610", "72083690", "72083700", "72083810",
    "72083990", "72084000", "72085300", "72085400", "72089000",
    "72111300", "72111400", "72111900", "72119010", "72119090",
    "72253000", "72254090", "72269100", "72083890", "72083910",
}
HEAVY_PLATE_NCM = {
    "72085100", "72085200", "73089010",
}
CRC_NCM = {
    "72091500", "72091600", "72091700", "72091800", "72092500",
    "72092600", "72092700", "72092800", "72099000", "72112300",
    "72112910", "72112920", "72255090", "72269200",
}
COATED_NCM = {
    "72101100", "72101200", "72105000", "72121000", "72125090",
    "72107010", "72107020", "72124010", "72124021", "72124029",
    "72103010", "72103090", "72104910", "72104990", "72106100",
    "72106911", "72106919", "72122010", "72122090", "72123000",
    "72259100", "72259200", "72259990", "72269900", "72106990",
    "72102000", "72109000", "72106900", "72104110", "72104190",
}
FLAT_OTHERS_NCM = {
    "72191100", "72191200", "72191300", "72191400", "72192100",
    "72192200", "72192300", "72192400", "72193100", "72193200",
    "72193300", "72193400", "72193500", "72199010", "72199090",
    "72251100", "72252000", "72254010", "72254020", "72255000",
    "72255010", "72259900", "72259910", "73051100", "73051200",
    "73051900", "73052000", "73061000", "73062000", "73063000",
    "73069010", "73053100", "73053900", "73059000", "73061100",
    "73061900", "73062100", "73062900", "73064000", "73065000",
    "73066000", "73066100", "73066900", "73069020", "73069090",
    "72124020", "72125000", "72125010", "72126000", "73145000",
    "72201100", "72201210", "72201220", "72201290", "72202010",
    "72202090", "72209000", "72261100", "72261900", "72262010",
    "72262090", "72269300", "72269400",
}
FLAT_NCM = HRC_NCM | HEAVY_PLATE_NCM | CRC_NCM | COATED_NCM | FLAT_OTHERS_NCM

# ── LONG (113 NCMs) ───────────────────────────────────────────────────────────
WIRE_ROD_NCM = {
    "72139100", "72139190", "72139990", "72279000", "72132000",
    "72272000", "72139910", "72271000", "72210000",
}
REBAR_NCM = {
    "72131000", "72142000",
}
BAR_NCM = {
    "72141010", "72141090", "72143000", "72149100", "72149910",
    "72149990", "72151000", "72155000", "72159010", "72159090",
    "72282000", "72283000", "72284000", "72285000", "72286000",
    "72288000", "72281010", "72281090", "72221100", "72221910",
    "72221990", "72222000", "72223000",
}
SHAPES_NCM = {
    "72161000", "72162100", "72162200", "72165000", "72166100",
    "72166910", "72169100", "72169900", "72163100", "72163200",
    "72163300", "72164010", "72164090", "72166190", "72166990",
    "73011000", "73012000", "72224090", "72287000", "72224010",
}
LONG_OTHERS_NCM = {
    "73041090", "73041900", "73042110", "73042310", "73042910",
    "73043110", "73043190", "73043910", "73043920", "73043990",
    "73049090", "73041010", "73041100", "73042190", "73042200",
    "73042390", "73042400", "73042920", "73042931", "73042939",
    "73042990", "73044100", "73044110", "73044190", "73044900",
    "73045110", "73045111", "73045119", "73045190", "73045910",
    "73045911", "73045919", "73045990", "73049011", "73049019",
    "73021010", "73021020", "73021090", "73022000", "73023000",
    "73024000", "73029000", "72171011", "72171019", "72171090",
    "72172010", "72172090", "72173010", "72173090", "72179000",
    "73121010", "73121090", "73129000", "73130000", "73142000",
    "73143100", "73143900", "73144100", "73144200", "73144900",
    "73170010", "73170020", "73170030", "73170090", "72230000",
    "72291000", "72292000", "72299000", "73141200", "73141400",
    "73141900",
}
LONG_NCM = WIRE_ROD_NCM | REBAR_NCM | BAR_NCM | SHAPES_NCM | LONG_OTHERS_NCM

ALL_NCM = FLAT_NCM | LONG_NCM | SEMI_NCM


def classify_ncm(ncm: str) -> list[str]:
    """
    Retorna lista de categorias para o NCM informado.
    Cada NCM pertence a no máximo 2 categorias: o segmento pai + a subcategoria.
    Ex: '72131000' → ['long', 'rebar']
    """
    c = str(ncm).strip().zfill(8)
    cats = []

    # SEMI
    if c in INGOT_BILLET_NCM:
        cats += ["semi", "ingot_billet"]
    elif c in PLACA_NCM:
        cats += ["semi", "placa"]

    # FLAT
    if c in HRC_NCM:
        cats += ["flat", "hrc"]
    elif c in HEAVY_PLATE_NCM:
        cats += ["flat", "heavy_plate"]
    elif c in CRC_NCM:
        cats += ["flat", "crc"]
    elif c in COATED_NCM:
        cats += ["flat", "coated"]
    elif c in FLAT_OTHERS_NCM:
        cats += ["flat", "flat_others"]

    # LONG
    if c in REBAR_NCM:
        cats += ["long", "rebar"]
    elif c in WIRE_ROD_NCM:
        cats += ["long", "wire_rod"]
    elif c in BAR_NCM:
        cats += ["long", "bar"]
    elif c in SHAPES_NCM:
        cats += ["long", "shapes"]
    elif c in LONG_OTHERS_NCM:
        cats += ["long", "long_others"]

    return cats


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
    """)
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


def _download_mdic_year(year: int, direction: str, pais_map: dict) -> pd.DataFrame | None:
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

    usecols = ["CO_ANO", "CO_MES", "CO_NCM", "CO_PAIS", "KG_LIQUIDO", "VL_FOB"]
    chunks  = []
    try:
        for chunk in pd.read_csv(
            io.StringIO(resp.content.decode("latin-1", errors="replace")),
            sep=";", dtype=str, usecols=usecols,
            chunksize=150_000, low_memory=False,
        ):
            chunk["CO_NCM"] = chunk["CO_NCM"].str.strip().str.zfill(8)
            filtered = chunk[chunk["CO_NCM"].isin(ALL_NCM)]
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

    print(f"    {len(df):,} linhas | periodos: {df['period'].min()} a {df['period'].max()}")
    return df[["period", "ncm", "country", "kg", "usd"]]


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
    print(f"  Último período no DB: {latest_in_db}")

    pais_map = fetch_pais_lookup()

    current_year = datetime.utcnow().year
    years_to_check = [current_year - 1, current_year] \
                     if datetime.utcnow().month <= 2 else [current_year]

    found_periods = set()

    for direction in ("imp", "exp"):
        for year in years_to_check:
            df = _download_mdic_year(year, direction, pais_map)
            if df is None:
                continue

            max_period_csv = df["period"].max()
            print(f"  {direction.upper()} {year}: último período disponível = {max_period_csv}")

            if not force_reload and max_period_csv <= latest_in_db:
                print(f"  → Sem novidades (DB já tem até {latest_in_db})")
                continue

            threshold = latest_in_db if not force_reload else "1996-01"
            c_rows = _aggregate_df(df, direction, pais_map, only_after=threshold)
            upsert_country(conn, c_rows)

            new_ps = {r[0] for r in c_rows}
            found_periods.update(new_ps)
            print(f"  → {len(new_ps)} períodos | {len(c_rows):,} linhas país")

    if found_periods:
        latest_new = sorted(found_periods)[-1]
        derive_aggregates(conn)
        print(f"\n  ✅ NOVO DADO: {latest_new}")
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
    print("  Limpando secex_country...")
    conn.execute("DELETE FROM secex_country")
    conn.commit()

    pais_map = fetch_pais_lookup()
    current_year = datetime.utcnow().year

    for year in range(start_year, current_year + 1):
        for direction in ("exp", "imp"):
            df = _download_mdic_year(year, direction, pais_map)
            if df is None:
                continue
            c_rows = _aggregate_df(df, direction, pais_map)
            upsert_country(conn, c_rows)
            print(f"  {direction.upper()} {year}: {len(c_rows):,} linhas inseridas")

    print("\n  Derivando agregados (secex_exports / secex_imports)...")
    derive_aggregates(conn)
    print("[BACKFILL] Concluído.")


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
📊 Dashboard atualizado: https://ibba-research-dashboard.vercel.app/

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
    parser = argparse.ArgumentParser(description="Steel & Mining SECEX Auto-Updater")
    parser.add_argument("--update",     action="store_true",
                        help="Baixa CSVs MDIC e aplica novos meses")
    parser.add_argument("--backfill",   action="store_true",
                        help="Reprocessa histórico completo com nova classificação NCM")
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
