#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""market_watch.py — Market Watch: aluguel de ações (short interest), recompras, insiders,
free float e comunicados oficiais das empresas B3 da cobertura.

Tudo vem de fonte pública e gratuita. Nenhuma senha, nenhum login.

FONTES (medidas em 2026-09-02; endpoints e formatos documentados aqui porque nenhum
deles tem documentação oficial — foram lidos do próprio site da B3/CVM)

  1. ALUGUEL — B3 BDI (Boletim Diário), capítulo "Empréstimos de ativos"
     • API do BDI:  POST https://arquivos.b3.com.br/bdi/table/export
                    body {"Name":"BTBLendingOpenPosition","Date":d,"FinalDate":d,"ClientId":"","Filters":{}}
       - BTBLendingOpenPosition = posições em aberto (saldo em quantidade e em R$, por
         modalidade: "Neg. Eletrônica D+0", "Neg. Eletrônica D+1", "Registro", "Total")
       - BTBLoanBalance         = empréstimos registrados no dia (contratos, quantidade,
         taxas mín/média/máx do DOADOR e do TOMADOR, em fração: 0.0004 = 0,04% a.a.)
       ⚠️ A API só serve os últimos ~21 dias úteis (limitDate "D-21") — datas mais antigas
          devolvem 200 com zero linhas. O HISTÓRICO vem do PDF diário do capítulo:
     • PDF:  GET https://arquivos.b3.com.br/bdi/download/bdi/{YYYY-MM-DD}/BDI_04-2_{YYYYMMDD}.pdf
       (≈1 MB, ~100 páginas; seção "Empréstimos registrados" primeiro, "Posições em aberto"
       depois). Existe desde a reestruturação do BDI (dez/2025). Lido com PyMuPDF.
       Regras de taxa (texto da própria B3): média ponderada pela quantidade de negócios do
       dia; em dia sem negócio, repete a última taxa calculada.

  2. RECOMPRAS — CVM Dados Abertos (atualizado diariamente)
     https://dados.cvm.gov.br/dados/CIA_ABERTA/EVENTOS/RECOMPRA_ACOES/DADOS/cia_aberta_recompra_acoes.zip
     3 CSVs (latin-1, ';'): programas · quantidades por classe · intermediários (corretoras).

  3. INSIDERS — CVM Dados Abertos, "Valores Mobiliários Negociados e Detidos" (art. 11 da
     Res. CVM 44), formulário CONSOLIDADO mensal. A CVM reatualiza o arquivo do ano toda semana.
     https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/VLMO/DADOS/vlmo_cia_aberta_{ANO}.zip
     → vlmo_cia_aberta_con_{ANO}.csv: uma linha por movimentação (ou saldo) por grupo
       (Controlador, Conselho, Diretoria, Conselho Fiscal…), com data, quantidade, preço,
       volume e corretora. Reapresentação = versão maior do mesmo mês → substitui a anterior.

  4. FREE FLOAT — CVM Dados Abertos, Formulário de Referência
     https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/FRE/DADOS/fre_cia_aberta_{ANO}.zip
     → fre_cia_aberta_capital_social_*.csv (ações ON/PN do capital integralizado)
     → fre_cia_aberta_distribuicao_capital_*.csv (ações em circulação por classe + %)
     → fre_cia_aberta_distribuicao_capital_classe_acao_*.csv (PNA/PNB quando há classes)

  5. COMUNICADOS — B3 Plantão de Notícias (tempo real; é o mesmo feed que o site da B3 mostra)
     GET https://sistemasweb.b3.com.br/PlantaoNoticias/Noticias/ListarTitulosNoticias
         ?agencia=18&palavra=&dataInicial=YYYY-MM-DD&dataFinal=YYYY-MM-DD
       → JSON [{"NwsMsg":{"id":…,"dateTime":"2026-08-27 18:58:56","headline":"VALE (VALE-NM) - Outros
         Comunicados ao Mercado - 27/08/26"}}]. Traz TODAS as empresas do dia; filtramos pelo
         código entre parênteses ('VALE', 'CSNA', 'KLBN'…).
     GET …/Noticias/Detail?idNoticia={id}&agencia=18&dataNoticia={dateTime}
       → página HTML com o link do documento na CVM (frmExibirArquivoIPEExterno.aspx?ID=…).

Modos:
  python _shared/market_watch.py --short            # aluguel: últimos dias pela API do BDI
  python _shared/market_watch.py --backfill-pdf --from 2025-12-15 --to 2026-08-31   # histórico via PDF
  python _shared/market_watch.py --buybacks         # programas de recompra (CVM)
  python _shared/market_watch.py --insiders         # movimentações de insiders (CVM)
  python _shared/market_watch.py --float            # capital social + free float (CVM FRE)
  python _shared/market_watch.py --filings [--days N]   # comunicados (B3 Plantão), N dias p/ trás
  python _shared/market_watch.py --all              # tudo acima menos o backfill
  ... --dry-run   mostra o que gravaria, sem gravar        ... --date YYYY-MM-DD  (aluguel de um dia)

Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (obrigatórios p/ gravar).
Nunca sai com código != 0 por problema de dado — falha de fonte é logada e a vida segue,
como nos outros robôs (uma fonte fora do ar não pode derrubar as outras quatro).
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import sys
import zipfile

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
SUPA = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE = os.environ.get("SUPABASE_SERVICE_KEY", "")

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"}

BDI_API = "https://arquivos.b3.com.br/bdi/table/export"
BDI_PDF = "https://arquivos.b3.com.br/bdi/download/bdi/{d}/BDI_04-2_{dc}.pdf"
CVM_RECOMPRA = "https://dados.cvm.gov.br/dados/CIA_ABERTA/EVENTOS/RECOMPRA_ACOES/DADOS/cia_aberta_recompra_acoes.zip"
CVM_VLMO = "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/VLMO/DADOS/vlmo_cia_aberta_{y}.zip"
CVM_FRE = "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/FRE/DADOS/fre_cia_aberta_{y}.zip"
PLANTAO_LIST = "https://sistemasweb.b3.com.br/PlantaoNoticias/Noticias/ListarTitulosNoticias"
PLANTAO_DETAIL = "https://sistemasweb.b3.com.br/PlantaoNoticias/Noticias/Detail"

# ═══════════════════ EMPRESAS (espelho do seed de mw_companies) ══════════════════
# ticker principal → dados. `lending` = todos os códigos que a B3 lista no aluguel.
COMPANIES = {
    "VALE3":  dict(name="Vale",               cnpj="33.592.510/0001-54", b3="VALE", cls="ON",  lending=["VALE3"]),
    "CMIN3":  dict(name="CSN Mineração",      cnpj="08.902.291/0001-15", b3="CMIN", cls="ON",  lending=["CMIN3"]),
    "BRAP4":  dict(name="Bradespar",          cnpj="03.847.461/0001-92", b3="BRAP", cls="PN",  lending=["BRAP3", "BRAP4"]),
    "CSNA3":  dict(name="CSN",                cnpj="33.042.730/0001-04", b3="CSNA", cls="ON",  lending=["CSNA3"]),
    "GGBR4":  dict(name="Gerdau",             cnpj="33.611.500/0001-19", b3="GGBR", cls="PN",  lending=["GGBR3", "GGBR4"]),
    "GOAU4":  dict(name="Metalúrgica Gerdau", cnpj="92.690.783/0001-09", b3="GOAU", cls="PN",  lending=["GOAU3", "GOAU4"]),
    "USIM5":  dict(name="Usiminas",           cnpj="60.894.730/0001-05", b3="USIM", cls="PNA", lending=["USIM3", "USIM5", "USIM6"]),
    "KLBN11": dict(name="Klabin",             cnpj="89.637.490/0001-45", b3="KLBN", cls="UNT", lending=["KLBN3", "KLBN4", "KLBN11"]),
    "SUZB3":  dict(name="Suzano",             cnpj="16.404.287/0001-55", b3="SUZB", cls="ON",  lending=["SUZB3"]),
    "RANI3":  dict(name="Irani",              cnpj="92.791.243/0001-03", b3="RANI", cls="ON",  lending=["RANI3"]),
    "AURA33": dict(name="Aura Minerals",      cnpj="07.857.093/0001-14", b3="AURA", cls="BDR", lending=["AURA33"]),
}
CNPJ_TO_COMPANY = {v["cnpj"]: k for k, v in COMPANIES.items()}
B3CODE_TO_COMPANY = {v["b3"]: k for k, v in COMPANIES.items()}
LENDING_TO_COMPANY = {t: k for k, v in COMPANIES.items() for t in v["lending"]}

# Categorias do Plantão que interessam ao feed de notícias (Wave 2). O resto (atas,
# posições de VM, apresentações, ITR, informes de governança…) fica só na aba Filings.
NEWSWORTHY = (
    "fato relevante", "comunicado", "aviso aos acionistas", "aquisicao de participacao",
    "alienacao de participacao", "esclarecimentos", "press-release", "transacao entre partes",
)

# ═══════════════════════ utilidades ═════════════════════════════════════════

def _log(msg: str) -> None:
    print(msg, flush=True)


def _num_br(s) -> float | None:
    """'589.134.108,94' → 589134108.94 · '0,48%' → 0.48 · '-' → None."""
    if s is None:
        return None
    s = str(s).strip().replace("%", "")
    if s in ("", "-", "—"):
        return None
    s = s.replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def _int_or_none(v) -> int | None:
    if v in (None, ""):
        return None
    try:
        return int(round(float(str(v).replace(".", "").replace(",", ".")))) if isinstance(v, str) else int(round(float(v)))
    except (TypeError, ValueError):
        return None


def _float_or_none(v) -> float | None:
    if v in (None, ""):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _date_iso(s) -> str | None:
    """'2026-09-01T00:00:00' | '01/09/2026' | '2026-09-01' → '2026-09-01'."""
    if not s:
        return None
    s = str(s).strip()
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", s)
    if m:
        return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    return None


def _read_csv_bytes(b: bytes) -> list[dict]:
    text = b.decode("latin-1")
    return list(csv.DictReader(io.StringIO(text), delimiter=";"))


def _fetch_zip(url: str, timeout: int = 240) -> dict[str, bytes] | None:
    try:
        r = requests.get(url, headers=UA, timeout=timeout)
        r.raise_for_status()
        z = zipfile.ZipFile(io.BytesIO(r.content))
        return {n: z.read(n) for n in z.namelist()}
    except Exception as e:  # noqa: BLE001
        _log(f"  [zip] falha em {url}: {e}")
        return None


def business_days(d0: dt.date, d1: dt.date):
    d = d0
    while d <= d1:
        if d.weekday() < 5:
            yield d
        d += dt.timedelta(days=1)


# ═══════════════════ Supabase (service key, REST) ══════════════════════════

def _hdr(extra: dict | None = None) -> dict:
    h = {"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}", "Content-Type": "application/json"}
    if extra:
        h.update(extra)
    return h


def uniform_rows(rows: list[dict]) -> list[dict]:
    """Mesmas chaves em TODAS as linhas (faltante = None).

    O PostgREST exige que todo objeto de um lote tenha o mesmo conjunto de colunas
    (senão devolve PGRST102 "All object keys must match" e recusa o lote inteiro). Um papel
    sem negócio eletrônico no dia não tem `qty_d0`, um comunicado sem PDF não tem
    `doc_title` — aqui isso vira null explícito, que o Postgres aceita.
    """
    keys: list[str] = []
    seen = set()
    for r in rows:
        for k in r:
            if k not in seen:
                seen.add(k)
                keys.append(k)
    return [{k: r.get(k) for k in keys} for r in rows]


def upsert(table: str, rows: list[dict], on_conflict: str, dry: bool = False) -> int:
    """Upsert em lotes (merge-duplicates). Devolve quantas linhas mandou."""
    if not rows:
        return 0
    rows = uniform_rows(rows)
    if dry:
        _log(f"  [dry-run] {table}: {len(rows)} linha(s) — ex.: {json.dumps(rows[0], ensure_ascii=False, default=str)[:300]}")
        return len(rows)
    if not SUPA or not SERVICE:
        _log("  SUPABASE_URL/SUPABASE_SERVICE_KEY ausentes — nada gravado.")
        return 0
    sent = 0
    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        r = requests.post(f"{SUPA}/rest/v1/{table}?on_conflict={on_conflict}",
                          headers=_hdr({"Prefer": "resolution=merge-duplicates,return=minimal"}),
                          data=json.dumps(chunk, ensure_ascii=False, default=str), timeout=120)
        if not r.ok:
            _log(f"  [{table}] HTTP {r.status_code}: {r.text[:300]}")
            return sent
        sent += len(chunk)
    return sent


def rest_get(path: str, params: str = "") -> list | None:
    if not SUPA or not SERVICE:
        return None
    try:
        r = requests.get(f"{SUPA}/rest/v1/{path}?{params}", headers=_hdr(), timeout=60)
        return r.json() if r.ok else None
    except Exception:  # noqa: BLE001
        return None


def rest_delete(path: str, params: str, dry: bool = False) -> bool:
    if dry:
        _log(f"  [dry-run] DELETE {path}?{params}")
        return True
    if not SUPA or not SERVICE:
        return False
    r = requests.delete(f"{SUPA}/rest/v1/{path}?{params}", headers=_hdr({"Prefer": "return=minimal"}), timeout=60)
    return r.ok


# ═══════════════════ 1. ALUGUEL — API do BDI ═══════════════════════════════

def fetch_bdi_table(name: str, day: str) -> dict | None:
    """JSON da tabela do BDI para um dia ('YYYY-MM-DD'). None em falha."""
    body = {"Name": name, "Date": day, "FinalDate": day, "ClientId": "", "Filters": {}}
    try:
        r = requests.post(BDI_API, headers={**UA, "Accept": "application/json",
                                            "Content-Type": "application/json"},
                          data=json.dumps(body), timeout=180)
        r.raise_for_status()
        return r.json()
    except Exception as e:  # noqa: BLE001
        _log(f"  [bdi] {name} {day}: {e}")
        return None


def bdi_rows(table_json: dict) -> list[dict]:
    """values (listas) → dicts pelo nome da coluna (columns[].name)."""
    if not table_json:
        return []
    cols = [c["name"] for c in table_json.get("columns") or []]
    out = []
    for v in table_json.get("values") or []:
        if len(v) != len(cols):
            continue
        out.append(dict(zip(cols, v)))
    return out


def build_short_rows(open_pos: list[dict], loans: list[dict], source: str = "bdi_api") -> list[dict]:
    """Junta posições em aberto + empréstimos registrados numa linha por papel × dia.

    Só os papéis da cobertura (LENDING_TO_COMPANY). Taxas viram % a.a. (0.0004 → 0.04);
    a taxa média do tomador do dia é ponderada pela quantidade registrada em cada
    modalidade — sem negócio no dia, cai na taxa da modalidade "Registro" (a B3 repete
    a última calculada) e, faltando ela, na média simples das modalidades.
    """
    by_key: dict[tuple[str, str], dict] = {}

    def slot(tk: str, d: str) -> dict:
        key = (tk, d)
        if key not in by_key:
            by_key[key] = {"ticker": tk, "company": LENDING_TO_COMPANY[tk], "ref_date": d, "source": source}
        return by_key[key]

    for r in open_pos:
        tk = str(r.get("TckrSymb") or "").strip()
        if tk not in LENDING_TO_COMPANY:
            continue
        d = _date_iso(r.get("DtRef") or r.get("RptDt"))
        if not d:
            continue
        row = slot(tk, d)
        market = str(r.get("Market") or "").strip()
        qty = _int_or_none(r.get("StockBalance"))
        if market == "Total":
            row["qty_total"] = qty
            row["value_brl"] = _float_or_none(r.get("Balance"))
            if qty and row["value_brl"]:
                row["avg_price"] = round(row["value_brl"] / qty, 4)
        elif market == "Registro":
            row["qty_registro"] = qty
        elif market.endswith("D+0"):
            row["qty_d0"] = qty
        elif market.endswith("D+1"):
            row["qty_d1"] = qty

    # taxas: acumula por papel × dia
    acc: dict[tuple[str, str], dict] = {}
    for r in loans:
        tk = str(r.get("TckrSymb") or "").strip()
        if tk not in LENDING_TO_COMPANY:
            continue
        d = _date_iso(r.get("DtRef") or r.get("RptDt"))
        if not d:
            continue
        a = acc.setdefault((tk, d), {"w": 0.0, "wr": 0.0, "wd": 0.0, "regs": None, "rates": [], "drates": [],
                                     "mins": [], "maxs": [], "contracts": 0, "qty": 0, "value": 0.0})
        q = _float_or_none(r.get("ValCtrctsDay")) or 0.0
        tk_avg = _float_or_none(r.get("TkrAvrgRate"))
        dn_avg = _float_or_none(r.get("DnrAvrgRate"))
        market = str(r.get("Market") or "").strip()
        if tk_avg is not None:
            a["rates"].append(tk_avg)
            a["w"] += q
            a["wr"] += q * tk_avg
            if market == "Registro":
                a["regs"] = tk_avg
        if dn_avg is not None:
            a["drates"].append(dn_avg)
            a["wd"] += q * dn_avg
        mn, mx = _float_or_none(r.get("TkrMinRate")), _float_or_none(r.get("TkrMaxRate"))
        if mn is not None:
            a["mins"].append(mn)
        if mx is not None:
            a["maxs"].append(mx)
        a["contracts"] += _int_or_none(r.get("QtyCtrctsDay")) or 0
        a["qty"] += _int_or_none(r.get("ValCtrctsDay")) or 0
        a["value"] += _float_or_none(r.get("BRLValue")) or 0.0

    for (tk, d), a in acc.items():
        row = slot(tk, d)
        if a["w"] > 0:
            avg = a["wr"] / a["w"]
            davg = a["wd"] / a["w"] if a["drates"] else None
        elif a["regs"] is not None:
            avg = a["regs"]
            davg = (sum(a["drates"]) / len(a["drates"])) if a["drates"] else None
        elif a["rates"]:
            avg = sum(a["rates"]) / len(a["rates"])
            davg = (sum(a["drates"]) / len(a["drates"])) if a["drates"] else None
        else:
            avg, davg = None, None
        pct = lambda x: None if x is None else round(x * 100, 4)  # noqa: E731
        row["rate_taker_avg"] = pct(avg)
        row["rate_taker_min"] = pct(min(a["mins"])) if a["mins"] else None
        row["rate_taker_max"] = pct(max(a["maxs"])) if a["maxs"] else None
        row["rate_donor_avg"] = pct(davg)
        row["contracts_day"] = a["contracts"]
        row["qty_day"] = a["qty"]
        row["value_day"] = round(a["value"], 2)

    # só entra quem tem posição em aberto (a chave do painel)
    return [r for r in by_key.values() if r.get("qty_total") is not None]


def run_short(days: list[str], dry: bool) -> int:
    total = 0
    for d in days:
        op = fetch_bdi_table("BTBLendingOpenPosition", d)
        lb = fetch_bdi_table("BTBLoanBalance", d)
        rows = build_short_rows(bdi_rows(op), bdi_rows(lb))
        if not rows:
            _log(f"  aluguel {d}: nada (feriado, fim de semana ou ainda não publicado)")
            continue
        n = upsert("mw_short_interest", rows, "ticker,ref_date", dry)
        _log(f"  aluguel {d}: {len(rows)} papéis → {n} gravados")
        total += n
    return total


# ═══════════════════ 1b. ALUGUEL — histórico pelo PDF do BDI ═══════════════

_DATE_RE = re.compile(r"^\d{2}/\d{2}/\d{4}$")
_DATE_TK_RE = re.compile(r"^(\d{2}/\d{2}/\d{4})\s+([A-Z0-9]{4,7})$")
_NUM_RE = re.compile(r"^-?[\d.]*\d(,\d+)?%?$|^-$")


def parse_bdi_pdf_text(text: str) -> tuple[list[dict], list[dict]]:
    """Texto do PDF (páginas concatenadas, uma célula por linha) → (open_pos, loans) no
    MESMO formato de dicts da API, prontos para build_short_rows(source='bdi_pdf').

    O PDF tem duas seções, cada uma com o cabeçalho UMA vez: "Empréstimos registrados"
    (taxas) e depois "Posições em aberto". Nas posições a data e o papel vêm em linhas
    separadas; nos registrados às vezes vêm juntos ("03/08/2026 VALE3"). O parser anda
    pelas células e, ao achar data+papel da cobertura, lê para a frente os campos daquela
    seção. Células de mercado podem vir partidas ("Neg. Eletrônica" + "D+1").
    """
    cells = [c.strip() for c in text.split("\n")]
    cells = [c for c in cells if c != ""]
    section = None
    open_pos: list[dict] = []
    loans: list[dict] = []
    i, n = 0, len(cells)
    while i < n:
        c = cells[i]
        if c == "Empréstimos registrados":
            section = "loans"; i += 1; continue
        if c == "Posições em aberto":
            section = "open"; i += 1; continue
        date_s, tk = None, None
        m = _DATE_TK_RE.match(c)
        if m:
            date_s, tk = m.group(1), m.group(2); j = i + 1
        elif _DATE_RE.match(c) and i + 1 < n and re.match(r"^[A-Z0-9]{4,7}$", cells[i + 1]):
            date_s, tk = c, cells[i + 1]; j = i + 2
        if tk and tk in LENDING_TO_COMPANY and section:
            # j aponta para o ISIN
            isin = cells[j] if j < n else ""
            j += 1
            # empresa = até a próxima célula que pareça tipo/mercado/número. Uma célula com
            # cara de DATA significa que a entrada acabou truncada (PDF partido) → aborta esta.
            company_parts = []
            truncated = False
            while j < n and not _NUM_RE.match(cells[j]) and cells[j] not in ("Registro", "Total") \
                    and not cells[j].startswith("Neg. Eletr") and not re.match(r"^(ON|PN|PNA|PNB|UNT|DRN|DR3|DR2|DR1|BDR)\b", cells[j]):
                if _DATE_RE.match(cells[j]) or _DATE_TK_RE.match(cells[j]):
                    truncated = True
                    break
                company_parts.append(cells[j]); j += 1
                if len(company_parts) > 3:
                    truncated = True
                    break
            if truncated:
                i = j
                continue
            if section == "open":
                typ = ""
                if j < n and re.match(r"^(ON|PN|PNA|PNB|UNT|DRN|DR3|DR2|DR1|BDR)\b", cells[j]):
                    typ = cells[j]; j += 1
                market = cells[j] if j < n else ""; j += 1
                if market.startswith("Neg. Eletr") and j < n and re.match(r"^D\+\d$", cells[j]):
                    market = market + " " + cells[j]; j += 1
                nums = []
                while j < n and len(nums) < 3 and _NUM_RE.match(cells[j]):
                    nums.append(cells[j]); j += 1
                if len(nums) == 3:
                    open_pos.append({"DtRef": date_s, "TckrSymb": tk, "ISIN": isin,
                                     "Company": " ".join(company_parts), "Type": typ, "Market": market,
                                     "StockBalance": _num_br(nums[0]), "AvgPric": _num_br(nums[1]),
                                     "Balance": _num_br(nums[2])})
            else:  # loans
                market = cells[j] if j < n else ""; j += 1
                if market.startswith("Neg. Eletr") and j < n and re.match(r"^D\+\d$", cells[j]):
                    market = market + " " + cells[j]; j += 1
                nums = []
                while j < n and len(nums) < 9 and _NUM_RE.match(cells[j]):
                    nums.append(cells[j]); j += 1
                if len(nums) == 9:
                    f = [_num_br(x) for x in nums]
                    # taxas no PDF vêm em % ("0,48%") → fração, como na API
                    rate = lambda x: None if x is None else x / 100.0  # noqa: E731
                    loans.append({"DtRef": date_s, "TckrSymb": tk, "ISIN": isin, "Company": " ".join(company_parts),
                                  "Market": market, "QtyCtrctsDay": f[0], "ValCtrctsDay": f[1], "BRLValue": f[2],
                                  "DnrMinRate": rate(f[3]), "DnrAvrgRate": rate(f[4]), "DnrMaxRate": rate(f[5]),
                                  "TkrMinRate": rate(f[6]), "TkrAvrgRate": rate(f[7]), "TkrMaxRate": rate(f[8])})
            i = j
            continue
        i += 1
    return open_pos, loans


def fetch_bdi_pdf_text(day: dt.date) -> str | None:
    url = BDI_PDF.format(d=day.isoformat(), dc=day.strftime("%Y%m%d"))
    try:
        r = requests.get(url, headers=UA, timeout=180)
        if r.status_code != 200 or not r.content.startswith(b"%PDF"):
            return None
        import fitz  # PyMuPDF (já é dependência do IBÁ)
        doc = fitz.open(stream=r.content, filetype="pdf")
        return "\n".join(p.get_text() for p in doc)
    except Exception as e:  # noqa: BLE001
        _log(f"  [pdf] {day}: {e}")
        return None


def run_backfill_pdf(d0: dt.date, d1: dt.date, dry: bool) -> int:
    total = 0
    for day in business_days(d0, d1):
        text = fetch_bdi_pdf_text(day)
        if not text:
            _log(f"  pdf {day}: sem arquivo")
            continue
        op, lb = parse_bdi_pdf_text(text)
        rows = build_short_rows(op, lb, source="bdi_pdf")
        n = upsert("mw_short_interest", rows, "ticker,ref_date", dry)
        _log(f"  pdf {day}: {len(rows)} papéis → {n} gravados")
        total += n
    return total


# ═══════════════════ 2. RECOMPRAS (CVM) ════════════════════════════════════

def build_buyback_rows(programs: list[dict], qtys: list[dict], brokers: list[dict]) -> list[dict]:
    by_id_q: dict[str, list[dict]] = {}
    for q in qtys:
        by_id_q.setdefault(q.get("ID_Programa", ""), []).append(q)
    by_id_b: dict[str, list[str]] = {}
    for b in brokers:
        name = (b.get("Intermediario") or "").strip()
        if name:
            by_id_b.setdefault(b.get("ID_Programa", ""), []).append(name)
    out = []
    for p in programs:
        comp = CNPJ_TO_COMPANY.get((p.get("CNPJ_Companhia") or "").strip())
        if not comp:
            continue
        pid = _int_or_none(p.get("ID_Programa"))
        if pid is None:
            continue
        circ_on = circ_pn = None
        for q in by_id_q.get(str(pid), []):
            t = (q.get("Tipo_Acao") or "").upper()
            if t.startswith("ORDIN"):
                circ_on = _int_or_none(q.get("Quantidade_Circulacao"))
            elif t.startswith("PREF"):
                circ_pn = _int_or_none(q.get("Quantidade_Circulacao"))
        out.append({
            "program_id": pid, "company": comp, "company_name": (p.get("Nome_Companhia") or "").strip(),
            "decided_on": _date_iso(p.get("Data_Deliberacao")), "expires_on": _date_iso(p.get("Data_Final_Prazo")),
            "status": (p.get("Situacao") or "").strip() or None, "operation": (p.get("Tipo_Operacao") or "").strip() or None,
            "reason": (p.get("Motivo") or "").strip() or None, "purpose": (p.get("Finalidade_Compra") or "").strip() or None,
            "qty_on": _int_or_none(p.get("Quantidade_Acoes_Ordinarias")), "qty_pn": _int_or_none(p.get("Quantidade_Acoes_Preferenciais")),
            "qty_circ_on": circ_on, "qty_circ_pn": circ_pn,
            "brokers": sorted(set(by_id_b.get(str(pid), []))),
        })
    return out


def run_buybacks(dry: bool) -> int:
    files = _fetch_zip(CVM_RECOMPRA)
    if not files:
        return 0
    def pick(sfx):
        for n, b in files.items():
            if n.endswith(sfx):
                return _read_csv_bytes(b)
        return []
    programs = pick("recompra_acoes.csv")
    qtys = pick("_quantidades.csv")
    brokers = pick("_intermediarios.csv")
    rows = build_buyback_rows(programs, qtys, brokers)
    n = upsert("mw_buyback_programs", rows, "program_id", dry)
    _log(f"  recompras: {len(rows)} programas da cobertura → {n} gravados")
    return n


# ═══════════════════ 3. INSIDERS (CVM VLMO) ════════════════════════════════

def build_insider_rows(con_rows: list[dict]) -> tuple[list[dict], dict[tuple[str, str], int]]:
    """Linhas do consolidado → mw_insider_moves (só a versão mais alta de cada empresa×mês).

    Devolve também {(company, ref_month): versão} p/ o chamador apagar versões velhas.
    """
    latest: dict[tuple[str, str], int] = {}
    for r in con_rows:
        comp = CNPJ_TO_COMPANY.get((r.get("CNPJ_Companhia") or "").strip())
        if not comp:
            continue
        ref = _date_iso(r.get("Data_Referencia"))
        ver = _int_or_none(r.get("Versao")) or 1
        if not ref:
            continue
        key = (comp, ref)
        if ver > latest.get(key, 0):
            latest[key] = ver
    out = []
    seq: dict[tuple[str, str], int] = {}
    for r in con_rows:
        comp = CNPJ_TO_COMPANY.get((r.get("CNPJ_Companhia") or "").strip())
        if not comp:
            continue
        ref = _date_iso(r.get("Data_Referencia"))
        ver = _int_or_none(r.get("Versao")) or 1
        if not ref or latest.get((comp, ref)) != ver:
            continue
        k = seq.get((comp, ref), 0) + 1
        seq[(comp, ref)] = k
        move = (r.get("Tipo_Movimentacao") or "").strip()
        raw = "|".join([comp, ref, str(ver), str(k)])
        out.append({
            "id": hashlib.sha1(raw.encode()).hexdigest()[:24], "company": comp, "ref_month": ref, "doc_version": ver,
            "entity_type": (r.get("Tipo_Empresa") or "").strip() or None, "entity": (r.get("Empresa") or "").strip() or None,
            "group_type": (r.get("Tipo_Cargo") or "").strip() or None, "move_type": move or None,
            "move_desc": (r.get("Descricao_Movimentacao") or "").strip() or None,
            "operation": (r.get("Tipo_Operacao") or "").strip() or None,
            "asset_type": (r.get("Tipo_Ativo") or "").strip() or None,
            "asset_class": (r.get("Caracteristica_Valor_Mobiliario") or "").strip() or None,
            "broker": (r.get("Intermediario") or "").strip() or None,
            "move_date": _date_iso(r.get("Data_Movimentacao")),
            "qty": _int_or_none(r.get("Quantidade")), "unit_price": _float_or_none(r.get("Preco_Unitario")),
            "volume": _float_or_none(r.get("Volume")),
            "is_balance": move.lower().startswith("saldo"),
        })
    return out, latest


def run_insiders(dry: bool, years: list[int] | None = None) -> int:
    y = dt.date.today().year
    years = years or [y - 1, y]
    total = 0
    for yy in years:
        files = _fetch_zip(CVM_VLMO.format(y=yy))
        if not files:
            continue
        con = None
        for n, b in files.items():
            if "_con_" in n:
                con = _read_csv_bytes(b)
        if con is None:
            _log(f"  insiders {yy}: arquivo consolidado não veio")
            continue
        rows, latest = build_insider_rows(con)
        # apaga versões antigas dos meses que estamos regravando (reapresentação substitui)
        for (comp, ref), ver in latest.items():
            rest_delete("mw_insider_moves", f"company=eq.{comp}&ref_month=eq.{ref}&doc_version=lt.{ver}", dry)
        n = upsert("mw_insider_moves", rows, "id", dry)
        _log(f"  insiders {yy}: {len(rows)} linhas ({len(latest)} empresa×mês) → {n} gravadas")
        total += n
    return total


# ═══════════════════ 4. FREE FLOAT (CVM FRE) ═══════════════════════════════

def build_share_capital_rows(capital: list[dict], dist: list[dict], dist_cls: list[dict]) -> list[dict]:
    """Uma linha por empresa: capital integralizado + ações em circulação (versão mais alta,
    data de referência mais recente)."""
    def best(rows):
        b: dict[str, dict] = {}
        for r in rows:
            comp = CNPJ_TO_COMPANY.get((r.get("CNPJ_Companhia") or "").strip())
            if not comp:
                continue
            ref, ver = _date_iso(r.get("Data_Referencia")) or "", _int_or_none(r.get("Versao")) or 0
            cur = b.get(comp)
            if cur is None or (ref, ver) > (cur["_ref"], cur["_ver"]):
                b[comp] = {"_ref": ref, "_ver": ver, "rows": [r]}
            elif (ref, ver) == (cur["_ref"], cur["_ver"]):
                cur["rows"].append(r)
        return b
    cap, dst, cls = best(capital), best(dist), best(dist_cls)
    out = []
    for comp in COMPANIES:
        d = dst.get(comp)
        c = cap.get(comp)
        if not d and not c:
            continue
        row = {"company": comp, "float_by_class": {}}
        if c:
            pref = [r for r in c["rows"] if (r.get("Tipo_Capital") or "").strip() == "Capital Integralizado"] \
                or [r for r in c["rows"] if (r.get("Tipo_Capital") or "").strip() == "Capital Subscrito"] \
                or c["rows"]
            r = pref[0]
            row["shares_on"] = _int_or_none(r.get("Quantidade_Acoes_Ordinarias"))
            row["shares_pn"] = _int_or_none(r.get("Quantidade_Acoes_Preferenciais"))
            row["shares_total"] = _int_or_none(r.get("Quantidade_Total_Acoes"))
            row["ref_date"] = c["_ref"] or None
            row["doc_version"] = c["_ver"] or None
        if d:
            r = d["rows"][0]
            row["float_on"] = _int_or_none(r.get("Quantidade_Acoes_Ordinarias_Circulacao"))
            row["float_pn"] = _int_or_none(r.get("Quantidade_Acoes_Preferenciais_Circulacao"))
            row["float_total"] = _int_or_none(r.get("Quantidade_Total_Acoes_Circulacao"))
            row["pct_float_total"] = _float_or_none(r.get("Percentual_Total_Acoes_Circulacao"))
            row.setdefault("ref_date", d["_ref"] or None)
            row.setdefault("doc_version", d["_ver"] or None)
        if comp in cls:
            for r in cls[comp]["rows"]:
                sig = (r.get("Sigla_Classe_Acoes_Preferenciais") or "").strip()
                if sig:
                    row["float_by_class"][sig] = _int_or_none(r.get("Quantidade_Acoes_Preferenciais_Circulacao"))
        out.append(row)
    return out


def run_float(dry: bool, years: list[int] | None = None) -> int:
    y = dt.date.today().year
    years = years or [y - 1, y]
    capital, dist, dist_cls = [], [], []
    for yy in years:
        files = _fetch_zip(CVM_FRE.format(y=yy))
        if not files:
            continue
        for n, b in files.items():
            if n.endswith(f"capital_social_{yy}.csv"):
                capital += _read_csv_bytes(b)
            elif n.endswith(f"distribuicao_capital_{yy}.csv"):
                dist += _read_csv_bytes(b)
            elif n.endswith(f"distribuicao_capital_classe_acao_{yy}.csv"):
                dist_cls += _read_csv_bytes(b)
    rows = build_share_capital_rows(capital, dist, dist_cls)
    n = upsert("mw_share_capital", rows, "company", dry)
    _log(f"  free float: {len(rows)} empresas → {n} gravadas")
    return n


# ═══════════════════ 5. COMUNICADOS (B3 Plantão) ═══════════════════════════

_HEADLINE_RE = re.compile(
    r"^(?P<issuer>.+?)\s+\((?P<code>[A-Z0-9]{4})(?:-[A-Z0-9]+)?\)\s*-?\s*(?P<rest>.*)$")
_TAIL_DATE_RE = re.compile(r"\s*-\s*(?P<d>\d{2}/\d{2}/\d{2,4})(?:\s+\d{2}:\d{2})?\s*(?P<flag>\([RCN]\))?\s*$")


def parse_headline(headline: str) -> dict | None:
    """'VALE (VALE-NM) - Outros Comunicados ao Mercado - 27/08/26 (R)'
       → {issuer:'VALE', code:'VALE', category:'Outros Comunicados ao Mercado', doc_date:'2026-08-27', flag:'R'}"""
    h = " ".join(str(headline or "").split())
    m = _HEADLINE_RE.match(h)
    if not m:
        return None
    rest = m.group("rest").strip()
    flag, doc_date = None, None
    t = _TAIL_DATE_RE.search(rest)
    if t:
        ds = t.group("d")
        dd, mm, yy = ds.split("/")
        if len(yy) == 2:
            yy = "20" + yy
        doc_date = f"{yy}-{mm}-{dd}"
        flag = (t.group("flag") or "").strip("()") or None
        rest = rest[:t.start()].strip()
    else:
        f = re.search(r"\(([RCN])\)\s*$", rest)
        if f:
            flag = f.group(1); rest = rest[:f.start()].strip()
    category = rest.strip(" -")
    return {"issuer": m.group("issuer").strip(), "code": m.group("code"), "category": category or None,
            "doc_date": doc_date, "flag": flag}


def is_newsworthy(category: str | None) -> bool:
    c = (category or "").lower()
    c = c.replace("ç", "c").replace("ã", "a").replace("á", "a").replace("é", "e").replace("ê", "e").replace("õ", "o").replace("í", "i")
    return any(k in c for k in NEWSWORTHY)


def fetch_plantao(d_from: dt.date, d_to: dt.date) -> list[dict]:
    try:
        r = requests.get(PLANTAO_LIST, params={"agencia": "18", "palavra": "", "dataInicial": d_from.isoformat(),
                                               "dataFinal": d_to.isoformat()}, headers=UA, timeout=120)
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, list) else []
    except Exception as e:  # noqa: BLE001
        _log(f"  [plantao] lista: {e}")
        return []


_CVM_LINK_RE = re.compile(r"https?://www\.rad\.cvm\.gov\.br/ENET[^\"'\s<>]*frmExibirArquivoIPEExterno\.aspx\?ID=\d+[^\"'\s<>]*", re.I)


def fetch_plantao_detail_url(item_id: int, date_time: str) -> str | None:
    try:
        r = requests.get(PLANTAO_DETAIL, params={"idNoticia": item_id, "agencia": "18", "dataNoticia": date_time},
                         headers=UA, timeout=60)
        if not r.ok:
            return None
        return extract_cvm_url(r.text)
    except Exception:  # noqa: BLE001
        return None


def extract_cvm_url(html: str) -> str | None:
    m = _CVM_LINK_RE.search(html or "")
    if not m:
        return None
    return m.group(0).replace("&amp;", "&")


# ── o DOCUMENTO em si (PDF na CVM) → título real + começo do texto ───────────
# O link do Plantão abre um visualizador (frmExibirArquivoIPEExterno.aspx?ID=<protocolo>) que
# carrega o PDF por um WebMethod em JSON (base64). Sem captcha (hdnHabilitaCaptcha = N, medido
# em 2026-09-02). Reserva: o download direto exige numSequencia, que na prática é
# protocolo − 475294 (identidade sequencial; conferido em 6 documentos do CSV IPE da CVM).
CVM_EXIBIR_PDF = "https://www.rad.cvm.gov.br/ENETWEB/frmExibirArquivoIPEExterno.aspx/ExibirPDF"
CVM_DOWNLOAD = ("https://www.rad.cvm.gov.br/ENET/frmDownloadDocumento.aspx?Tela=ext&descTipo=IPE"
                "&CodigoInstituicao=1&numProtocolo={p}&numSequencia={s}&numVersao=1")
_SEQ_OFFSET = 475294
_PROTO_RE = re.compile(r"[?&]ID=(\d+)")


def cvm_protocol_from_url(url: str | None) -> int | None:
    m = _PROTO_RE.search(url or "")
    return int(m.group(1)) if m else None


def fetch_cvm_pdf(protocol: int) -> bytes | None:
    """Bytes do PDF de um protocolo IPE. WebMethod primeiro; download direto de reserva."""
    import base64
    try:
        r = requests.post(CVM_EXIBIR_PDF, headers={**UA, "Content-Type": "application/json; charset=utf-8",
                                                   "Accept": "application/json"},
                          data=json.dumps({"codigoInstituicao": "2", "numeroProtocolo": str(protocol),
                                           "token": "", "versaoCaptcha": ""}), timeout=120)
        if r.ok:
            d = (r.json() or {}).get("d")
            if isinstance(d, str) and len(d) > 200 and d not in ("V2", "V3"):
                b = base64.b64decode(d)
                if b.startswith(b"%PDF"):
                    return b
    except Exception as e:  # noqa: BLE001
        _log(f"  [cvm] ExibirPDF {protocol}: {e}")
    try:
        r = requests.get(CVM_DOWNLOAD.format(p=protocol, s=protocol - _SEQ_OFFSET), headers=UA, timeout=120)
        if r.ok and r.content.startswith(b"%PDF"):
            return r.content
    except Exception as e:  # noqa: BLE001
        _log(f"  [cvm] download {protocol}: {e}")
    return None


def pdf_first_page_text(pdf: bytes, max_pages: int = 2) -> str:
    try:
        import fitz
        doc = fitz.open(stream=pdf, filetype="pdf")
        return "\n".join(doc[i].get_text() for i in range(min(max_pages, doc.page_count)))
    except Exception as e:  # noqa: BLE001
        _log(f"  [cvm] pdf: {e}")
        return ""


def doc_title_excerpt(text: str, company_name: str = "") -> tuple[str | None, str | None]:
    """(título, trecho) a partir do texto do PDF.

    Título = 1ª linha "de verdade" (≥ 12 caracteres, sem ser cabeçalho de empresa/CNPJ/NIRE/data
    solta). Trecho = texto corrido a partir do título, ≤ 1.500 caracteres, espaços colapsados.
    """
    lines = [" ".join(l.split()) for l in (text or "").splitlines()]
    lines = [l for l in lines if l]
    if not lines:
        return None, None
    # cabeçalho de papel timbrado: nome/CNPJ/NIRE/"Companhia Aberta", cidade+data, tipo do
    # documento seco ("COMUNICADO AO MERCADO", "FATO RELEVANTE"…) — nada disso é título
    skip = re.compile(
        r"^(CNPJ|NIRE|C[óo]digo CVM|Companhia Aberta|Capital (Aberto|Autorizado)|P[áa]gina|Page)\b"
        r"|^(Rio de Janeiro|S[ãa]o Paulo|Belo Horizonte|Porto Alegre|Curitiba|Bras[íi]lia|Jundia[íi]|Vit[óo]ria)\s*[,–-]"
        r"|^\W+$|\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}"
        r"|^(COMUNICADO( AO MERCADO)?|FATO RELEVANTE|AVISO AOS ACIONISTAS|PRESS[ -]RELEASE|MATERIAL FACT|"
        r"NOTICE TO (THE MARKET|SHAREHOLDERS)|EARNINGS RELEASE|RELEASE DE RESULTADOS)\W*$", re.I)
    # o corpo começa aqui: "Cidade, data – A Empresa informa…" ou linha que continua uma frase
    # (minúscula). Daí em diante não há título — o documento é só o comunicado corrido.
    body_start = re.compile(
        r"^(Rio de Janeiro|S[ãa]o Paulo|Belo Horizonte|Porto Alegre|Curitiba|Bras[íi]lia|Jundia[íi]|Vit[óo]ria|Nova Lima)\s*[,–-]"
        r"|^[a-zà-ú]")
    norm = lambda s: re.sub(r"[^a-z0-9]+", "", s.lower())  # noqa: E731
    nm = norm(company_name) if company_name else ""
    nm_first = norm(company_name.split()[0]) if company_name else ""
    title = None
    idx = 0
    for k, l in enumerate(lines[:14]):
        if body_start.search(l):
            idx = k
            break
        if len(l) < 20 or skip.search(l):
            continue
        nl = norm(l)
        # linha que é só o nome da empresa (com S.A./S/A/Inc. e variações)
        if nm and (nl.startswith(nm) and len(nl) <= len(nm) + 6):
            continue
        if nm_first and re.search(r"\b(S\.?A\.?|S/A|INC\.?|LTDA\.?)\s*$", l, re.I) and nm_first in nl and len(l) < 60:
            continue
        title = l
        idx = k
        # candidato que é o COMEÇO de uma frase (sem pontuação final e a próxima linha continua
        # em minúscula): estende até o fim da frase, senão o "título" para no meio
        j = k + 1
        while (j < len(lines) and len(title) < 220 and not re.search(r"[.:;!?»”]\s*$", title)
               and re.match(r"^[a-zà-ú(“\"]", lines[j])):
            title += " " + lines[j]
            j += 1
        title = (title[:177].rstrip() + "…") if len(title) > 180 else title
        break
    body = " ".join(lines[idx:])
    excerpt = body[:1500].strip() or None
    return title, excerpt


def enrich_filing_doc(row: dict) -> dict:
    """Preenche doc_title/doc_excerpt de um comunicado (só os newsworthy — o resto não vai p/ o feed)."""
    p = cvm_protocol_from_url(row.get("cvm_url"))
    if not p:
        return row
    pdf = fetch_cvm_pdf(p)
    if not pdf:
        return row
    t, x = doc_title_excerpt(pdf_first_page_text(pdf), (COMPANIES.get(row.get("company"), {}) or {}).get("name", ""))
    # press-release de resultados é TABELA: a "1ª linha" seria cabeçalho de coluna — deixa o
    # título cair no padrão "{empresa} — {categoria}" (o trecho fica, p/ a IA)
    if t and "press-release" in (row.get("category") or "").lower():
        t = None
    if t:
        row["doc_title"] = t
    if x:
        row["doc_excerpt"] = x
    return row


def build_filing_rows(items: list[dict], known_ids: set[int] | None = None, detail_fn=None) -> list[dict]:
    """Itens do Plantão → mw_filings (só empresas da cobertura). detail_fn(id, dateTime) → url."""
    out = []
    for it in items:
        msg = it.get("NwsMsg") or it
        hid = _int_or_none(msg.get("id"))
        head = msg.get("headline") or ""
        p = parse_headline(head)
        if hid is None or not p:
            continue
        comp = B3CODE_TO_COMPANY.get(p["code"])
        if not comp:
            continue
        if known_ids and hid in known_ids:
            continue
        dtime = str(msg.get("dateTime") or "").strip()
        pub = None
        m = re.match(r"(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})", dtime)
        if m:
            pub = f"{m.group(1)}T{m.group(2)}-03:00"   # horário de Brasília
        if not pub:
            continue
        url = detail_fn(hid, dtime) if detail_fn else None
        out.append({"id": hid, "company": comp, "b3_code": p["code"], "headline": head.strip(),
                    "category": p["category"], "doc_date": p["doc_date"], "published_at": pub,
                    "flag": p["flag"], "cvm_url": url, "is_newsworthy": is_newsworthy(p["category"])})
    return out


def run_filings(days: int, dry: bool) -> int:
    today = dt.date.today()
    d_from = today - dt.timedelta(days=max(0, days))
    items = fetch_plantao(d_from, today)
    _log(f"  plantão: {len(items)} manchetes de {d_from} a {today} (todas as empresas)")
    known: set[int] = set()
    got = rest_get("mw_filings", f"select=id&published_at=gte.{d_from.isoformat()}")
    if got:
        known = {int(r["id"]) for r in got if r.get("id") is not None}
    rows = build_filing_rows(items, known, fetch_plantao_detail_url)
    # documento em si (título real + trecho) só para o que vai ao feed de notícias
    for r in rows:
        if r.get("is_newsworthy") and r.get("cvm_url"):
            enrich_filing_doc(r)
    n = upsert("mw_filings", rows, "id", dry)
    _log(f"  plantão: {len(rows)} comunicados novos da cobertura → {n} gravados "
         f"({sum(1 for r in rows if r.get('doc_title'))} com título do documento)")
    return n


# ═══════════════════ CLI ═══════════════════════════════════════════════════

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Market Watch — aluguel, recompras, insiders, free float, comunicados")
    ap.add_argument("--short", action="store_true", help="aluguel (últimos dias pela API do BDI)")
    ap.add_argument("--backfill-pdf", action="store_true", help="aluguel: histórico pelos PDFs do BDI")
    ap.add_argument("--buybacks", action="store_true")
    ap.add_argument("--insiders", action="store_true")
    ap.add_argument("--float", dest="float_", action="store_true")
    ap.add_argument("--filings", action="store_true")
    ap.add_argument("--all", action="store_true", help="short + buybacks + insiders + float + filings")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--date", help="aluguel: um dia só (YYYY-MM-DD)")
    ap.add_argument("--days", type=int, default=3, help="aluguel pela API: quantos dias p/ trás (default 3) · filings: idem")
    ap.add_argument("--from", dest="from_", help="backfill: data inicial YYYY-MM-DD")
    ap.add_argument("--to", dest="to_", help="backfill: data final YYYY-MM-DD")
    a = ap.parse_args(argv)
    dry = a.dry_run
    if a.all:
        a.short = a.buybacks = a.insiders = a.float_ = a.filings = True
    if not any([a.short, a.backfill_pdf, a.buybacks, a.insiders, a.float_, a.filings]):
        ap.print_help(); return 0
    today = dt.date.today()
    _log(f"=== Market Watch {today} {'(dry-run)' if dry else ''} ===")
    if a.short:
        if a.date:
            days = [a.date]
        else:
            days = [d.isoformat() for d in business_days(today - dt.timedelta(days=a.days + 2), today)]
        _log(f"[aluguel] {days[0]} → {days[-1]}")
        run_short(days, dry)
    if a.backfill_pdf:
        d0 = dt.date.fromisoformat(a.from_ or "2025-12-15")
        d1 = dt.date.fromisoformat(a.to_) if a.to_ else today - dt.timedelta(days=1)
        _log(f"[aluguel/pdf] {d0} → {d1}")
        run_backfill_pdf(d0, d1, dry)
    if a.buybacks:
        _log("[recompras]"); run_buybacks(dry)
    if a.insiders:
        _log("[insiders]"); run_insiders(dry)
    if a.float_:
        _log("[free float]"); run_float(dry)
    if a.filings:
        _log("[comunicados]"); run_filings(a.days, dry)
    _log("=== fim ===")
    return 0


if __name__ == "__main__":
    try:
        from dotenv import load_dotenv  # opcional (dev local)
        load_dotenv(os.path.join(HERE, "..", "..", "news-hunter", ".env"))
        SUPA = os.environ.get("SUPABASE_URL", "").rstrip("/") or SUPA
        SERVICE = os.environ.get("SUPABASE_SERVICE_KEY", "") or SERVICE
    except Exception:  # noqa: BLE001
        pass
    sys.exit(main())
