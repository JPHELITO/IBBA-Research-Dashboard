#!/usr/bin/env python3
"""
update_korea.py — Exportações de aço da COREIA p/ o BRASIL (parte Coreia da LINHA PRETA).

Fonte: API OFICIAL da Aduana Coreana (Korea Customs Service) via data.go.kr —
`getNitemtradeList` (품목별 국가별 수출입실적 = HS × país × mês, em US$, exp + imp).
Roda 100% na nuvem (GitHub Actions): REST/XML, sem navegador, sem IP coreano.

Chave GRÁTIS (env KOREA_SERVICE_KEY): cadastrar em
  https://www.data.go.kr/data/15100475/openapi.do  → "활용신청" (aprovação imediata, 1000 req/dia).

Grava country='Korea' em pred_exports (steel_sm.db); product = subcategoria do dicionário
(HRC/CRC/Coated/...), SOMENTE os SH6 marcados ANTIDUMPING (consistente com a linha laranja).

Modos:
  python update_korea.py --check                  # último período no DB vs API (precisa de chave)
  python update_korea.py --update [--force]        # puxa meses novos -> pred_exports (Korea)
  python update_korea.py --backfill [--start-year YYYY]
  python update_korea.py --selftest                # valida o parser de XML offline (sem chave/rede)
"""
import argparse
import os
import sqlite3
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("Faltando dependência: pip install requests")

HERE = Path(__file__).parent
DB_PATH = Path(os.environ.get("SECEX_DB") or (HERE / "steel_sm.db"))
sys.path.insert(0, str(HERE.parent / "_shared"))
import dictionary as _dict  # noqa: E402

NOW = datetime.utcnow().isoformat()
SERVICE_KEY = os.environ.get("KOREA_SERVICE_KEY", "").strip()
ENDPOINT = "https://apis.data.go.kr/1220000/nitemtrade/getNitemtradeList"
CNTY_BR  = "BR"          # parceiro Brasil (ISO-2 na API coreana)
HS_CHAPTER_STEEL = "72"  # 1 chamada/janela pega todo o cap. 72; filtramos p/ os SH6 antidumping
PAGE_ROWS = 1000
AD_SH6 = _dict.antidumping_sh6_set()
DEFAULT_START_YEAR = datetime.utcnow().year - 8


def _subcat(sh6: str) -> str:
    return _dict.sh6_subcategory(str(sh6).zfill(6), "steel") or "other"


def _ym_windows(start_ym: str, end_ym: str, span: int = 12):
    """Janelas [(strtYymm,endYymm)] de <=span meses (limite da API coreana)."""
    sy, sm = map(int, start_ym.split("-"))
    ey, em = map(int, end_ym.split("-"))
    cur = sy * 12 + (sm - 1)
    end = ey * 12 + (em - 1)
    out = []
    while cur <= end:
        a = cur
        b = min(cur + span - 1, end)
        out.append((f"{a // 12}{a % 12 + 1:02d}", f"{b // 12}{b % 12 + 1:02d}"))
        cur = b + 1
    return out


def _parse_items(xml_text: str):
    """Extrai <item> da resposta data.go.kr; retorna lista de dicts (tags->texto)."""
    root = ET.fromstring(xml_text)
    items = []
    for it in root.iter("item"):
        items.append({c.tag: (c.text or "").strip() for c in it})
    return items


def _fetch(strt: str, end: str, page: int = 1) -> tuple:
    """Uma página da API. Retorna (items, total_count). Levanta em erro de auth/rede."""
    params = {
        "serviceKey": SERVICE_KEY,
        "strtYymm": strt, "endYymm": end,
        "hsSgn": HS_CHAPTER_STEEL, "cntyCd": CNTY_BR,
        "pageNo": page, "numOfRows": PAGE_ROWS,
    }
    r = requests.get(ENDPOINT, params=params, timeout=90, headers={"User-Agent": "Mozilla/5.0"})
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:160]}")
    txt = r.text
    if "SERVICE_KEY" in txt or "Unauthorized" in txt or "<errMsg>" in txt:
        raise RuntimeError(f"Erro de chave/serviço: {txt[:200]}")
    items = _parse_items(txt)
    # total count (p/ paginação)
    try:
        total = int(ET.fromstring(txt).find(".//totalCount").text)
    except Exception:
        total = len(items)
    return items, total


def fetch_korea(start_ym: str, end_ym: str) -> dict:
    """Coreia → Brasil (cap. 72), filtra SH6 antidumping; agrega por
    (period 'YYYY-MM','Korea',product). value_usd=expDlr, volume_kg=expWgt."""
    if not SERVICE_KEY:
        raise SystemExit("KOREA_SERVICE_KEY não definido. Cadastre uma chave grátis no data.go.kr.")
    agg = {}
    for strt, end in _ym_windows(start_ym, end_ym):
        page, seen, total = 1, 0, None
        while True:
            items, total = _fetch(strt, end, page)
            for d in items:
                hs = (d.get("hsCd") or "").strip()
                sh6 = hs[:6]
                if sh6 not in AD_SH6:
                    continue
                yr = (d.get("year") or "").replace(".", "-")[:7]   # '2024.01' -> '2024-01'
                if len(yr) != 7:
                    continue
                usd = float(d.get("expDlr") or 0)
                kg  = float(d.get("expWgt") or 0)
                if usd == 0 and kg == 0:
                    continue
                k = (yr, "Korea", _subcat(sh6))
                a = agg.setdefault(k, [0.0, 0.0])
                a[0] += usd
                a[1] += kg
            seen += len(items)
            if not items or seen >= (total or 0):
                break
            page += 1
            time.sleep(0.3)
        print(f"  [Korea API] {strt}-{end}: {seen} linhas brutas")
        time.sleep(0.3)
    return agg


def ensure_table(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS pred_exports (
        period TEXT, country TEXT, product TEXT, value_usd REAL, volume_kg REAL, updated_at TEXT,
        PRIMARY KEY (period, country, product))""")
    conn.commit()


def upsert_korea(conn, rows):
    conn.executemany(
        "INSERT OR REPLACE INTO pred_exports "
        "(period,country,product,value_usd,volume_kg,updated_at) VALUES (?,?,?,?,?,?)", rows)
    conn.commit()


def latest_korea(conn):
    row = conn.execute("SELECT MAX(period) FROM pred_exports WHERE country='Korea'").fetchone()
    return row[0] if row and row[0] else None


def _write_gh_env(new_data, period):
    gh = os.environ.get("GITHUB_ENV")
    if not gh:
        return
    with open(gh, "a") as f:
        f.write(f"KOREA_NEW_DATA={new_data}\n")
        if period:
            f.write(f"KOREA_LATEST={period}\n")


SAMPLE_XML = """<response><body><items>
<item><year>2025.03</year><hsCd>7208390000</hsCd><statCdCntnKor1>브라질</statCdCntnKor1>
<statCd>BR</statCd><expWgt>1000000</expWgt><expDlr>650000</expDlr><impWgt>0</impWgt><impDlr>0</impDlr></item>
<item><year>2025.03</year><hsCd>7209160000</hsCd><statCd>BR</statCd>
<expWgt>500000</expWgt><expDlr>400000</expDlr><impWgt>0</impWgt><impDlr>0</impDlr></item>
</items><totalCount>2</totalCount></body></response>"""


def selftest():
    items = _parse_items(SAMPLE_XML)
    assert len(items) == 2, items
    # 7208390000 -> sh6 720839 (antidumping HRC); 7209160000 -> 720916 (antidumping CRC)
    agg = {}
    for d in items:
        sh6 = d["hsCd"][:6]
        if sh6 not in AD_SH6:
            continue
        k = (d["year"].replace(".", "-"), "Korea", _subcat(sh6))
        a = agg.setdefault(k, [0.0, 0.0]); a[0] += float(d["expDlr"]); a[1] += float(d["expWgt"])
    print("selftest agg:", agg)
    assert ("2025-03", "Korea", "HRC") in agg, "720839 deveria mapear p/ HRC antidumping"
    assert ("2025-03", "Korea", "CRC") in agg, "720916 deveria mapear p/ CRC antidumping"
    print("SELFTEST OK — parser + classificação antidumping/subcategoria funcionando.")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="pred_exports (Coreia) via data.go.kr getNitemtradeList")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--update", action="store_true")
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--start-year", type=int, default=DEFAULT_START_YEAR)
    args = ap.parse_args()

    if args.selftest:
        selftest()
        return

    if not SERVICE_KEY:
        print("KOREA_SERVICE_KEY ausente — Coreia segue MANUAL (decisão 2026-06-19). Pulando sem erro.")
        _write_gh_env("false", None)
        return

    now = datetime.utcnow()
    cur_ym = f"{now.year}-{now.month:02d}"
    print(f"DB: {DB_PATH} | chave: {'sim' if SERVICE_KEY else 'NÃO'} | {len(AD_SH6)} SH6 antidumping")

    conn = sqlite3.connect(DB_PATH)
    ensure_table(conn)
    latest = latest_korea(conn)
    print(f"Último período Coreia em pred_exports: {latest or '—'}")

    if args.check:
        agg = fetch_korea(cur_ym if latest is None else latest, cur_ym)
        print(f"Disponível na API (sonda {latest or cur_ym}..{cur_ym}): {max((k[0] for k in agg), default='—')}")
        conn.close()
        return

    if args.backfill or latest is None:
        start_ym = f"{args.start_year}-01"
        print(f"[BACKFILL] Coreia de {start_ym} até {cur_ym}...")
        conn.execute("DELETE FROM pred_exports WHERE country='Korea'")
        conn.commit()
        agg = fetch_korea(start_ym, cur_ym)
    elif args.update:
        if args.force:
            start_ym = f"{args.start_year}-01"
        else:
            ly, lm = map(int, latest.split("-")); lm += 1
            if lm > 12:
                lm, ly = 1, ly + 1
            start_ym = f"{ly}-{lm:02d}"
        if start_ym > cur_ym:
            print("Nada a buscar.")
            _write_gh_env("false", None); conn.close(); return
        print(f"[UPDATE] Coreia de {start_ym} até {cur_ym}...")
        agg = fetch_korea(start_ym, cur_ym)
    else:
        print("Use --check, --update, --backfill ou --selftest."); conn.close(); return

    rows = [(p, c, prod, round(v[0], 2), round(v[1], 2), NOW) for (p, c, prod), v in agg.items()]
    if rows:
        upsert_korea(conn, rows)
        new_latest = max(k[0] for k in agg)
        new = bool(latest is None or new_latest > latest or args.force or args.backfill)
        print(f"  pred_exports[Korea]: {len(rows)} linhas | até {new_latest}")
        _write_gh_env("true" if new else "false", new_latest if new else None)
    else:
        print("  API não retornou dados novos.")
        _write_gh_env("false", None)
    conn.close()
    print("Concluído.")


if __name__ == "__main__":
    main()
