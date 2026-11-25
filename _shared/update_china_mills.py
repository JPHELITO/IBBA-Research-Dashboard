# -*- coding: utf-8 -*-
"""Usinas chinesas (Mysteel, 247 usinas): acrescenta o boletim semanal novo na tabela `china_mills`.

Toda sexta-feira (~08:35 de Pequim) a Mysteel publica, de graça, a página "Mysteel数据：钢厂高炉检修调查统计（AAAAMMDD）".
O resumo do topo traz os quatro números que a mesa de dados mostra (M&M › Steel › China mills):

  高炉开工率 ......... blast furnaces operating (% dos altos-fornos ligados)
  产能利用率 ......... blast-furnace capacity utilization (% da capacidade de gusa em uso)
  盈利率 ............. share of mills making money (% das 247 usinas com lucro caixa, sem ponderar pela produção)
  日均铁水产量 ....... hot metal output (万吨/dia = 10 mil t/dia; gravado em kt/dia)

Regras: lê a lista de boletins da própria Mysteel e grava só os de data posterior ao último gravado (ignore-duplicates:
nunca reescreve uma semana). Sem a tabela (SQL ainda não rodado) sai sem erro. Número fora da faixa plausível não é
gravado (melhor um furo que um número errado). A Mysteel responde devagar e às vezes recusa a conexão vinda de fora da
China: cada página é tentada algumas vezes, com espera crescente. Falhar só vira erro (e o GitHub avisa) quando o dado
gravado já está velho (mais de 13 dias) — numa falha passageira com o dado em dia, o próximo despertador resolve.
Só biblioteca padrão. Nunca imprime a chave.

uso:  python _shared/update_china_mills.py [--dry]        (SUPABASE_URL e SUPABASE_SERVICE_KEY no ambiente)
"""
import datetime as D
import html as _html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

# a lista completa fica na 1ª; a 2ª (uma subcategoria) é reserva — juntas elas cobrem as semanas em que uma pula boletins
LISTS = ["https://tks.mysteel.com/datas/article/pa4262aaaaaa1.html", "https://tks.mysteel.com/datas/article/pa4262a0311aaaaa1.html"]
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
TITLE_RE = re.compile(r"钢厂高炉检修调查统计\s*[（(]\s*(\d{8})\s*[）)]")
NUM = r"[:：]?(\d{1,3}(?:\.\d+)?)"
FIELDS = {   # coluna da tabela → (padrão no texto sem espaços, faixa plausível)
    "bf_operating_pct": (re.compile(r"高炉开工率" + NUM + "%"), (40.0, 100.0)),
    "bf_util_pct":      (re.compile(r"产能利用率" + NUM + "%"), (50.0, 100.0)),
    "profitable_pct":   (re.compile(r"盈利率" + NUM + "%"), (0.0, 100.0)),
    "hot_metal_10kt":   (re.compile(r"铁水产量" + NUM + "万吨"), (150.0, 300.0)),
}
STALE_DAYS = 13


# ── leitura das páginas (testada em tests/test_china_mills.py) ────────────────────────────────────────────────────────
def decode(raw):
    """bytes → texto (as páginas novas são UTF-8; as antigas às vezes GBK)"""
    head = raw[:3000].decode("ascii", "ignore").lower()
    m = re.search(r"charset\s*=\s*[\"']?([a-z0-9_-]+)", head)
    for enc in ([m.group(1)] if m else []) + ["utf-8", "gb18030"]:
        try:
            return raw.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", "replace")


def plain(s):
    """HTML → texto corrido SEM espaço nenhum (o número às vezes vem separado da palavra: "铁水产量 230.69万吨")"""
    s = re.sub(r"(?is)<(script|style)\b.*?</\1>", "", s)
    s = _html.unescape(re.sub(r"<[^>]+>", " ", s))
    return re.sub(r"\s+", "", s)


def parse_bulletin(page):
    """os quatro números do boletim (texto da página, HTML ou já extraído de PDF) → {coluna: valor}; o que não achar fica de fora.
    Lê a partir do título do artigo quando ele existe (o menu do site também tem "高炉开工率", sem número, mas é melhor não arriscar)."""
    i = page.find('id="content-title"')
    t = plain(page[i:] if i >= 0 else page)
    out = {}
    for col, (rx, (lo, hi)) in FIELDS.items():
        m = rx.search(t)
        if not m:
            continue
        v = float(m.group(1))
        if lo <= v <= hi:
            out[col] = v
    return out


def title_date(page):
    """a data que o título do boletim traz (AAAAMMDD) → 'AAAA-MM-DD', ou None"""
    m = TITLE_RE.search(plain(page))
    if not m:
        return None
    s = m.group(1)
    try:
        return D.date(int(s[:4]), int(s[4:6]), int(s[6:])).isoformat()
    except ValueError:
        return None


def parse_listing(page, base="https://tks.mysteel.com"):
    """lista de artigos da Mysteel → [(data do boletim 'AAAA-MM-DD', url)], só os boletins de altos-fornos, sem repetir data"""
    out, seen = [], set()
    for m in re.finditer(r'href="([^"]*/datas/a/\d+/[0-9A-Fa-f]+\.html)"[^>]*>(.*?)</a>', page, re.S):
        url, txt = m.group(1), m.group(2)
        d = title_date(txt)
        if not d or d in seen:
            continue
        if url.startswith("//"):
            url = "https:" + url
        elif url.startswith("/"):
            url = base + url
        seen.add(d)
        out.append((d, url))
    return sorted(out)


def friday_of(iso):
    """a sexta-feira da semana (segunda a domingo) de uma data: boletim de quarta 30/09 → semana de sexta 02/10"""
    d = D.date.fromisoformat(iso)
    return (d + D.timedelta(days=4 - d.weekday())).isoformat()


def build_row(obs_iso, url, vals, source="robot", kind="mysteel", note=None):
    hm = vals.get("hot_metal_10kt")
    return {"week": friday_of(obs_iso), "obs_date": obs_iso, "profitable_pct": vals.get("profitable_pct"),
            "bf_operating_pct": vals.get("bf_operating_pct"), "bf_util_pct": vals.get("bf_util_pct"),
            "hot_metal_kt": None if hm is None else round(hm * 10, 2), "source_kind": kind, "source_url": url,
            "note": note, "source": source}


# ── rede ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
def fetch(url, tries=4, timeout=40, wait=6.0, opener=None):
    """baixa com paciência (a Mysteel recusa/derruba conexões de fora da China de vez em quando)"""
    last = None
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.5"})
            with (opener or urllib.request.urlopen)(req, timeout=timeout) as r:
                return r.read()
        except Exception as ex:   # noqa: BLE001 — qualquer falha de rede vale nova tentativa
            last = ex
            if k < tries - 1:
                time.sleep(wait * (2 ** k))
    raise RuntimeError(f"{url} não respondeu depois de {tries} tentativas ({type(last).__name__}: {last})")


def _call(method, path, body=None, prefer=None):
    url, key = os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SERVICE_KEY"]
    h = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}
    if prefer:
        h["Prefer"] = prefer
    req = urllib.request.Request(url + "/rest/v1/" + path, data=None if body is None else json.dumps(body).encode(), headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw.decode()) if raw else None)
    except urllib.error.HTTPError as ex:
        return ex.code, ex.read().decode()[:300]


def new_rows(last_obs, get=None, pause=2.0, log=print):
    """os boletins publicados depois de `last_obs` ('AAAA-MM-DD' ou None), já lidos → (linhas, problemas)"""
    get = get or fetch
    found, problems = {}, []
    for u in LISTS:
        try:
            for d, url in parse_listing(decode(get(u))):
                found.setdefault(d, url)
        except Exception as ex:   # noqa: BLE001
            problems.append(f"lista {u}: {ex}")
    rows = []
    for d in sorted(found):
        if last_obs and d <= last_obs:
            continue
        time.sleep(pause)
        try:
            page = decode(get(found[d]))
        except Exception as ex:   # noqa: BLE001
            problems.append(f"boletim de {d}: {ex}")
            continue
        vals = parse_bulletin(page)
        if "profitable_pct" not in vals:
            problems.append(f"boletim de {d}: não achei o 盈利率 (página mudou?) — não gravado")
            continue
        miss = [c for c in FIELDS if c not in vals]
        log(f"{d} (semana de {friday_of(d)}): lucro {vals.get('profitable_pct')}% · utilização {vals.get('bf_util_pct')}% · "
            f"operação {vals.get('bf_operating_pct')}% · gusa {vals.get('hot_metal_10kt')} 万吨/dia" + (f" · sem {', '.join(miss)}" if miss else ""))
        rows.append(build_row(d, found[d], vals))
    return rows, problems


def main(argv):
    dry = "--dry" in argv
    today = (D.datetime.now(D.timezone.utc) + D.timedelta(hours=8)).date()   # Pequim
    st, last = _call("GET", "china_mills?select=week,obs_date&obs_date=not.is.null&order=obs_date.desc&limit=1")
    if st != 200:
        print(f"china_mills ainda não existe ou não respondeu (HTTP {st}) — nada a fazer. Rode admin/supabase_china_mills.sql.")
        return 0
    last_obs = last[0]["obs_date"] if last else None
    if not last_obs:
        print("tabela vazia — carregue o histórico primeiro (data-desk/ferramentas/china_mills_carga.py). Nada a fazer.")
        return 0
    rows, problems = new_rows(last_obs)
    stale = (today - D.date.fromisoformat(last_obs)).days > STALE_DAYS and not rows
    for p in problems:
        print(("::error::" if stale else "::warning::") + p)
    if not rows:
        if stale:
            print(f"::error::o último boletim gravado é de {last_obs} ({(today - D.date.fromisoformat(last_obs)).days} dias) e não achei nenhum novo.")
            return 1
        print(f"nenhum boletim depois de {last_obs} — nada a fazer.")
        return 0
    if dry:
        print(f"(simulação: {len(rows)} linha(s) NÃO gravada(s))")
        return 0
    st, d = _call("POST", "china_mills?on_conflict=week", rows, prefer="resolution=ignore-duplicates,return=minimal")
    if st not in (200, 201, 204):
        print(f"::error::gravação falhou (HTTP {st}) {d}")
        return 1
    print(f"gravado: {len(rows)} linha(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
