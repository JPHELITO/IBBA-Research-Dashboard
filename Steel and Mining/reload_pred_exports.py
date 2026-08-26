#!/usr/bin/env python3
"""
reload_pred_exports.py — recarrega a LINHA PRETA (pred_exports) do Excel-mestre
"SECEX - Prediction Analysis.xlsx" (abas KOREA e CHINA), classificando os códigos
pelo DICIONÁRIO (a MESMA base da linha laranja import_prediction):
  - mantém SÓ os SH6 marcados ANTIDUMPING (mesmo universo da laranja);
  - product = subcategoria do dicionário (HRC / CRC / Coated / Wire Rod).

Assim as DUAS linhas do modelo ficam SEMPRE nos mesmos códigos (regra "NUNCA
comparar códigos diferentes" cumprida por construção). NÃO toca em import_prediction.

Diferença vs. o extractor antigo: o `_classify_sh6` chumbado só conhecia HRC/CRC e
descartava Coated/Wire Rod como "OTHER". O seu Excel JÁ TEM esses códigos — eles só
estavam sendo jogados fora na importação.

Colunas das abas (0-indexadas, iguais às que o extractor_sm.py já usa e funcionam):
  KOREA: 3=País destino (filtra =='Brazil'), 11=DATE, 12=SF6 (código), 13=Valor (US$ mil), 14=Volume (ton)
  CHINA: (tudo já Brasil)                      11=DATE, 12=SF6 (código), 13=Valor (US$),    14=Volume (kg)

Uso:
  python reload_pred_exports.py --dry-run                 # só relata, não grava
  python reload_pred_exports.py                           # recarrega pred_exports
  python reload_pred_exports.py --pred "C:/caminho/arquivo.xlsx"
  SECEX_DB=/tmp/copia.db python reload_pred_exports.py    # testar numa CÓPIA do banco
"""
import argparse
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

try:
    import pandas as pd
except ImportError:
    sys.exit("Faltando dependência: pip install pandas openpyxl")

HERE = Path(__file__).parent
DB_PATH = Path(os.environ.get("SECEX_DB") or (HERE / "steel_sm.db"))
sys.path.insert(0, str(HERE.parent / "_shared"))
import dictionary as _dict  # noqa: E402

def _achar_excel_mestre():
    """
    Excel-mestre mais RECENTE no Downloads.

    O navegador renomeia o download repetido p/ "... (1).xlsx", "... (3).xlsx" — e o
    caminho fixo antigo ("SECEX - Prediction Analysis.xlsx") passava a apontar p/ uma
    cópia velha, ou p/ nada. Pegar o mais novo que casa com o padrão resolve; o --pred
    continua mandando mais que isso.
    """
    import glob
    achados = [Path(p) for p in glob.glob(str(Path.home() / "Downloads" /
                                              "SECEX - Prediction Analysis*.xlsx"))
               if not Path(p).name.startswith("~$")]
    if not achados:
        return Path.home() / "Downloads" / "SECEX - Prediction Analysis.xlsx"
    return max(achados, key=lambda p: p.stat().st_mtime)


DEFAULT_PRED = _achar_excel_mestre()
AD_SH6 = _dict.antidumping_sh6_set()
NOW = datetime.utcnow().isoformat()

# (aba, país, col_filtro_brasil, mult_valor, mult_volume)
SHEETS = [
    ("KOREA", "Korea", 3, 1000.0, 1000.0),   # valor US$ mil -> US$; volume ton -> kg
    ("CHINA", "China", None, 1.0, 1.0),        # já em US$ e kg
]
COL_DATE, COL_SH6, COL_VAL, COL_VOL = 11, 12, 13, 14


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def _sh6(v):
    """Normaliza o código p/ SH6 de 6 dígitos (ex.: 7208390000 -> '720839')."""
    try:
        return str(int(str(v).strip().split(".")[0]))[:6].zfill(6)
    except (TypeError, ValueError):
        return ""


def load_sheet(xl, sheet, country, brazil_col, vmult, volmult):
    if sheet not in xl.sheet_names:
        print(f"  [{sheet}] aba não encontrada — pulando.")
        return [], {}
    df = xl.parse(sheet, header=0)
    agg = {}
    used = off_ad = no_sub = brazil_skip = 0
    for _, row in df.iterrows():
        try:
            if brazil_col is not None:
                dest = str(row.iloc[brazil_col] if not pd.isnull(row.iloc[brazil_col]) else "").strip()
                if dest.lower() != "brazil":
                    brazil_skip += 1
                    continue
            dt = pd.to_datetime(row.iloc[COL_DATE], errors="coerce")
            if pd.isnull(dt):
                continue
            period = dt.strftime("%Y-%m")
            sh6 = _sh6(row.iloc[COL_SH6])
            if sh6 not in AD_SH6:          # mesmo universo da laranja
                off_ad += 1
                continue
            product = _dict.sh6_subcategory(sh6, "steel")
            if not product:
                no_sub += 1
                continue
            val = _f(row.iloc[COL_VAL]) * vmult
            vol = _f(row.iloc[COL_VOL]) * volmult
            k = (period, country, product)
            a = agg.setdefault(k, [0.0, 0.0])
            a[0] += val
            a[1] += vol
            used += 1
        except Exception:
            continue
    by_prod = {}
    for (_, _, prod), v in agg.items():
        by_prod[prod] = by_prod.get(prod, 0.0) + v[1] / 1e6  # ktons p/ relatório
    print(f"  [{sheet}] {used} linhas usadas | {off_ad} fora do antidumping | "
          f"{no_sub} sem subcategoria | {brazil_skip} não-Brasil")
    rows = [(p, c, pr, round(v[0], 2), round(v[1], 2), NOW) for (p, c, pr), v in agg.items()]
    return rows, by_prod


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="Recarrega pred_exports (linha preta) via dicionário")
    ap.add_argument("--pred", default=str(DEFAULT_PRED), help="caminho do Excel-mestre")
    ap.add_argument("--dry-run", action="store_true", help="só relata; não grava")
    args = ap.parse_args()

    pred = Path(args.pred)
    if not pred.exists():
        sys.exit(f"Arquivo não encontrado: {pred}\n"
                 f"Coloque o 'SECEX - Prediction Analysis.xlsx' em Downloads ou passe --pred.")

    print(f"Excel : {pred}")
    print(f"DB    : {DB_PATH}")
    print(f"SH6 antidumping no dicionário: {len(AD_SH6)}")
    xl = pd.ExcelFile(pred, engine="openpyxl")

    all_rows, report = [], {}
    for sheet, country, bcol, vmult, volmult in SHEETS:
        rows, by_prod = load_sheet(xl, sheet, country, bcol, vmult, volmult)
        all_rows += rows
        report[country] = by_prod

    print("\nResumo (volume ktons por produto):")
    for country, by_prod in report.items():
        print(f"  {country}: " + ", ".join(f"{k}={v:.1f}" for k, v in sorted(by_prod.items())) or f"  {country}: (vazio)")

    if not all_rows:
        sys.exit("Nada para gravar — confira as abas KOREA/CHINA do Excel.")

    if args.dry_run:
        print(f"\n[DRY-RUN] {len(all_rows)} linhas seriam gravadas em pred_exports (nada gravado).")
        return

    conn = sqlite3.connect(DB_PATH)
    conn.execute("""CREATE TABLE IF NOT EXISTS pred_exports (
        period TEXT, country TEXT, product TEXT, value_usd REAL, volume_kg REAL, updated_at TEXT,
        PRIMARY KEY (period, country, product))""")
    before = conn.execute("SELECT COUNT(*), MIN(period), MAX(period) FROM pred_exports").fetchone()
    conn.execute("DELETE FROM pred_exports")
    conn.executemany(
        "INSERT OR REPLACE INTO pred_exports "
        "(period,country,product,value_usd,volume_kg,updated_at) VALUES (?,?,?,?,?,?)", all_rows)
    conn.commit()
    after = conn.execute("SELECT COUNT(*), MIN(period), MAX(period) FROM pred_exports").fetchone()
    prods = conn.execute("SELECT DISTINCT country, product FROM pred_exports ORDER BY 1,2").fetchall()
    conn.close()
    print(f"\nANTES : {before[0]} linhas ({before[1]}..{before[2]})")
    print(f"DEPOIS: {after[0]} linhas ({after[1]}..{after[2]})")
    print("(country,product):", prods)
    print("Concluído — linha preta nos mesmos códigos da laranja.")


if __name__ == "__main__":
    main()
