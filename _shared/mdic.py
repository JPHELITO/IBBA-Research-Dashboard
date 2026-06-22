#!/usr/bin/env python3
"""
mdic.py — Helper COMPARTILHADO de download do Comex Stat (MDIC bulk NCM).

Usado pelos updaters que puxam direto do MDIC para fontes além do aço (celulose por
porto, etc.). Genérico: filtra por uma lista de prefixos SH6 (6 dígitos).

⚠️ O updater de AÇO (Steel and Mining/updater_sm.py) ainda tem a SUA própria cópia do
download (não mexido p/ não arriscar o pipeline validado); pode migrar p/ cá no futuro
(dedup). Este módulo só depende de ports.norm_port.
"""
import io
import sys
import warnings
from pathlib import Path

import pandas as pd
import requests

sys.path.insert(0, str(Path(__file__).parent))
from ports import norm_port  # noqa: E402

warnings.filterwarnings("ignore")  # ignora avisos SSL do MDIC

MDIC_BASE = "https://balanca.economia.gov.br/balanca/bd/comexstat-bd/ncm"
MDIC_TABS = "https://balanca.economia.gov.br/balanca/bd/tabelas"
_UA = {"User-Agent": "Mozilla/5.0"}


def download_csv(url, encoding="latin-1") -> pd.DataFrame:
    r = requests.get(url, verify=False, timeout=180, headers=_UA)
    r.raise_for_status()
    return pd.read_csv(io.StringIO(r.content.decode(encoding, errors="replace")),
                       sep=";", dtype=str, low_memory=False)


def fetch_pais_lookup() -> dict:
    df = download_csv(f"{MDIC_TABS}/PAIS.csv")
    df.columns = [c.strip().strip('"') for c in df.columns]
    return {str(r.get("CO_PAIS", "")).strip().strip('"').zfill(3):
            str(r.get("NO_PAIS", "")).strip().strip('"') for _, r in df.iterrows()}


def fetch_urf_lookup() -> dict:
    df = download_csv(f"{MDIC_TABS}/URF.csv")
    df.columns = [c.strip().strip('"') for c in df.columns]
    return {str(r.get("CO_URF", "")).strip().strip('"').zfill(7):
            str(r.get("NO_URF", "")).strip().strip('"') for _, r in df.iterrows()}


def build_port_map(urf_map: dict) -> dict:
    """{CO_URF → nome de porto canônico} via norm_port (funde URFs do mesmo porto)."""
    return {code: norm_port(name) for code, name in urf_map.items()}


def download_mdic_year(year: int, direction: str, sh6_prefixes,
                       pais_map: dict | None = None, port_map: dict | None = None):
    """Baixa EXP_{year}.csv / IMP_{year}.csv, filtra pelos SH6 de interesse (prefixo de
    6 dígitos do NCM) e retorna df normalizado: period, ncm, sh6, country, port, kg, usd.
    Retorna None se não houver dados ou erro de download."""
    prefix = "EXP" if direction == "exp" else "IMP"
    url = f"{MDIC_BASE}/{prefix}_{year}.csv"
    print(f"  Baixando: {prefix}_{year}.csv ...")
    try:
        resp = requests.get(url, verify=False, timeout=300, headers=_UA, stream=True)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"    ERRO ao baixar {url}: {e}")
        return None

    sh6set = {str(s).zfill(6) for s in sh6_prefixes}
    usecols = ["CO_ANO", "CO_MES", "CO_NCM", "CO_PAIS", "CO_URF", "KG_LIQUIDO", "VL_FOB"]
    chunks = []
    try:
        for chunk in pd.read_csv(io.StringIO(resp.content.decode("latin-1", errors="replace")),
                                 sep=";", dtype=str, usecols=usecols,
                                 chunksize=150_000, low_memory=False):
            chunk["CO_NCM"] = chunk["CO_NCM"].str.strip().str.zfill(8)
            f = chunk[chunk["CO_NCM"].str[:6].isin(sh6set)]
            if len(f):
                chunks.append(f)
    except Exception as e:
        print(f"    ERRO ao parsear {url}: {e}")
        return None
    if not chunks:
        print(f"    Nenhuma linha p/ os SH6 pedidos em {prefix}_{year}.csv")
        return None

    df = pd.concat(chunks, ignore_index=True)
    df["period"]  = df["CO_ANO"].str.strip() + "-" + df["CO_MES"].str.strip().str.zfill(2)
    df["sh6"]     = df["CO_NCM"].str[:6]
    df["country"] = (df["CO_PAIS"].str.strip().str.zfill(3).map(pais_map).fillna("Outros")
                     if pais_map else "")
    df["port"]    = (df["CO_URF"].str.strip().str.zfill(7).map(port_map).fillna("Outros")
                     if port_map else "")
    df["kg"]      = pd.to_numeric(df["KG_LIQUIDO"], errors="coerce").fillna(0)
    df["usd"]     = pd.to_numeric(df["VL_FOB"], errors="coerce").fillna(0)
    df["ncm"]     = df["CO_NCM"]
    print(f"    {len(df):,} linhas | períodos: {df['period'].min()} a {df['period'].max()}")
    return df[["period", "ncm", "sh6", "country", "port", "kg", "usd"]]
