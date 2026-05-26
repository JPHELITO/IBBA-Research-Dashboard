#!/usr/bin/env python3
"""
updater_sm.py — Steel & Mining SECEX Auto-Updater
==================================================
Modos:
  --load-excel   Carrega histórico das 6 planilhas SECEX verticais (Downloads/)
  --update       Baixa os CSVs bulk do MDIC e aplica novos meses ao DB
  --all          Ambos (ideal para primeira execução)

Novas tabelas geradas (por país e por porto):
  secex_country  — period × direction × category × country
  secex_port     — period × direction × category × uf

Dependências:
  pip install pandas openpyxl requests

Configuração de e-mail (via variáveis de ambiente ou GitHub Secrets):
  SMTP_SERVER   → ex: smtp.gmail.com
  SMTP_PORT     → ex: 587
  SMTP_USER     → conta Gmail
  SMTP_PASS     → App Password do Gmail
"""

import sqlite3, sys, os, io, ssl, smtplib, argparse, zipfile, tempfile
from pathlib import Path
from datetime import datetime, date
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

try:
    import pandas as pd
    import requests
except ImportError:
    sys.exit("Faltando dependências: pip install pandas openpyxl requests")

# ── Caminhos ───────────────────────────────────────────────────────────────────
HERE      = Path(__file__).parent
DB_PATH   = HERE / "steel_sm.db"
DOWNLOADS = Path.home() / "Downloads"

# Planilhas históricas (vertical format)
EXCEL_FILES = {
    "exp_flat": DOWNLOADS / "EXPORTAÇÃO FLAT.xlsx",
    "exp_long": DOWNLOADS / "EXPORTAÇÃO LONG.xlsx",
    "exp_semi": DOWNLOADS / "EXPORTAÇÃO SEMI.xlsx",
    "imp_flat": DOWNLOADS / "IMPORTAÇÃO FLAT.xlsx",
    "imp_long": DOWNLOADS / "IMPORTAÇÃO LONG.xlsx",
    "imp_semi": DOWNLOADS / "IMPORTAÇÃO SEMI.xlsx",
}

# E-mail
EMAIL_RECIPIENTS = ["jphelito@gmail.com", "joao.helito@itaubba.com"]

NOW = datetime.utcnow().isoformat()

# ── Constantes MDIC ────────────────────────────────────────────────────────────
MDIC_BASE  = "https://balanca.economia.gov.br/balanca/bd/comexstat-bd/ncm"
MDIC_TABS  = "https://balanca.economia.gov.br/balanca/bd/tabelas"

# ─────────────────────────────────────────────────────────────────────────────
# CLASSIFICAÇÃO NCM
# ─────────────────────────────────────────────────────────────────────────────
FLAT_NCM = set("""
72106100 72104910 72107010 72106990 72082690 72251100 72085100 72101200
72109000 72259200 72254090 72083990 72259990 72255090 72104990 72091600
72251900 72091700 72082500 72193300 72105000 72082790 72193400 72107020
72083890 72083700 72192100 72103010 72091800 72253000 72191200 72083910
72193200 72192200 72193500 72106911 72085200 72081000 72082710 72191400
72199090 72193100 72191300 72191100 72083690 72085300 72199010 72259100
72254020 72192400 72192300 72083810 72254010 72092600 72259910 72085400
72082610 72084000 72106919 72092700 72104190 72101100 72089000 72099000
72092500 72103090 72104110 72091500 72255010 72102000 72092800 72083610
72255000 72252000 72259900 72106900 73064000 72202090 73063000 73066100
73069090 72123000 72261100 72209000 73061900 73069020 72122010 73052000
72269100 73065000 72269200 72201220 72121000 72119010 73069010 73051100
72202010 72125090 72124010 73061100 72124029 72112920 73051200 72111900
73145000 72112300 72201290 72201100 73062100 72119090 72201210 72112910
72124021 72262010 73053100 72269900 72111400 72126000 73062900 72261900
73066900 73051900 72262090 73053900 72122090 73059000 72111300 72125010
73066000 73062000 72269400 72124020 72269300 72125000
""".split())

LONG_NCM = set("""
73041900 73021010 73042400 72139190 72142000 72283000 73044190 72222000
72149910 72221100 73043910 72163200 72165000 72285000 72284000 73011000
73045119 72281090 73042931 73042390 73045990 72139110 72279000 72161000
73045910 72221910 72287000 73044900 72149990 72288000 72210000 73043110
72131000 72163100 72151000 72163300 72162200 72224090 72155000 73042939
72141090 73042990 72149100 72281010 73043990 72159010 73042910 73041100
72286000 73021090 73043190 73049090 73023000 73024000 72166110 72141010
72164010 73049019 73049011 72223000 73043920 72166190 72169900 72132000
72159090 72143000 73045190 73042310 72139910 73029000 72169100 72139990
72221990 72282000 73012000 72224010 72164090 73042200 72166910 73044110
72166990 72272000 73045111 72271000 73045919 73045911 73044100 73045110
73041010 73041090 73042920 73042190 73042110 73022000 73021020 72171019
73121090 72171090 73121010 72292000 72172090 72230000 72299000 72173010
73170090 72179000 73144100 72172010 73141400 72173090 73143900 73130000
73141900 73170020 73144200 73144900 73141200 73142000 73170010 73170030
72291000
""".split())

SEMI_NCM = set("""
72071110 72071200 72072000 72249000 72061000 72241000
72189100 72189900 72071900 72071190 72069000 72181000
""".split())

REBAR_NCM  = {"72131000", "72142000"}
ALL_NCM    = FLAT_NCM | LONG_NCM | SEMI_NCM

# SH6 (6 dígitos) para HRC e CRC
HRC_SH6 = {
    720890, 720826, 720827, 720837, 720838, 720839,
    720853, 720854, 722540, 722691, 720825, 721190,
    722530, 720810, 720836, 721113, 721114, 721119, 720840,
}
CRC_SH6 = {
    720928, 720925, 722619, 722519, 721123, 720990,
    722692, 721129, 722550, 720918, 720915, 720927,
    720926, 720917, 720916,
}


def classify_ncm(ncm: str) -> list:
    """Retorna lista de categorias aplicáveis ao NCM (pode ser mais de uma)."""
    c = str(ncm).strip().zfill(8)
    sh6 = int(c[:6])
    cats = []
    if c in SEMI_NCM:
        cats.append("semi")
    if c in FLAT_NCM:
        cats.append("flat")
        if sh6 in HRC_SH6:
            cats.append("hrc")
        elif sh6 in CRC_SH6:
            cats.append("crc")
    if c in LONG_NCM:
        cats.append("long")
        if c in REBAR_NCM:
            cats.append("rebar")
    return cats


# ─────────────────────────────────────────────────────────────────────────────
# BANCO DE DADOS
# ─────────────────────────────────────────────────────────────────────────────
def init_new_tables(conn):
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS secex_country (
        period       TEXT,
        direction    TEXT,
        category     TEXT,
        country      TEXT,
        volume_ktons REAL,
        revenue_usd_mn REAL,
        updated_at   TEXT,
        PRIMARY KEY (period, direction, category, country)
    );
    CREATE TABLE IF NOT EXISTS secex_port (
        period       TEXT,
        direction    TEXT,
        category     TEXT,
        uf           TEXT,
        volume_ktons REAL,
        revenue_usd_mn REAL,
        updated_at   TEXT,
        PRIMARY KEY (period, direction, category, uf)
    );
    CREATE TABLE IF NOT EXISTS secex_meta (
        key   TEXT PRIMARY KEY,
        value TEXT
    );
    """)
    conn.commit()


def get_latest_period(conn, direction="imp"):
    """Retorna o último período ('YYYY-MM') no DB para a direção dada."""
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


def upsert_port(conn, rows):
    conn.executemany(
        "INSERT OR REPLACE INTO secex_port "
        "(period,direction,category,uf,volume_ktons,revenue_usd_mn,updated_at) "
        "VALUES (?,?,?,?,?,?,?)",
        rows,
    )
    conn.commit()


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────
_MES_MAP = {
    "01": 1, "02": 2, "03": 3, "04": 4, "05": 5, "06": 6,
    "07": 7, "08": 8, "09": 9, "10": 10, "11": 11, "12": 12,
    "janeiro": 1, "fevereiro": 2, "março": 3, "abril": 4,
    "maio": 5, "junho": 6, "julho": 7, "agosto": 8,
    "setembro": 9, "outubro": 10, "novembro": 11, "dezembro": 12,
}

def _parse_mes(mes_str) -> int:
    """Converte '04. Abril' ou '04' → 4."""
    s = str(mes_str).strip().lower()
    # "04. Abril" → take numeric prefix
    num = s.split(".")[0].strip()
    if num in _MES_MAP:
        return _MES_MAP[num]
    # search for month name
    for k, v in _MES_MAP.items():
        if k in s:
            return v
    return 0


def _ssl_ctx():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _download_csv(url, encoding="latin-1"):
    """Baixa um CSV do MDIC e retorna um pd.DataFrame."""
    print(f"  Baixando: {url}")
    resp = requests.get(url, verify=False, timeout=120,
                        headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    return pd.read_csv(
        io.StringIO(resp.content.decode(encoding, errors="replace")),
        sep=";", dtype=str, low_memory=False,
    )


# ─────────────────────────────────────────────────────────────────────────────
# LOOKUP TABLES (PAIS, UF)
# ─────────────────────────────────────────────────────────────────────────────
def fetch_pais_lookup() -> dict:
    """Retorna {CO_PAIS: NO_PAIS_ING} (inglês, para consistência)."""
    df = _download_csv(f"{MDIC_TABS}/PAIS.csv")
    df.columns = [c.strip().strip('"') for c in df.columns]
    mapping = {}
    for _, r in df.iterrows():
        code = str(r.get("CO_PAIS", "")).strip().strip('"').zfill(3)
        name = str(r.get("NO_PAIS", "")).strip().strip('"')  # português
        mapping[code] = name
    print(f"  [PAIS] {len(mapping)} países carregados.")
    return mapping


# ─────────────────────────────────────────────────────────────────────────────
# PROCESSAMENTO GENÉRICO DE DATAFRAME SECEX
# ─────────────────────────────────────────────────────────────────────────────
def _aggregate_df(df, direction, pais_map, only_after=None):
    """
    Agrega um DataFrame SECEX (formato MDIC CSV ou Excel vertical) em linhas
    por (period, direction, category, country/uf).

    Colunas esperadas (normalizadas antes de chamar):
      period, ncm, country, uf, kg, usd

    Retorna: (country_rows, port_rows) — listas prontas para INSERT.
    """
    country_agg = {}  # (period, direction, cat, country) → [kg, usd]
    port_agg    = {}  # (period, direction, cat, uf)      → [kg, usd]

    for _, row in df.iterrows():
        period  = str(row["period"]).strip()
        if only_after and period <= only_after:
            continue
        ncm     = str(row["ncm"]).strip().zfill(8)
        country = str(row.get("country", "")).strip()
        uf      = str(row.get("uf", "")).strip()
        kg      = float(row.get("kg", 0) or 0)
        usd     = float(row.get("usd", 0) or 0)

        for cat in classify_ncm(ncm):
            ck = (period, direction, cat, country)
            if ck not in country_agg:
                country_agg[ck] = [0.0, 0.0]
            country_agg[ck][0] += kg
            country_agg[ck][1] += usd

            pk = (period, direction, cat, uf)
            if pk not in port_agg:
                port_agg[pk] = [0.0, 0.0]
            port_agg[pk][0] += kg
            port_agg[pk][1] += usd

    c_rows = [
        (p, d, cat, ctry,
         round(v[0] / 1_000_000, 6),   # kg → ktons
         round(v[1] / 1_000_000, 6),   # USD → USD mn
         NOW)
        for (p, d, cat, ctry), v in country_agg.items()
    ]
    p_rows = [
        (p, d, cat, uf_,
         round(v[0] / 1_000_000, 6),
         round(v[1] / 1_000_000, 6),
         NOW)
        for (p, d, cat, uf_), v in port_agg.items()
    ]
    return c_rows, p_rows


# ─────────────────────────────────────────────────────────────────────────────
# CARREGAMENTO DAS PLANILHAS EXCEL HISTÓRICAS (formato vertical SECEX)
# ─────────────────────────────────────────────────────────────────────────────
def load_excel_files(conn):
    """
    Lê as 6 planilhas SECEX verticais do Downloads/ e popula
    secex_country e secex_port com o histórico completo.

    Colunas esperadas: Ano | Mês | Código NCM | Descrição NCM |
                       Países | UF do Produto | Valor US$ FOB | Quilograma Líquido
    """
    print("\n[EXCEL] Carregando planilhas históricas SECEX...")

    all_c, all_p = [], []

    for key, path in EXCEL_FILES.items():
        if not path.exists():
            print(f"  [SKIP] Arquivo não encontrado: {path}")
            continue

        direction = "exp" if key.startswith("exp") else "imp"
        print(f"\n  Lendo {path.name} ({direction.upper()})...")

        # Formato SECEX vertical: Ano | Mês | Código NCM | Descrição NCM |
        #                         Países | UF do Produto | Valor US$ FOB | Quilograma Líquido
        # Usar posição de coluna (encoding de nomes pode variar no Windows)
        df_raw = pd.read_excel(path, dtype=str, header=0)
        if df_raw.shape[1] < 8:
            print(f"    ERRO: esperado >= 8 colunas, encontrado {df_raw.shape[1]}")
            continue
        df_raw = df_raw.iloc[:, :8].copy()
        df_raw.columns = ["ano", "mes", "ncm", "_desc", "country", "uf", "usd", "kg"]
        df_raw.drop(columns=["_desc"], inplace=True)

        # Montar coluna period
        def make_period(row):
            try:
                ano = str(row["ano"]).strip()[:4]
                mes = _parse_mes(row.get("mes", ""))
                if int(ano) < 1997 or mes == 0:
                    return None
                return f"{ano}-{mes:02d}"
            except Exception:
                return None

        df_raw["period"] = df_raw.apply(make_period, axis=1)
        df_raw = df_raw.dropna(subset=["period"])
        df_raw["kg"]  = pd.to_numeric(df_raw["kg"],  errors="coerce").fillna(0)
        df_raw["usd"] = pd.to_numeric(df_raw["usd"], errors="coerce").fillna(0)

        print(f"    {len(df_raw):,} linhas | periodos: {df_raw['period'].min()} a {df_raw['period'].max()}")

        c_rows, p_rows = _aggregate_df(df_raw, direction, pais_map=None)
        all_c.extend(c_rows)
        all_p.extend(p_rows)
        print(f"    >> {len(c_rows):,} linhas pais | {len(p_rows):,} linhas porto")

    print(f"\n  Inserindo no DB...")
    upsert_country(conn, all_c)
    upsert_port(conn, all_p)
    print(f"  [EXCEL] Concluído. {len(all_c):,} linhas país | {len(all_p):,} linhas porto inseridas.")


# ─────────────────────────────────────────────────────────────────────────────
# AUTO-ATUALIZAÇÃO: MDIC BULK CSV
# ─────────────────────────────────────────────────────────────────────────────
def _download_mdic_year(year: int, direction: str, pais_map: dict) -> pd.DataFrame | None:
    """
    Baixa EXP_{year}.csv ou IMP_{year}.csv do MDIC, filtra pelos nossos NCMs
    e retorna DataFrame normalizado com colunas:
      period, ncm, country, uf, kg, usd
    """
    prefix = "EXP" if direction == "exp" else "IMP"
    url    = f"{MDIC_BASE}/{prefix}_{year}.csv"

    try:
        resp = requests.get(url, verify=False, timeout=180,
                            headers={"User-Agent": "Mozilla/5.0"}, stream=True)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"    ERRO ao baixar {url}: {e}")
        return None

    # Ler em chunks e filtrar pelos NCMs de interesse
    chunks = []
    usecols = ["CO_ANO", "CO_MES", "CO_NCM", "CO_PAIS", "SG_UF_NCM",
               "KG_LIQUIDO", "VL_FOB"]
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
        print(f"    Nenhum dado Steel encontrado em {prefix}_{year}.csv")
        return None

    df = pd.concat(chunks, ignore_index=True)

    # Construir period
    df["period"] = df["CO_ANO"].str.strip() + "-" + df["CO_MES"].str.strip().str.zfill(2)

    # Mapear país
    df["CO_PAIS_Z"] = df["CO_PAIS"].str.strip().str.zfill(3)
    df["country"]   = df["CO_PAIS_Z"].map(pais_map).fillna("Outros")

    df["uf"]  = df["SG_UF_NCM"].str.strip()
    df["kg"]  = pd.to_numeric(df["KG_LIQUIDO"], errors="coerce").fillna(0)
    df["usd"] = pd.to_numeric(df["VL_FOB"],     errors="coerce").fillna(0)
    df["ncm"] = df["CO_NCM"]

    return df[["period", "ncm", "country", "uf", "kg", "usd"]]


def update_from_mdic(conn, force_reload=False):
    """
    Verifica se há novos meses publicados pelo MDIC e os insere no DB.
    Retorna (new_data: bool, new_period: str | None).
    """
    print("\n[MDIC] Verificando novos dados SECEX...")

    # Período mais recente no DB
    latest_in_db = get_latest_period(conn, "imp") or "2009-12"
    print(f"  Último período no DB: {latest_in_db}")

    # Lookup de países
    pais_map = fetch_pais_lookup()

    current_year = datetime.utcnow().year
    years_to_check = [current_year - 1, current_year] if datetime.utcnow().month <= 2 \
                     else [current_year]

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

            # Filtrar apenas períodos novos
            threshold = latest_in_db if not force_reload else "1996-01"
            c_rows, p_rows = _aggregate_df(df, direction, pais_map, only_after=threshold)
            upsert_country(conn, c_rows)
            upsert_port(conn, p_rows)

            new_ps = {r[0] for r in c_rows}
            found_periods.update(new_ps)
            print(f"  → {len(new_ps)} novos períodos | {len(c_rows)} linhas país | {len(p_rows)} linhas porto")

    if found_periods:
        latest_new = sorted(found_periods)[-1]
        print(f"\n  ✅ NOVO DADO: {latest_new}")
        # Escreve para GitHub Actions env
        gh_env = os.environ.get("GITHUB_ENV")
        if gh_env:
            with open(gh_env, "a") as f:
                f.write(f"NEW_DATA=true\n")
                f.write(f"LATEST_PERIOD={latest_new}\n")
        return True, latest_new
    else:
        print("\n  ℹ️  Nenhum dado novo encontrado.")
        gh_env = os.environ.get("GITHUB_ENV")
        if gh_env:
            with open(gh_env, "a") as f:
                f.write(f"NEW_DATA=false\n")
        return False, None


# ─────────────────────────────────────────────────────────────────────────────
# E-MAIL DE NOTIFICAÇÃO
# ─────────────────────────────────────────────────────────────────────────────
def send_email(period: str):
    """Envia e-mail de notificação quando novo dado SECEX é publicado."""
    smtp_server = os.environ.get("SMTP_SERVER", "smtp.gmail.com")
    smtp_port   = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user   = os.environ.get("SMTP_USER", "")
    smtp_pass   = os.environ.get("SMTP_PASS", "")

    if not smtp_user or not smtp_pass:
        print("  [EMAIL] Credenciais SMTP não configuradas — pulando envio.")
        return

    year, month = period.split("-")
    month_names = {
        "01": "Janeiro", "02": "Fevereiro", "03": "Março", "04": "Abril",
        "05": "Maio",    "06": "Junho",     "07": "Julho", "08": "Agosto",
        "09": "Setembro","10": "Outubro",   "11": "Novembro","12": "Dezembro",
    }
    mes_nome = month_names.get(month, month)

    subject = f"🔔 SECEX Steel & Mining — novo dado: {mes_nome}/{year}"
    body = f"""
Olá,

O SECEX (MDIC) publicou novos dados de comércio exterior de aço.

📅 Novo período disponível: {mes_nome} / {year}
📊 Dashboard atualizado: https://ibba-research-dashboard.vercel.app/

Os dados de importação e exportação por país e por porto foram
atualizados automaticamente no Steel & Mining Dashboard.

---
Itaú BBA — Equity Research | Steel & Mining
Este e-mail foi gerado automaticamente.
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


# ─────────────────────────────────────────────────────────────────────────────
# VERIFICAÇÃO DE DISPONIBILIDADE (sem baixar tudo)
# ─────────────────────────────────────────────────────────────────────────────
def check_latest_available() -> str | None:
    """
    Verifica rapidamente qual o último mês disponível no MDIC
    baixando apenas as primeiras linhas do CSV do ano atual.
    Retorna 'YYYY-MM' ou None.
    """
    year = datetime.utcnow().year
    url  = f"{MDIC_BASE}/IMP_{year}.csv"
    try:
        resp = requests.get(url, verify=False, timeout=30,
                            headers={"User-Agent": "Mozilla/5.0"}, stream=True)
        resp.raise_for_status()
        # Ler apenas primeiros 5MB para detectar meses disponíveis
        content = b""
        for chunk in resp.iter_content(chunk_size=65536):
            content += chunk
            if len(content) > 5_000_000:
                break
        df = pd.read_csv(
            io.StringIO(content.decode("latin-1", errors="replace")),
            sep=";", dtype=str, usecols=["CO_ANO", "CO_MES"], low_memory=False,
        )
        df["period"] = df["CO_ANO"].str.strip() + "-" + df["CO_MES"].str.strip().str.zfill(2)
        return df["period"].max()
    except Exception as e:
        print(f"  [CHECK] Erro: {e}")
        return None


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Steel & Mining SECEX Auto-Updater")
    parser.add_argument("--load-excel", action="store_true",
                        help="Carrega planilhas Excel históricas do Downloads/")
    parser.add_argument("--update",     action="store_true",
                        help="Baixa CSVs MDIC e aplica novos meses")
    parser.add_argument("--check",      action="store_true",
                        help="Apenas verifica o último mês disponível no MDIC")
    parser.add_argument("--all",        action="store_true",
                        help="Executa --load-excel + --update")
    parser.add_argument("--send-email", action="store_true",
                        help="Envia e-mail mesmo sem novidades (para teste)")
    parser.add_argument("--force",      action="store_true",
                        help="Recarrega todos os dados mesmo que já existam no DB")
    args = parser.parse_args()

    if args.check:
        latest = check_latest_available()
        print(f"Último período disponível no MDIC: {latest}")
        return

    conn = sqlite3.connect(DB_PATH)
    init_new_tables(conn)
    print(f"DB: {DB_PATH}")

    if args.all or args.load_excel:
        load_excel_files(conn)

    new_data, new_period = False, None
    if args.all or args.update:
        new_data, new_period = update_from_mdic(conn, force_reload=args.force)

    if (new_data and new_period) or args.send_email:
        period_to_notify = new_period or check_latest_available() or "—"
        send_email(period_to_notify)

    conn.close()
    print("\nConcluído.")
    sys.exit(0 if new_data or args.load_excel else 0)


if __name__ == "__main__":
    import warnings
    warnings.filterwarnings("ignore")  # ignora avisos SSL
    main()
