# -*- coding: utf-8 -*-
"""update_iba_auto.py — IBÁ papel 100% AUTOMÁTICO por VISÃO (Gemini).

O boletim DadosPapel do IBÁ é um PDF **imagem** (sem texto extraível) — por isso
era transcrito à mão. Mas um modelo de VISÃO lê a tabela perfeitamente. Este script:
  1. acha o DadosPapel mais novo em iba.org e vê se é mês novo vs iba_paper;
  2. baixa o PDF e renderiza a página 1 (PyMuPDF);
  3. o Gemini (chave grátis GEMINI_API_KEY, HEADER) lê a tabela → JSON;
  4. CONFERE contra as próprias % impressas do PDF + somas por grade + a identidade
     (produção + importação − exportação = consumo aparente) — 3 checksums independentes;
  5. se TUDO bate → grava só o mês novo em iba_paper (preserva o resto) e sinaliza
     publicação; se algo não bate → NÃO grava e sinaliza "precisa de conferência".

Modos:
  python update_iba_auto.py --check                 # há mês novo?
  python update_iba_auto.py --update                # extrai, confere, grava se bater
  python update_iba_auto.py --dry-run [--pdf X.pdf] # extrai + confere, NÃO grava (teste)
PULP_DB=<caminho> p/ testar em cópia. Env: GEMINI_API_KEY (+ GEMINI_MODEL opcional).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sqlite3
import sys
import warnings
from datetime import datetime
from pathlib import Path

warnings.filterwarnings("ignore")
import requests

HERE = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("PULP_DB") or (HERE / "pulp_paper.db"))
PAGE = "https://iba.org/publicacoes/dados-papel/"
UA = {"User-Agent": "Mozilla/5.0"}
GEMINI_MODEL = os.environ.get("IBA_VISION_MODEL") or os.environ.get("GEMINI_MODEL", "gemini-3.1-flash-lite")
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
# Escalonamento: tenta o modelo LEVE; se o checksum não bater, tenta um mais FORTE antes
# de pedir conferência (decisão do usuário). Normal = 1 chamada; o forte só entra em falha.
VISION_MODELS = [m.strip() for m in (os.environ.get("IBA_VISION_MODELS")
                 or f"{GEMINI_MODEL},gemini-3.1-flash").split(",") if m.strip()]
VISION_MODELS = list(dict.fromkeys(VISION_MODELS))   # únicos, mantendo a ordem

# camada única de e-mail (dedup por fonte+mês+tipo)
sys.path.insert(0, str(HERE.parent / "_shared"))
try:
    import notify
except Exception:
    notify = None

GRADES = ["total", "packaging", "pw", "newsprint", "cardboard", "other"]
METRICS = {"production": "prod", "domestic": "dom", "exports": "exp", "imports": "imp"}

PROMPT = """Você é um extrator de dados PRECISO. A imagem é a tabela "Papel / Paper" do
boletim mensal DadosPapel (IBÁ). Extraia SOMENTE os números da coluna do MÊS
(as colunas sob "Mai / May", NÃO as colunas acumuladas "Jan-Mai / Jan-May").

Linhas (seções e suas sub-linhas por tipo de papel):
  production (Produção): total, packaging (Embalagem), pw (Imprimir e Escrever),
    newsprint (Imprensa), cardboard (Papelcartão), other (Outros)
  domestic (Vendas Domésticas): mesmas 6 sub-linhas
  exports (Exportações): mesmas 6 sub-linhas
  imports (Importações): mesmas 6 sub-linhas
  apparent_consumption (Consumo Aparente): valor único

Para CADA célula dê: prev (coluna do ano anterior, ex. 2025), curr (coluna do ano
atual, ex. 2026) e var (a variação % IMPRESSA na coluna Var.).

Responda APENAS um JSON válido (sem markdown), nesta forma exata:
{"period":"AAAA-MM",
 "production":{"total":{"prev":0,"curr":0,"var":0.0}, "packaging":{...}, "pw":{...},
   "newsprint":{...}, "cardboard":{...}, "other":{...}},
 "domestic":{...}, "exports":{...}, "imports":{...},
 "apparent_consumption":{"prev":0,"curr":0,"var":0.0}}

Regras: milhares com ponto viram inteiros (4.671 → 4671). var é número decimal
(6,9 → 6.9; negativo se houver sinal −). Se uma célula estiver "-" ou vazia, use null.
Não invente linhas; use exatamente essas chaves."""


# ── site / banco ──────────────────────────────────────────────────────────────
def site_latest():
    html = requests.get(PAGE, headers=UA, timeout=60, verify=False).text
    links = re.findall(r'href=["\']([^"\']*DadosPapel[^"\']*\.pdf)["\']', html, re.I)
    if not links:
        return None, None
    def key(u):
        m = re.search(r"DadosPapel[-_](\d{4})[-_](\d{2})", u)
        return (m.group(1), m.group(2)) if m else ("0000", "00")
    best = max(set(links), key=key)
    y, m = key(best)
    url = best if best.startswith("http") else ("https://iba.org" + best if best.startswith("/") else "https://iba.org/" + best)
    return f"{y}-{m}", url


def dash_latest(conn):
    r = conn.execute("SELECT MAX(period) FROM iba_paper").fetchone()
    return r[0] if r and r[0] else None


# ── visão (Gemini) ────────────────────────────────────────────────────────────
def render_png(pdf_bytes: bytes) -> bytes:
    import fitz  # PyMuPDF
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pix = doc[0].get_pixmap(matrix=fitz.Matrix(2, 2))   # 2x p/ legibilidade
    return pix.tobytes("png")


def gemini_extract(png: bytes, model: str = None) -> dict:
    if not GEMINI_KEY:
        raise RuntimeError("GEMINI_API_KEY ausente — não dá p/ extrair por visão.")
    model = model or GEMINI_MODEL
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    body = {"contents": [{"parts": [
        {"inline_data": {"mime_type": "image/png", "data": base64.b64encode(png).decode()}},
        {"text": PROMPT},
    ]}], "generationConfig": {"temperature": 0, "response_mime_type": "application/json"}}
    r = requests.post(url, headers={"x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json"},
                      data=json.dumps(body), timeout=120)
    r.raise_for_status()
    txt = r.json()["candidates"][0]["content"]["parts"][0]["text"]
    txt = re.sub(r"^```(json)?|```$", "", txt.strip(), flags=re.I | re.M).strip()
    return json.loads(txt)


# ── verificação (3 checksums independentes) ───────────────────────────────────
def _close(a, b, tol):
    return a is not None and b is not None and abs(a - b) <= tol


def verify(d: dict) -> list[str]:
    """Devolve lista de problemas. Vazia = passou em tudo → pode publicar."""
    probs = []
    # 1) variação calculada ≈ variação impressa (rounding ~0.35pp)
    for mk in list(METRICS) + ["apparent_consumption"]:
        cells = d.get(mk, {})
        items = cells.items() if mk != "apparent_consumption" else [("_", cells)]
        for gk, c in items:
            if not isinstance(c, dict):
                continue
            prev, curr, var = c.get("prev"), c.get("curr"), c.get("var")
            if prev and curr is not None and var is not None:
                calc = (curr / prev - 1) * 100
                if not _close(calc, var, 0.35):
                    probs.append(f"{mk}.{gk}: var calc {calc:.1f}% ≠ impresso {var:.1f}% (prev {prev}, curr {curr})")
    # 2) soma das grades ≈ total (±2 mil t por arredondamento)
    for mk in METRICS:
        cells = d.get(mk, {})
        tot = (cells.get("total") or {}).get("curr")
        parts = [(cells.get(g) or {}).get("curr") for g in GRADES if g != "total"]
        if tot is not None and all(p is not None for p in parts):
            if not _close(sum(parts), tot, 2.5):
                probs.append(f"{mk}: soma das grades {sum(parts)} ≠ total {tot}")
    # 3) identidade: produção + importação − exportação = consumo aparente
    prod = (d.get("production", {}).get("total") or {}).get("curr")
    imp = (d.get("imports", {}).get("total") or {}).get("curr")
    exp = (d.get("exports", {}).get("total") or {}).get("curr")
    app = (d.get("apparent_consumption") or {}).get("curr")
    if None not in (prod, imp, exp, app):
        if not _close(prod + imp - exp, app, 2.5):
            probs.append(f"identidade: prod {prod} + imp {imp} − exp {exp} = {prod+imp-exp} ≠ consumo {app}")
    return probs


# ── gravação (só o mês novo; preserva o resto) ────────────────────────────────
IBA_COLS = (["period", "year", "month"]
            + [f"{p}_{g}" for p in ("prod", "dom", "exp", "imp") for g in GRADES]
            + ["app_cons", "exprev_total", "exprev_latam", "exprev_europe",
               "exprev_namerica", "exprev_africa", "exprev_asia", "exprev_china"])


def write_period(conn, period, d):
    y, m = int(period[:4]), int(period[5:7])
    row = {"period": period, "year": y, "month": m}
    for mk, pfx in METRICS.items():
        for g in GRADES:
            row[f"{pfx}_{g}"] = (d.get(mk, {}).get(g) or {}).get("curr")
    row["app_cons"] = (d.get("apparent_consumption") or {}).get("curr")
    for c in IBA_COLS:
        row.setdefault(c, None)   # exprev_* ficam null (não estão no PDF)
    conn.execute("DELETE FROM iba_paper WHERE period=?", (period,))
    conn.execute(f"INSERT INTO iba_paper ({','.join(IBA_COLS)}) VALUES ({','.join('?'*len(IBA_COLS))})",
                 [row[c] for c in IBA_COLS])
    conn.commit()


def _gh(**kv):
    gh = os.environ.get("GITHUB_ENV")
    if not gh:
        return
    with open(gh, "a") as f:
        for k, v in kv.items():
            f.write(f"{k}={v}\n")


def _mail(kind, period, subject, body):
    """E-mail dedup'd (1× por mês/tipo). Silencioso se notify/SMTP indisponível."""
    if notify:
        try:
            notify.once("iba_paper", period, kind, subject, body)
        except Exception as e:
            print(f"  (e-mail '{kind}' falhou, ignorado: {e})")


def extract_with_escalation(pdf_bytes):
    """Tenta VISION_MODELS em ordem; para no 1º que passa nos 3 checksums.
    Devolve (d, probs, modelo). probs vazio = passou."""
    png = render_png(pdf_bytes)
    d, probs, model = None, ["não rodou"], None
    for model in VISION_MODELS:
        try:
            d = gemini_extract(png, model)
        except Exception as e:
            print(f"  extração falhou com {model}: {e}")
            d, probs = None, [f"erro de extração ({model}): {e}"]
            continue
        probs = verify(d)
        if not probs:
            return d, [], model
        print(f"  {model}: {len(probs)} checagem(ns) falharam → escalando p/ modelo mais forte…")
    return d, probs, model


def _overdue_check(site_period):
    """Atraso da FONTE. O IBÁ publica o dado de ~2 meses atrás, entre os dias 7-13. Se já passou
    do dia 15 e a FONTE ainda não tem o período esperado (mês atual − 2), avisa (1× por período)."""
    now = datetime.utcnow()
    if now.day < 15:
        return
    y, m = now.year, now.month - 2
    if m <= 0:
        y -= 1; m += 12
    exp = f"{y}-{m:02d}"
    if site_period is None or site_period < exp:
        _mail("overdue", exp, f"⚠️ IBÁ ainda não publicou {exp}",
              f"Já é dia {now.day} e o IBÁ ainda não publicou o boletim DadosPapel de {exp} "
              f"(mais novo no site: {site_period}). Costuma sair entre os dias 7 e 13.\nPágina: {PAGE}")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="IBÁ papel automático por visão (Gemini)")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--update", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--pdf", help="usar um PDF local em vez de baixar (teste; sem e-mail)")
    args = ap.parse_args()

    conn = sqlite3.connect(DB_PATH)
    dash = dash_latest(conn)

    # ── caminho de TESTE: PDF local, sem site, sem e-mail ──
    if args.pdf:
        d, probs, model = extract_with_escalation(Path(args.pdf).read_bytes())
        period = (d or {}).get("period")
        print(f"  período: {period} | modelo: {model} | checagens falhas: {len(probs)}")
        for p in probs[:12]:
            print("   · " + p)
        if not probs and period and not args.dry_run:
            write_period(conn, period, d); print(f"  gravado {period}.")
        elif not probs:
            print("  ✅ passou nos checksums (DRY-RUN — não gravei).")
        conn.close(); return

    period, url = site_latest()
    print(f"IBÁ no site: {period} | dashboard: {dash}")

    if args.check:
        novo = bool(period and (dash is None or period > dash))
        print("MÊS NOVO disponível" if novo else "em dia")
        _gh(IBA_NEW="true" if novo else "false", IBA_SITE=period or "", IBA_DASH=dash or "")
        conn.close(); return

    _overdue_check(period)                     # avisa se a FONTE atrasou

    if not (dash is None or (period and period > dash)):
        print("Sem mês novo — em dia."); _gh(IBA_NEW_DATA="false"); conn.close(); return

    # ── DETECTADO mês novo → e-mail "saiu o dado" (1× por mês) ──
    print(f"  MÊS NOVO detectado: {period}")
    _mail("detected", period, f"📄 Saiu o IBÁ de {period}",
          f"O IBÁ publicou o boletim DadosPapel de {period}. Vou ler por visão e, se conferir, "
          f"publicar no dashboard.\nPágina: {PAGE}")
    _gh(IBA_DETECTED="true", IBA_SITE=period)

    pdf_bytes = requests.get(url, headers=UA, timeout=120, verify=False).content
    print(f"Extraindo por visão (escalona modelos: {VISION_MODELS})…")
    d, probs, model = extract_with_escalation(pdf_bytes)

    if d is None or probs:
        print(f"  ⚠️ não passou (último modelo {model}): {len(probs)} checagem(ns) — NÃO publico.")
        for p in probs[:12]:
            print("   · " + p)
        _mail("review", period, f"⚠️ IBÁ {period} precisa de conferência",
              f"Li o DadosPapel de {period} por visão (tentei os modelos {VISION_MODELS}), mas os "
              f"checksums NÃO bateram. NÃO publiquei. Confira o PDF e atualize à mão.\n\nProblemas:\n- "
              + "\n- ".join(probs[:12]) + f"\n\nPágina: {PAGE}")
        _gh(IBA_NEW_DATA="false", IBA_REVIEW="true", IBA_SITE=period)
        conn.close(); sys.exit(0)

    print(f"  ✅ passou nos 3 checksums (modelo {model}).")
    write_period(conn, period, d)
    print(f"  gravado iba_paper[{period}] (mês novo; resto preservado).")
    _gh(IBA_NEW_DATA="true", IBA_LATEST=period, IBA_MODEL=model)
    conn.close()
    # o e-mail "base atualizada" sai no WORKFLOW, após o commit (só aí publicou de verdade).


if __name__ == "__main__":
    main()
