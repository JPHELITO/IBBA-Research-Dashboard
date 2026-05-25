#!/usr/bin/env python3
"""
extractor_sm.py — Steel & Mining Dashboard Extractor
=====================================================
Reads source Excel files → populates steel_sm.db (SQLite).

DATA SOURCES
  • IABr  — Brazilian Steel Market Data (.xlsm)
  • SECEX — Steel Foreign Trade Exports (.xlsx)
  • SECEX — Steel Foreign Trade Imports (.xlsx)
  • INDA  — Flat Steel Distributor Data (.xlsm)
  • SECEX — Prediction Analysis / Korea-China CRC-HRC (.xlsx)

USAGE
  pip install pandas openpyxl
  python extractor_sm.py
  python extractor_sm.py --iabr PATH --exp PATH --imp PATH --inda PATH --pred PATH
"""

import sqlite3, sys, argparse
from pathlib import Path
from datetime import datetime

try:
    import pandas as pd
    import openpyxl
except ImportError:
    sys.exit("Missing: pip install pandas openpyxl")

# ── Paths ──────────────────────────────────────────────────────────────────────
HERE      = Path(__file__).parent
DB_PATH   = HERE / "steel_sm.db"
DOWNLOADS = Path.home() / "Downloads"

DEFAULT_IABR = DOWNLOADS / "IABR - Brazilian Steel Market Data.xlsm"
DEFAULT_EXP  = DOWNLOADS / "SECEX - Steel Foreign Trade_Exports.xlsx"
DEFAULT_IMP  = DOWNLOADS / "SECEX - Steel Foreign Trade_Imports.xlsx"
DEFAULT_INDA = DOWNLOADS / "INDA - Flat Steel Distributor Data.xlsm"
DEFAULT_PRED = DOWNLOADS / "SECEX - Prediction Analysis.xlsx"

NOW = datetime.utcnow().isoformat()


# ══════════════════════════════════════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════════════════════════════════════
def _safe_float(v):
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None

def _period(dt):
    """Convert datetime-like → 'YYYY-MM' string."""
    if isinstance(dt, datetime):
        return dt.strftime("%Y-%m")
    if hasattr(dt, 'strftime'):
        return dt.strftime("%Y-%m")
    s = str(dt)[:7]
    return s if len(s) == 7 else None


# ══════════════════════════════════════════════════════════════════════════════
# DATABASE INIT
# ══════════════════════════════════════════════════════════════════════════════
def init_db(conn):
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS iabr_production (
        period     TEXT PRIMARY KEY,
        year       INTEGER, month INTEGER,
        crude_steel REAL, flat REAL, long_prod REAL,
        semi REAL, slabs REAL, billets REAL, pig_iron REAL,
        updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS iabr_domestic_sales (
        period TEXT PRIMARY KEY,
        year INTEGER, month INTEGER,
        total REAL, flat REAL, long_prod REAL, semi REAL,
        updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS iabr_foreign_market (
        period TEXT PRIMARY KEY,
        year INTEGER, month INTEGER,
        total REAL, flat REAL, long_prod REAL, semi REAL,
        updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS iabr_exports (
        period TEXT PRIMARY KEY,
        year INTEGER, month INTEGER,
        flat_ktons REAL, long_ktons REAL, semi_ktons REAL,
        total_ktons REAL, total_usd_mn REAL,
        updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS iabr_imports (
        period TEXT PRIMARY KEY,
        year INTEGER, month INTEGER,
        flat_ktons REAL, long_ktons REAL, semi_ktons REAL,
        total_ktons REAL, total_usd_mn REAL,
        updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS iabr_consumption (
        period TEXT PRIMARY KEY,
        year INTEGER, month INTEGER,
        total REAL, flat REAL, long_prod REAL,
        updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS secex_exports (
        period   TEXT,
        category TEXT,
        revenue_usd_mn REAL, volume_ktons REAL,
        price_usd_ton  REAL, working_days INTEGER,
        yoy_revenue REAL,   yoy_volume REAL,
        updated_at TEXT,
        PRIMARY KEY (period, category)
    );
    CREATE TABLE IF NOT EXISTS secex_imports (
        period   TEXT,
        category TEXT,
        revenue_usd_mn REAL, volume_ktons REAL,
        price_usd_ton  REAL, working_days INTEGER,
        yoy_revenue REAL,   yoy_volume REAL,
        updated_at TEXT,
        PRIMARY KEY (period, category)
    );
    CREATE TABLE IF NOT EXISTS inda_distribution (
        period TEXT PRIMARY KEY,
        year INTEGER, month INTEGER,
        inventories REAL, inv_months REAL,
        purchases REAL, sales REAL,
        working_days INTEGER, inv_yoy REAL,
        hist_avg REAL, sales_ltm REAL, sales_ma3 REAL,
        updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS import_prediction (
        period  TEXT,
        product TEXT,
        country TEXT,
        value_usd REAL,
        volume_kg REAL,
        updated_at TEXT,
        PRIMARY KEY (period, product, country)
    );
    """)
    conn.commit()


# ══════════════════════════════════════════════════════════════════════════════
# IABr PARSER (DATABASE sheet — transposed: dates as columns, metrics as rows)
# ══════════════════════════════════════════════════════════════════════════════

# Excel row index (1-based) → field meaning
# Determined from: python -c "... print all row labels"
IABR_ROW_FIELDS = {
    3:  ('prod', 'crude_steel'),
    5:  ('prod', 'flat'),
    6:  ('prod', 'long_prod'),
    7:  ('prod', 'semi'),
    8:  ('prod', 'slabs'),
    9:  ('prod', 'billets'),
    10: ('prod', 'pig_iron'),
    13: ('dom',  'flat'),
    14: ('dom',  'long_prod'),
    15: ('dom',  'semi'),
    20: ('for',  'flat'),
    21: ('for',  'long_prod'),
    22: ('for',  'semi'),
    28: ('exp',  'flat_ktons'),
    29: ('exp',  'long_ktons'),
    30: ('exp',  'semi_ktons'),
    33: ('exp',  'total_ktons'),
    34: ('exp',  'total_usd_mn'),
    37: ('imp',  'flat_ktons'),
    38: ('imp',  'long_ktons'),
    39: ('imp',  'semi_ktons'),
    40: ('imp',  'total_ktons'),
    41: ('imp',  'total_usd_mn'),
    42: ('cons', 'total'),
    43: ('cons', 'flat'),
    44: ('cons', 'long_prod'),
}

def load_iabr(path, conn):
    print(f"\n[IABr] Loading {path.name} ...")
    wb = openpyxl.load_workbook(path, data_only=True, keep_vba=True)
    ws = wb['DATABASE']

    all_rows = list(ws.iter_rows(values_only=True))
    if not all_rows:
        print("  [IABr] Empty sheet — skipping.")
        wb.close()
        return

    # Row 0 (Excel row 1) = date headers starting from column B (index 1)
    date_row = all_rows[0]
    dates = []  # list of (col_index, period_str, year, month)
    for ci, cell in enumerate(date_row):
        p = _period(cell)
        if p:
            try:
                dt = datetime.strptime(p, "%Y-%m")
                dates.append((ci, p, dt.year, dt.month))
            except ValueError:
                pass

    print(f"  [IABr] {len(dates)} date columns ({dates[0][1]} to {dates[-1][1]})")

    # Extract metric values per date column
    # data[period] = {field: value}
    data = {p: {'year': y, 'month': m} for (_, p, y, m) in dates}
    col_to_period = {ci: p for (ci, p, _, _) in dates}

    for row_idx_0, row in enumerate(all_rows):
        excel_row = row_idx_0 + 1
        if excel_row not in IABR_ROW_FIELDS:
            continue
        section, field = IABR_ROW_FIELDS[excel_row]
        key = f"{section}_{field}"
        for ci, period in col_to_period.items():
            val = _safe_float(row[ci])
            data[period][key] = val

    wb.close()

    # Insert into tables
    prod_rows, dom_rows, for_rows, exp_rows, imp_rows, cons_rows = [], [], [], [], [], []
    for period, d in sorted(data.items()):
        y, m = d.get('year'), d.get('month')
        # Domestic total = dom flat + dom long + dom semi (rolled products)
        dom_flat = d.get('dom_flat'); dom_long = d.get('dom_long'); dom_semi = d.get('dom_semi')
        dom_total = None
        if dom_flat is not None and dom_long is not None and dom_semi is not None:
            dom_total = dom_flat + dom_long + dom_semi

        for_flat = d.get('for_flat'); for_long = d.get('for_long'); for_semi = d.get('for_semi')
        for_total = None
        if for_flat is not None and for_long is not None and for_semi is not None:
            for_total = for_flat + for_long + for_semi

        prod_rows.append((
            period, y, m,
            d.get('prod_crude_steel'), d.get('prod_flat'), d.get('prod_long_prod'),
            d.get('prod_semi'), d.get('prod_slabs'), d.get('prod_billets'),
            d.get('prod_pig_iron'), NOW
        ))
        dom_rows.append((period, y, m, dom_total, dom_flat, dom_long, dom_semi, NOW))
        for_rows.append((period, y, m, for_total, for_flat, for_long, for_semi, NOW))
        exp_rows.append((
            period, y, m,
            d.get('exp_flat_ktons'), d.get('exp_long_ktons'), d.get('exp_semi_ktons'),
            d.get('exp_total_ktons'), d.get('exp_total_usd_mn'), NOW
        ))
        imp_rows.append((
            period, y, m,
            d.get('imp_flat_ktons'), d.get('imp_long_ktons'), d.get('imp_semi_ktons'),
            d.get('imp_total_ktons'), d.get('imp_total_usd_mn'), NOW
        ))
        cons_rows.append((period, y, m, d.get('cons_total'), d.get('cons_flat'), d.get('cons_long_prod'), NOW))

    conn.executemany("INSERT OR REPLACE INTO iabr_production VALUES (?,?,?,?,?,?,?,?,?,?,?)", prod_rows)
    conn.executemany("INSERT OR REPLACE INTO iabr_domestic_sales VALUES (?,?,?,?,?,?,?,?)", dom_rows)
    conn.executemany("INSERT OR REPLACE INTO iabr_foreign_market VALUES (?,?,?,?,?,?,?,?)", for_rows)
    conn.executemany("INSERT OR REPLACE INTO iabr_exports VALUES (?,?,?,?,?,?,?,?,?)", exp_rows)
    conn.executemany("INSERT OR REPLACE INTO iabr_imports VALUES (?,?,?,?,?,?,?,?,?)", imp_rows)
    conn.executemany("INSERT OR REPLACE INTO iabr_consumption VALUES (?,?,?,?,?,?,?)", cons_rows)
    conn.commit()
    print(f"  [IABr] {len(prod_rows)} months loaded into all IABr tables.")


# ══════════════════════════════════════════════════════════════════════════════
# SECEX EXPORTS / IMPORTS PARSER
# Sheets: SECEX INPUT FLAT / LONGS / SEMI / TOTAL
# Layout: headers at rows 5-6, data from row 7 onwards
# Monthly columns (0-indexed from sheet): 2=Date 3=Rev 4=Vol 5=Price 6=WDays 7=YoYRev 8=YoYVol
# ══════════════════════════════════════════════════════════════════════════════
SECEX_SHEETS = {
    'SECEX INPUT FLAT':  'flat',
    'SECEX INPUT LONGS': 'long',
    'SECEX INPUT SEMI':  'semi',
    'SECEX INPUT TOTAL': 'total',
}

def _parse_secex_sheet(xl, sheet_name, category, table, conn):
    if sheet_name not in xl.sheet_names:
        print(f"    Sheet '{sheet_name}' not found — skipping.")
        return 0

    df = xl.parse(sheet_name, header=None)

    # Find the data header row by looking for a 'Date' cell in col 2
    data_start = None
    for i, row in df.iterrows():
        v = str(row.iloc[2]) if len(row) > 2 else ''
        if 'date' in v.lower() or '1999' in v or '2000' in v:
            # skip — look for actual data rows
            pass
        try:
            if row.iloc[2] is not None and 'date' not in str(row.iloc[2]).lower():
                # Try to parse as date
                dt = pd.to_datetime(row.iloc[2], errors='coerce')
                if dt is not None and not pd.isnull(dt) and dt.year >= 1999:
                    data_start = i
                    break
        except Exception:
            pass

    if data_start is None:
        print(f"    Could not find data in {sheet_name}")
        return 0

    rows_out = []
    for i in range(data_start, len(df)):
        row = df.iloc[i]
        try:
            dt = pd.to_datetime(row.iloc[2], errors='coerce')
            if pd.isnull(dt) or dt.year < 1999 or dt.year > 2030:
                continue
            period = dt.strftime("%Y-%m")
            rev    = _safe_float(row.iloc[3])
            vol    = _safe_float(row.iloc[4])
            price  = _safe_float(row.iloc[5])
            wdays  = _safe_float(row.iloc[6])
            yoy_r  = _safe_float(row.iloc[7])
            yoy_v  = _safe_float(row.iloc[8])
            if rev is None and vol is None:
                continue
            rows_out.append((period, category, rev, vol, price,
                             int(wdays) if wdays is not None else None,
                             yoy_r, yoy_v, NOW))
        except Exception:
            continue

    conn.executemany(
        f"INSERT OR REPLACE INTO {table} "
        "(period,category,revenue_usd_mn,volume_ktons,price_usd_ton,"
        "working_days,yoy_revenue,yoy_volume,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        rows_out
    )
    conn.commit()
    return len(rows_out)

def load_secex(path, table, label, conn):
    print(f"\n[SECEX {label}] Loading {path.name} ...")
    xl = pd.ExcelFile(path, engine='openpyxl')
    total = 0
    for sheet_name, category in SECEX_SHEETS.items():
        n = _parse_secex_sheet(xl, sheet_name, category, table, conn)
        print(f"  {sheet_name:25s}: {n} rows ({category})")
        total += n
    print(f"  [SECEX {label}] Total: {total} rows")


# ══════════════════════════════════════════════════════════════════════════════
# INDA PARSER (CHART DATA sheet)
# Columns (0-indexed): 3=Date 6=Inventories 7=InvMonths 8=Purchases 9=Sales
#                      10=InvYoY 11=HistAvg 12=SalesLTM 13=SalesWK 14=SalesMA3
# ══════════════════════════════════════════════════════════════════════════════
def load_inda(path, conn):
    print(f"\n[INDA] Loading {path.name} ...")
    wb = openpyxl.load_workbook(path, data_only=True, keep_vba=True)
    ws = wb['CHART DATA']

    # Find header row by looking for 'Date' in col D (index 3)
    rows = list(ws.iter_rows(values_only=True))
    data_start = None
    for i, row in enumerate(rows):
        if len(row) > 3 and str(row[3]).strip().lower() == 'date':
            data_start = i + 1
            break

    if data_start is None:
        print("  [INDA] Header not found.")
        wb.close()
        return

    out = []
    for row in rows[data_start:]:
        try:
            dt = row[3]
            if dt is None:
                continue
            if not isinstance(dt, datetime) and not hasattr(dt, 'year'):
                try:
                    dt = datetime.strptime(str(dt)[:10], "%Y-%m-%d")
                except Exception:
                    continue
            p = _period(dt)
            if not p:
                continue
            inv    = _safe_float(row[6])
            inv_mo = _safe_float(row[7])
            purch  = _safe_float(row[8])
            sales  = _safe_float(row[9])
            inv_yy = _safe_float(row[10])
            hist   = _safe_float(row[11])
            ltm    = _safe_float(row[12])
            swk    = _safe_float(row[13])
            ma3    = _safe_float(row[14])
            wdays_raw = _safe_float(row[4]) if len(row) > 4 else None  # subtractor proxy
            if inv is None and purch is None and sales is None:
                continue
            dt2 = datetime.strptime(p, "%Y-%m")
            out.append((p, dt2.year, dt2.month, inv, inv_mo, purch, sales,
                        None, inv_yy, hist, ltm, ma3, NOW))
        except Exception:
            continue

    conn.executemany(
        "INSERT OR REPLACE INTO inda_distribution "
        "(period,year,month,inventories,inv_months,purchases,sales,"
        "working_days,inv_yoy,hist_avg,sales_ltm,sales_ma3,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        out
    )
    conn.commit()
    wb.close()
    print(f"  [INDA] {len(out)} months loaded.")


# ══════════════════════════════════════════════════════════════════════════════
# PREDICTION PARSER (SECEX sheet — CRC/HRC imports from Korea + China)
# Columns: Ano, Mês, NCM, Descrição, SH6, Descrição SH6, País, USD FOB, Kg, DATE, SF6, Value
# We group by DATE + product category (HRC / CRC / Other) + country
# HRC NCMs (SH6 prefix 7208): hot-rolled coil/sheet
# CRC NCMs (SH6 prefix 7209): cold-rolled coil/sheet
# ══════════════════════════════════════════════════════════════════════════════
HRC_SH6_PREFIXES = ('720827', '720837', '720838', '720839', '720851',
                    '720852', '720853', '720854', '720890', '722530',
                    '722540', '722550', '722591', '722599')
CRC_SH6_PREFIXES = ('720916', '720917', '720918', '720915', '720912',
                    '720919', '722610', '722620', '722692', '721049',
                    '721030', '721070', '721061')

def _classify_sh6(sh6):
    s = str(sh6).strip()
    if any(s.startswith(p[:4]) for p in HRC_SH6_PREFIXES):
        return 'HRC'
    if any(s.startswith(p[:4]) for p in CRC_SH6_PREFIXES):
        return 'CRC'
    return 'OTHER'

def _classify_country(country):
    c = str(country).lower()
    if 'coreia' in c or 'korea' in c:
        return 'Korea'
    if 'china' in c or 'chin' in c:
        return 'China'
    return 'Other'

def load_prediction(path, conn):
    print(f"\n[PRED] Loading {path.name} ...")
    xl = pd.ExcelFile(path, engine='openpyxl')
    if 'SECEX' not in xl.sheet_names:
        print("  [PRED] SECEX sheet not found.")
        return

    df = xl.parse('SECEX', header=0)
    # Cols: Ano, Mês, Código NCM, Descrição NCM, Código SH6, Descrição SH6,
    #       Países, Valor US$ FOB, Quilograma Líquido, DATE, SF6, Value
    df.columns = [str(c).strip() for c in df.columns]

    # Use the DATE column for period
    date_col = 'DATE'
    usd_col  = 'Valor US$ FOB'
    kg_col   = 'Quilograma Líquido'
    sh6_col  = 'Código SH6'
    country_col = 'Países'

    agg = {}
    for _, row in df.iterrows():
        try:
            dt = pd.to_datetime(row[date_col], errors='coerce')
            if pd.isnull(dt):
                continue
            period  = dt.strftime("%Y-%m")
            product = _classify_sh6(row[sh6_col])
            country = _classify_country(row[country_col])
            usd = _safe_float(row[usd_col]) or 0
            kg  = _safe_float(row[kg_col])  or 0
            key = (period, product, country)
            if key not in agg:
                agg[key] = [0.0, 0.0]
            agg[key][0] += usd
            agg[key][1] += kg
        except Exception:
            continue

    out = [(p, prod, ctry, v[0], v[1], NOW)
           for (p, prod, ctry), v in agg.items()]
    conn.executemany(
        "INSERT OR REPLACE INTO import_prediction "
        "(period,product,country,value_usd,volume_kg,updated_at) VALUES (?,?,?,?,?,?)",
        out
    )
    conn.commit()
    print(f"  [PRED] {len(out)} period×product×country rows loaded.")


# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════
def main():
    parser = argparse.ArgumentParser(description="Steel & Mining DB Extractor")
    parser.add_argument('--iabr', default=str(DEFAULT_IABR))
    parser.add_argument('--exp',  default=str(DEFAULT_EXP))
    parser.add_argument('--imp',  default=str(DEFAULT_IMP))
    parser.add_argument('--inda', default=str(DEFAULT_INDA))
    parser.add_argument('--pred', default=str(DEFAULT_PRED))
    args = parser.parse_args()

    conn = sqlite3.connect(DB_PATH)
    init_db(conn)
    print(f"Database: {DB_PATH}")

    iabr = Path(args.iabr)
    exp  = Path(args.exp)
    imp  = Path(args.imp)
    inda = Path(args.inda)
    pred = Path(args.pred)

    if iabr.exists():
        load_iabr(iabr, conn)
    else:
        print(f"\n[IABr] File not found: {iabr}")

    if exp.exists():
        load_secex(exp, 'secex_exports', 'EXP', conn)
    else:
        print(f"\n[SECEX EXP] File not found: {exp}")

    if imp.exists():
        load_secex(imp, 'secex_imports', 'IMP', conn)
    else:
        print(f"\n[SECEX IMP] File not found: {imp}")

    if inda.exists():
        load_inda(inda, conn)
    else:
        print(f"\n[INDA] File not found: {inda}")

    if pred.exists():
        load_prediction(pred, conn)
    else:
        print(f"\n[PRED] File not found: {pred}")

    conn.close()
    print("\nDone.")

if __name__ == '__main__':
    main()
