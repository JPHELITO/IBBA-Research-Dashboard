#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""quarterly_sec.py — o trimestre da Southern Copper direto da SEC, na mesma tabela da CVM.

A Southern Copper (SCCO) não entrega ITR à CVM: entrega 10-Q e 10-K à SEC. A SEC publica os números de
cada arquivamento em XBRL, já estruturados, numa API aberta e gratuita — é o equivalente dos zips da CVM
que o quarterly.py lê:

  companyfacts  https://data.sec.gov/api/xbrl/companyfacts/CIK0001001838.json
                todo número que a companhia já declarou, conta por conta, com a janela (início→fim), o
                formulário e a data do arquivamento. ~3 MB.
  submissions   https://data.sec.gov/submissions/CIK0001001838.json
                a lista de arquivamentos. É o GATILHO: os 3 MB só são baixados quando aparece um 10-Q/10-K
                mais novo que a nossa última gravação.

⚠️ A SEC exige User-Agent com contato e responde 403 sem ele. Vem do secret SEC_USER_AGENT; na falta, um
genérico da dashboard. Nunca um e-mail pessoal.

O TRIMESTRE SAI COM AS MESMAS REGRAS DA CVM (medido no arquivo da SCCO, set/2026):
  · janela de 3 meses quando existe; senão, acumulado do ano menos o acumulado anterior — e conta que
    falta NUNCA se completa: sem uma das janelas, o campo fica vazio;
  · o 4º trimestre não existe em 10-Q: é o 10-K (ano) menos os nove meses do 3º 10-Q
    (4T25: receita 13.420,0 − 9.550,2 = 3.869,8);
  · a mesma janela aparece em vários arquivamentos (todo 10-Q repete o ano anterior para comparação):
    vale o mais recente ENTRE OS DO PRÓPRIO ANO DO PERÍODO E DO ANO SEGUINTE (o original e a comparação).
    Arquivamento de anos depois só entra onde não há outro. ⚠️ Medido: um 10-Q de 2020 traz o 3T18 com
    receita de 1.753,4, contra 1.723,7 no original e em três arquivamentos seguintes; um 10-K de 2014
    traz o caixa de dez/2010 com menos da metade do valor. "O mais recente vence" puro publicaria os dois.

CONTAS (us-gaap):
  receita      RevenueFromContractWithCustomerExcludingAssessedTax (2017→); antes, Revenues e
               RevenueMineralSales — a SCCO usou as duas, e do 3T15 ao 4T16 só a segunda
  EBIT         OperatingIncomeLoss
  D&A          DepreciationDepletionAndAmortization         → EBITDA contábil = EBIT + D&A, como na CVM
  lucro        NetIncomeLoss (atribuído à SCC). No trimestre a SCCO só declara o lucro com os minoritários
               e a parcela deles → lucro = ProfitLoss − minoritários (ano de 2025: 4.348,2 − 13,3 = 4.334,9,
               exatamente o NetIncomeLoss do 10-K)
  caixa oper.  NetCashProvidedByUsedInOperatingActivities (…ContinuingOperations até 2014)
  capex        PaymentsToAcquirePropertyPlantAndEquipment (positivo, como na CVM)
  caixa        CashAndCashEquivalentsAtCarryingValue + ShortTermInvestments  (= 1.01.01 + 1.01.02 da CVM)
  dívida       LongTermDebtNoncurrent + LongTermDebtCurrent (parcela curta ausente = não há parcela curta)
  ações        emitidas: CommonStockSharesIssued no fim do trimestre (os 10-K de 2013–2015 a declaram em
               MILHARES, 884.596 — a escala sai contra a contagem da capa). Em circulação: a CAPA do próprio
               10-Q/10-K (dei:EntityCommonStockSharesOutstanding), datada ~1 mês depois do fim — a SEC não
               traz a posição do fim do trimestre. Tesouraria fica vazia: seria a conta de duas datas.
  Custo e lucro bruto ficam VAZIOS de propósito: o "cost of sales" da SCCO exclui a depreciação e o 3.02
  da CVM inclui. A mesma coluna com duas definições é pior que a coluna vazia.

Grava em quarterly_kpis com currency=USD, scale=MIL (milhares, como a CVM) e source=SEC.

Modos:
  python _shared/quarterly_sec.py                # só trabalha se houver 10-Q/10-K novo
  python _shared/quarterly_sec.py --forcar       # baixa e grava mesmo sem arquivamento novo
  python _shared/quarterly_sec.py --dry-run      # mostra o que gravaria
  python _shared/quarterly_sec.py --sem-email    # não avisa por e-mail (carga de histórico)

Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (p/ gravar) · SEC_USER_AGENT (opcional) · SMTP_USER, SMTP_PASS (aviso).
Nunca sai != 0 por problema de dado ou de rede.
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import quarterly as Q  # noqa: E402
from market_watch import _log, rest_get, upsert  # noqa: E402

# ticker do Stock Guide → CIK na SEC. A Ternium (CIK 1342874) também arquiva lá, mas em 6-K/20-F no
# padrão IFRS, sem o trimestre estruturado — não serve por este caminho.
EMPRESAS = {"SCCO": {"cik": 1001838, "nome": "Southern Copper"}}
URL_FACTS = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json"
URL_SUBS = "https://data.sec.gov/submissions/CIK{cik:010d}.json"
UA_PADRAO = "IBBA Research Dashboard admin@example.com"
FORMULARIOS = ("10-Q", "10-K", "10-Q/A", "10-K/A")

# a mesma grandeza em contas que trocaram de nome: a atual primeiro
RECEITA = ("RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenueMineralSales")
CAIXA_OPERACIONAL = ("NetCashProvidedByUsedInOperatingActivities",
                     "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations")


# ── leitura do companyfacts ──────────────────────────────────────────────────

def _fatos(facts: dict, conta: str, unidade: str = "USD", taxonomia: str = "us-gaap") -> list[dict]:
    return ((((facts or {}).get("facts") or {}).get(taxonomia) or {}).get(conta) or {}).get("units", {}).get(unidade) or []


def _do_ano_ou_seguinte(f: dict, fim: str) -> bool:
    """O arquivamento é do ano do período ou do seguinte? (o original, a comparação do ano seguinte e o
    10-K que fecha o ano)"""
    try:
        return f.get("fy") is None or int(fim[:4]) <= int(f["fy"]) <= int(fim[:4]) + 1
    except (TypeError, ValueError):
        return True


def _janelas_nivel(fatos: list[dict]) -> dict[tuple[str, str], tuple[int, str, float]]:
    """{(início, fim): (nível, arquivado em, valor)}; posição de balanço não tem início → ('', fim).

    Nível 0 = arquivamento do próprio ano do período ou do seguinte; nível 1 = qualquer outro, que só vale
    onde não há nível 0. No mesmo nível, vence o mais recente. Só 10-Q e 10-K (e emendas): prospecto e 8-K
    trazem pro forma."""
    melhor: dict[tuple[str, str], tuple[int, str, float]] = {}
    for f in fatos:
        if not str(f.get("form") or "").startswith("10-"):
            continue
        fim, val = f.get("end"), f.get("val")
        if not fim or val is None:
            continue
        k = (f.get("start") or "", fim)
        cand = (0 if _do_ano_ou_seguinte(f, fim) else 1, f.get("filed") or "", float(val))
        atual = melhor.get(k)
        if atual is None or cand[0] < atual[0] or (cand[0] == atual[0] and cand[1] >= atual[1]):
            melhor[k] = cand
    return melhor


def _janelas(fatos: list[dict]) -> dict[tuple[str, str], float]:
    return {k: v for k, (_, _, v) in _janelas_nivel(fatos).items()}


def _uniao(facts: dict, contas: tuple[str, ...], unidade: str = "USD") -> dict[tuple[str, str], float]:
    """Contas que trocaram de nome: por janela, primeiro o nível do arquivamento, depois a ordem da lista."""
    melhor: dict[tuple[str, str], tuple[int, int, float]] = {}
    for ordem, conta in enumerate(contas):
        for k, (nivel, _, v) in _janelas_nivel(_fatos(facts, conta, unidade)).items():
            if k not in melhor or (nivel, ordem) < melhor[k][:2]:
                melhor[k] = (nivel, ordem, v)
    return {k: v for k, (_, _, v) in melhor.items()}


def _lucro(facts: dict) -> dict[tuple[str, str], float]:
    """Lucro atribuído aos acionistas da SCC, janela a janela."""
    total = _janelas_nivel(_fatos(facts, "ProfitLoss"))
    minoritarios = _janelas_nivel(_fatos(facts, "NetIncomeLossAttributableToNoncontrollingInterest"))
    melhor = {k: (max(total[k][0], minoritarios[k][0]), 1, total[k][2] - minoritarios[k][2])
              for k in total if k in minoritarios}
    for k, (nivel, _, v) in _janelas_nivel(_fatos(facts, "NetIncomeLoss")).items():
        if k not in melhor or (nivel, 0) < melhor[k][:2]:       # a conta pronta vence a feita no mesmo nível
            melhor[k] = (nivel, 0, v)
    return {k: v for k, (_, _, v) in melhor.items()}


def _fim(ano: int, q: int) -> str:
    return dt.date(ano, 3 * q, (31, 30, 30, 31)[q - 1]).isoformat()


def fluxo(janelas: dict[tuple[str, str], float], ano: int, q: int) -> float | None:
    """O trimestre isolado de uma conta de resultado ou de fluxo de caixa."""
    fim = _fim(ano, q)
    for (ini, f), v in janelas.items():
        if f == fim and ini and Q._meses(ini, f) == 3:
            return v
    acumulado = janelas.get((f"{ano}-01-01", fim))
    if acumulado is None or q == 1:
        return acumulado
    anterior = janelas.get((f"{ano}-01-01", _fim(ano, q - 1)))
    return None if anterior is None else acumulado - anterior


def _capas(facts: dict) -> dict[str, float]:
    """{'2026Q2': ações em circulação na capa do 10-Q do 2º trimestre de 2026}."""
    out: dict[str, tuple[str, float]] = {}
    for f in _fatos(facts, "EntityCommonStockSharesOutstanding", "shares", "dei"):
        fy, fp = f.get("fy"), f.get("fp")
        if not str(f.get("form") or "").startswith("10-") or not fy or fp not in ("Q1", "Q2", "Q3", "FY"):
            continue
        q = 4 if fp == "FY" else int(fp[1])
        try:
            capa, fim = dt.date.fromisoformat(f["end"]), dt.date.fromisoformat(_fim(int(fy), q))
        except (KeyError, TypeError, ValueError):
            continue
        # a capa é datada DEPOIS do fim do período (10-Q ~30 dias, 10-K ~60); fora disso o carimbo do
        # período está errado e a contagem é de outro trimestre
        if not fim < capa <= fim + dt.timedelta(days=100):
            continue
        tri, quando = f"{fy}Q{q}", f.get("filed") or ""
        if tri not in out or quando >= out[tri][0]:
            out[tri] = (quando, float(f["val"]))
    return {t: v for t, (_, v) in out.items()}


def montar(facts: dict, ticker: str) -> list[dict]:
    """companyfacts → uma linha por trimestre, no formato do quarterly_kpis (milhares de US$)."""
    receita = _uniao(facts, RECEITA)
    ebit = _janelas(_fatos(facts, "OperatingIncomeLoss"))
    deprec = _janelas(_fatos(facts, "DepreciationDepletionAndAmortization"))
    lucro = _lucro(facts)
    caixa_oper = _uniao(facts, CAIXA_OPERACIONAL)
    investimento = _janelas(_fatos(facts, "PaymentsToAcquirePropertyPlantAndEquipment"))
    caixa = _janelas(_fatos(facts, "CashAndCashEquivalentsAtCarryingValue"))
    aplicacoes = _janelas(_fatos(facts, "ShortTermInvestments"))
    divida_lp = _janelas(_fatos(facts, "LongTermDebtNoncurrent"))
    divida_cp = _janelas(_fatos(facts, "LongTermDebtCurrent"))
    divida_total = _janelas(_fatos(facts, "LongTermDebt"))
    emitidas = _janelas(_fatos(facts, "CommonStockSharesIssued", "shares"))
    capas = _capas(facts)

    def mil(x: float | None) -> float | None:
        return None if x is None else round(x / 1000.0, 3)

    linhas = []
    for ano in sorted({int(fim[:4]) for _, fim in receita}):
        for q in (1, 2, 3, 4):
            rec = fluxo(receita, ano, q)
            if rec is None:
                continue
            fim, tri = _fim(ano, q), f"{ano}Q{q}"
            e, d = fluxo(ebit, ano, q), fluxo(deprec, ano, q)
            if d is not None and d <= 0:             # add-back negativo = janelas de safras que não casam
                d = None
            capex = fluxo(investimento, ano, q)
            if capex is not None and capex < 0:
                capex = None
            c = caixa.get(("", fim))
            cash = None if c is None else c + (aplicacoes.get(("", fim)) or 0.0)
            lp = divida_lp.get(("", fim))
            debt = lp + (divida_cp.get(("", fim)) or 0.0) if lp is not None else divida_total.get(("", fim))
            circulacao = capas.get(tri)
            emit = emitidas.get(("", fim))
            if emit:
                emit *= Q._escala(emit, circulacao)
            linhas.append({
                "company": ticker, "quarter": tri, "period_end": fim,
                "net_revenue": mil(rec), "cogs": None, "gross_profit": None,
                "ebit": mil(e), "d_a": mil(d),
                "ebitda": mil(e + d) if (e is not None and d is not None) else None,
                "net_income": mil(fluxo(lucro, ano, q)),
                "ocf": mil(fluxo(caixa_oper, ano, q)), "capex": mil(capex),
                "cash": mil(cash), "debt": mil(debt),
                "net_debt": mil(debt - cash) if (debt is not None and cash is not None) else None,
                "shares_total": None if not emit else int(round(emit)), "shares_treasury": None,
                "shares_out": None if circulacao is None else int(round(circulacao)),
                "currency": "USD", "scale": "MIL", "source": "SEC",
            })
    return linhas


# ── arquivamentos (o gatilho) ────────────────────────────────────────────────

def arquivamentos(subs: dict | None) -> list[dict]:
    """10-Q/10-K da lista de arquivamentos, do mais antigo para o mais novo."""
    r = ((subs or {}).get("filings") or {}).get("recent") or {}
    out = []
    for i, form in enumerate(r.get("form") or []):
        if form not in FORMULARIOS:
            continue
        try:
            out.append({"form": form, "filed": r["filingDate"][i], "report": r["reportDate"][i],
                        "accepted": r["acceptanceDateTime"][i], "accession": r["accessionNumber"][i]})
        except (KeyError, IndexError, TypeError):
            continue
    return sorted(out, key=lambda a: a["accepted"])


def recebidos(lista: list[dict], ticker: str) -> dict[tuple[str, str], dt.date]:
    """{(ticker, trimestre): data do arquivamento ORIGINAL} — a emenda não é a entrega."""
    out: dict[tuple[str, str], dt.date] = {}
    for a in lista:
        tri = Q._tri(a["report"])
        if not tri or a["form"].endswith("/A"):
            continue
        try:
            d = dt.date.fromisoformat(a["filed"][:10])
        except (TypeError, ValueError):
            continue
        k = (ticker, tri)
        if k not in out or d < out[k]:
            out[k] = d
    return out


def ha_novidade(ultimo: dict, ticker: str) -> bool:
    """O último 10-Q/10-K foi aceito pela SEC depois da nossa última gravação? Erro responde SIM."""
    ult = rest_get("quarterly_kpis", f"select=updated_at&company=eq.{ticker}&source=eq.SEC"
                                     "&order=updated_at.desc&limit=1")
    if not ult:
        return True
    try:
        nosso = dt.datetime.fromisoformat(str(ult[0]["updated_at"]).replace("Z", "+00:00"))
        aceito = dt.datetime.fromisoformat(str(ultimo["accepted"]).replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError):
        return True
    return aceito > nosso


def pronto(linhas: list[dict], ultimo: dict | None) -> bool:
    """O companyfacts já tem o trimestre do último arquivamento?

    A lista de arquivamentos anda antes do companyfacts. Gravar sem o trimestre novo avançaria o
    updated_at e o gatilho não dispararia de novo até o PRÓXIMO 10-Q — três meses depois."""
    if not ultimo:
        return True
    tri = Q._tri(ultimo.get("report") or "")
    return tri is None or tri in {l["quarter"] for l in linhas}


# ── execução ────────────────────────────────────────────────────────────────

def _cabecalho() -> dict:
    return {"User-Agent": (os.environ.get("SEC_USER_AGENT") or "").strip() or UA_PADRAO,
            "Accept-Encoding": "gzip, deflate"}


def baixar(url: str, tentativas: int = 3) -> dict | None:
    nome = url.rsplit("/", 1)[-1]
    for i in range(tentativas):
        try:
            r = requests.get(url, headers=_cabecalho(), timeout=(20, 180))
            if r.status_code == 200:
                return r.json()
            _log(f"  [sec] {nome}: HTTP {r.status_code}")
            if r.status_code in (403, 404):          # 403 = User-Agent recusado; insistir não muda nada
                return None
        except (requests.RequestException, ValueError) as e:
            _log(f"  [sec] {nome}: {e}")
        if i < tentativas - 1:
            time.sleep(5 * (i + 1))
    return None


def run(ticker: str, info: dict, dry: bool, forcar: bool, sem_email: bool) -> int:
    lista = arquivamentos(baixar(URL_SUBS.format(cik=info["cik"])))
    ultimo = lista[-1] if lista else None
    if ultimo:
        _log(f"  [sec] {ticker}: último {ultimo['form']} de {ultimo['report']} (arquivado em {ultimo['filed']})")
    else:
        _log(f"  [sec] {ticker}: não li a lista de arquivamentos — vou baixar por precaução")
    if not (forcar or dry) and ultimo and not ha_novidade(ultimo, ticker):
        _log(f"  [sec] {ticker}: nada novo desde a nossa última gravação")
        return 0
    facts = baixar(URL_FACTS.format(cik=info["cik"]))
    linhas = montar(facts, ticker) if facts else []
    if not linhas:
        _log(f"  [sec] {ticker}: nenhum trimestre montado — tento na próxima rodada")
        return 0
    if not pronto(linhas, ultimo):
        _log(f"  [sec] {ticker}: o {ultimo['form']} de {ultimo['report']} ainda não chegou ao companyfacts "
             "— não gravo, tento na próxima rodada")
        return 0
    com_lucro = sum(1 for l in linhas if l["net_income"] is not None)
    _log(f"  [sec] {ticker}: {len(linhas)} trimestres ({linhas[0]['quarter']} → {linhas[-1]['quarter']}); "
         f"{com_lucro} com lucro")
    n = upsert("quarterly_kpis", linhas, "company,quarter", dry)
    _log(f"  {n} linha(s) gravada(s)")
    if n == len(linhas):
        Q.notificar(linhas, recebidos(lista, ticker), {ticker: info["nome"]}, "à SEC", dry, sem_email)
    return n


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Quarterly — Southern Copper pela SEC (XBRL)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--forcar", action="store_true", help="baixa mesmo sem 10-Q/10-K novo")
    ap.add_argument("--sem-email", action="store_true", help="não avisa por e-mail (carga de histórico)")
    a = ap.parse_args(argv)
    _log(f"=== Quarterly SEC {Q.hoje_sp()} {'(dry-run)' if a.dry_run else ''} ===")
    for ticker, info in EMPRESAS.items():
        try:
            run(ticker, info, a.dry_run, a.forcar, a.sem_email)
        except Exception as e:  # noqa: BLE001 — empresa que falha não derruba a rodada
            _log(f"  [sec] {ticker}: erro inesperado ({type(e).__name__}: {e}) — segue")
    _log("=== fim ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
