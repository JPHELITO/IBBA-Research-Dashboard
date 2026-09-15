#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""quarterly.py — cheat sheet trimestral: os números do resultado, empresa por empresa.

Tudo vem de fonte pública e gratuita: os formulários que as próprias companhias entregam
à CVM. Mesma família dos zips que o Market Watch já lê (latin-1, ';').

  ITR  https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/ITR/DADOS/itr_cia_aberta_{ano}.zip
       1º, 2º e 3º trimestres. Traz a janela do TRIMESTRE ISOLADO (01/04→30/06) ao lado
       da acumulada (01/01→30/06) — e o mesmo trimestre do ano anterior na mesma linha
       (ORDEM_EXERC = PENÚLTIMO), então o YoY sai do próprio arquivo.
  DFP  https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/DFP/DADOS/dfp_cia_aberta_{ano}.zip
       O ano fechado. ⚠️ O 4º TRIMESTRE NÃO EXISTE em lugar nenhum: é o ano inteiro menos
       os nove meses do 3º ITR. É assim que o mercado calcula, e é assim que fazemos aqui.

Arquivos usados de cada zip (os outros, inclusive o DMPL de 99 MB, são ignorados):
  *_DRE_con_*   demonstração do resultado  → receita, custo, EBIT, lucro
  *_DFC_MI_con_*  fluxo de caixa indireto  → depreciação (p/ o EBITDA), capex, caixa operacional
  *_BPA_con_* / *_BPP_con_*   balanço      → caixa e dívida (posição no fim do trimestre)
  *_composicao_capital_*      ações        → emitidas, em tesouraria e em circulação (fim do período)
  {itr,dfp}_cia_aberta_{ano}.csv   índice  → quando cada documento foi entregue (DT_RECEB) — é o que
                                              separa "saiu agora" de "carga de histórico" no aviso
Sempre o CONSOLIDADO (`con`) — é o que o analista lê.

⚠️ O QUE ESTE ROBÔ NÃO FAZ, e é preciso dizer na tela: o EBITDA aqui é **contábil**
(EBIT + depreciação/amortização/exaustão do fluxo de caixa), NÃO o "EBITDA ajustado" que a
companhia publica no release. A Vale, por exemplo, exclui Brumadinho do ajustado; este não
exclui. Volume vendido, preço realizado e custo caixa também não estão na demonstração
financeira — vivem no release, e por isso ficam de fora.

AÇÕES — ⚠️ A ESCALA MUDA DE UM FORMULÁRIO PARA O OUTRO, e o arquivo não diz qual é (medido em
set/2026): Vale, Bradespar e Irani informam em MILHARES (4.255.763 = 4,26 bi de ações), a CSN em
unidades, e a Suzano trocou no meio de 2025 (1T25 1.264.117.615; 2T25 1.264.118). A escala sai LINHA A
LINHA, contra a contagem do Formulário de Referência que o Market Watch grava (`mw_share_capital`). E o
arquivo tem erro de digitação: o DFP 2025 da CSN Mineração tem um zero a mais (54,3 bi entre 5,49 bi e
5,43 bi) e o 1T26 da Suzano, 280 mi em tesouraria entre 28 mi e 31 mi. Número que destoa 5× dos dois
vizinhos, que concordam entre si, é descartado — campo vazio, nunca número errado.

CÂMBIO — a PTAX (BCB, SGS 1) média e de fim de cada trimestre fechado vai para `quarterly_fx` a cada
rodada: é o que liga o botão US$ da página Quarterly.

AVISO — trimestre entregue há até 21 dias, de empresa com modelo publicado que ainda não cobre esse
trimestre, vira e-mail para o analista subir o modelo (um por empresa e trimestre, lembrado no
update_log). Carga de histórico nunca avisa: o documento é velho.

HISTÓRICO DISPONÍVEL (medido em 2026-09-11): o ITR começa em **2011** e o DFP em **2010**;
como cada ITR carrega o ano anterior, a série sai de **2010Q1**. Semeado: 654 trimestres,
66 por empresa nas 8 mais antigas (Aura e CSN Mineração só existem na CVM desde 2019).
O dia a dia roda 3 anos — o resto é passado e não muda.

Modos:
  python _shared/quarterly.py                      # últimos 3 anos (ITR + DFP)
  python _shared/quarterly.py --anos 2025 2026
  python _shared/quarterly.py --anos $(seq 2010 2026) --sem-email   # backfill (0,6 GB, ~8 min)
  python _shared/quarterly.py --dry-run            # mostra o que gravaria
  python _shared/quarterly.py --tabela VALE3       # imprime a série de uma empresa

Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (obrigatórios p/ gravar) · SMTP_USER, SMTP_PASS (aviso).
Nunca sai != 0 por problema de dado — ano que falhou é logado e os outros seguem.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import math
import os
import re
import sys
import time
import zipfile

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from market_watch import COMPANIES, _log, rest_get, upsert  # noqa: E402

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"}
CVM_ITR = "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/ITR/DADOS/itr_cia_aberta_{y}.zip"
CVM_DFP = "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/DFP/DADOS/dfp_cia_aberta_{y}.zip"
BCB_PTAX = ("https://api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados?formato=json"
            "&dataInicial={ini}&dataFinal={fim}")

CNPJ_TO_TICKER = {v["cnpj"]: k for k, v in COMPANIES.items()}

# página e ticker do Stock Guide (a Aura é AUGO lá; a CVM a conhece como AURA33 — o mesmo _q_filed_ticker do SQL)
PAGINA = "https://metals-mining-pulp-paper-dashboard.vercel.app/quarterly.html"
TICKER_PAGINA = {"AURA33": "AUGO"}
JANELA_AVISO_DIAS = 21

# ── contas da CVM, por CÓDIGO ────────────────────────────────────────────────
# O plano de contas é padronizado: o código é o mesmo em todas as companhias (conferido
# nas 11 da cobertura). É por isso que aqui se lê por código, e não por rótulo.
DRE = {
    "net_revenue":  "3.01",     # Receita de Venda de Bens e/ou Serviços
    "cogs":         "3.02",     # Custo dos Bens e/ou Serviços Vendidos
    "gross_profit": "3.03",     # Resultado Bruto
    "ebit":         "3.05",     # Resultado Antes do Resultado Financeiro e dos Tributos
    "fin_result":   "3.06",     # Resultado Financeiro
    "pretax":       "3.07",     # Resultado Antes dos Tributos
}
# Lucro atribuído ao CONTROLADOR (3.11.01) é o que vira LPA e o que o mercado cita. A Aura
# preenche 0 ali (estrutura de emissora estrangeira) → cai no consolidado (3.11).
LUCRO_CONTROLADOR, LUCRO_CONSOLIDADO = "3.11.01", "3.11"
CAIXA = ("1.01.01", "1.01.02")              # caixa e equivalentes + aplicações financeiras
DIVIDA = ("2.01.04", "2.02.01")             # empréstimos e financiamentos, circulante + não circulante
OCF = "6.01"                                # caixa líquido das atividades operacionais

# ⚠️ Depreciação NÃO tem código fixo: cada companhia põe num subitem diferente do 6.01
#    (Vale 6.01.01.05 · Suzano/Gerdau/Klabin 6.01.01.02 · Usiminas 6.01.01.04) e a Klabin
#    ainda separa a exaustão dos ativos biológicos numa linha própria. Então aqui é por
#    RÓTULO, como no boletim da B3 e no IABr.
_DA_SIM = re.compile(r"deprecia|exaust")
_DA_AMORT = re.compile(r"amortiza")
# "amortização" também é usada para dívida e para custo de transação — isso NÃO é D&A.
_DA_NAO = re.compile(r"custo de transacao|agio|desagio|divida|emprestimo|financiamento|debentur|arrendamento a pagar")
_CAPEX = re.compile(r"imobilizado|intangivel|ativo fixo")
_CAPEX_NAO = re.compile(r"venda|aliena|recebiment|baixa")

# ações: sem o Formulário de Referência, abaixo deste piso a contagem só pode estar em milhares
PISO_ACOES = 10_000_000
FATOR_PICO = 5          # destoa 5× dos dois vizinhos…
FATOR_VIZINHOS = 2      # …que concordam entre si → erro de digitação


def _deaccent(s: str) -> str:
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFD", str(s or "")) if unicodedata.category(c) != "Mn")


def _num(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _inteiro(v) -> int | None:
    x = _num(v)
    return None if x is None else int(x)


def hoje_sp() -> dt.date:
    """Hoje no relógio de São Paulo (sem horário de verão desde 2019)."""
    return (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=3)).date()


def tri_pt(tri: str) -> str:
    """'2026Q3' → '3T26'."""
    return f"{tri[-1]}T{tri[2:4]}"


def _milhar(x: float) -> str:
    return f"{x:,.0f}".replace(",", ".")


def _tri(fim: str) -> str | None:
    """'2026-06-30' → '2026Q2'. Só fecha em março/junho/setembro/dezembro."""
    try:
        d = dt.date.fromisoformat(fim[:10])
    except (TypeError, ValueError):
        return None
    if d.month not in (3, 6, 9, 12):
        return None
    return f"{d.year}Q{d.month // 3}"


def _meses(ini: str, fim: str) -> int | None:
    """Quantos meses a janela cobre (3 = trimestre isolado, 6/9/12 = acumulado)."""
    try:
        a, b = dt.date.fromisoformat(ini[:10]), dt.date.fromisoformat(fim[:10])
    except (TypeError, ValueError):
        return None
    return (b.year - a.year) * 12 + (b.month - a.month) + 1


def _folhas(contas: dict[str, float], casa: re.Pattern, veta: re.Pattern | None,
            prefixo: str, rotulo) -> list[str]:
    """Códigos que casam o rótulo, SEM pai e filho ao mesmo tempo.

    Se '6.01.01.02' e '6.01.01.02.01' casassem os dois, o valor entraria duas vezes — o
    filho é detalhe do pai. Fica o mais alto (o pai)."""
    achou = []
    for cd in contas:
        if not cd.startswith(prefixo):
            continue
        ds = _deaccent(rotulo(cd)).lower()
        if not casa.search(ds) or (veta and veta.search(ds)):
            continue
        achou.append(cd)
    return [c for c in achou if not any(o != c and c.startswith(o + ".") for o in achou)]


def _da(contas: dict[str, float], rotulo) -> float | None:
    """Depreciação + amortização + exaustão do trecho operacional do fluxo de caixa."""
    cods = _folhas(contas, _DA_SIM, None, "6.01", rotulo)
    cods += [c for c in _folhas(contas, _DA_AMORT, _DA_NAO, "6.01", rotulo) if c not in cods]
    cods = [c for c in cods if not any(o != c and c.startswith(o + ".") for o in cods)]
    if not cods:
        return None
    total = sum(contas[c] for c in cods)
    return total if total > 0 else None      # add-back negativo = leitura errada, melhor não publicar


def _capex(contas: dict[str, float], rotulo) -> float | None:
    """Saída de caixa para imobilizado/intangível (devolvida POSITIVA)."""
    cods = [c for c in _folhas(contas, _CAPEX, _CAPEX_NAO, "6.02", rotulo) if (contas.get(c) or 0) < 0]
    if not cods:
        return None
    return -sum(contas[c] for c in cods)


# ── leitura dos zips ─────────────────────────────────────────────────────────

def baixar(url: str, tentativas: int = 3) -> bytes | None:
    """O servidor da CVM derruba conexão sob carga (medido). Três tentativas com espera
    crescente; timeout separado p/ conectar e p/ ler — 20s p/ o aperto de mão, 10 min p/ os
    ~20 MB. Ano que não vem é logado e os outros seguem: o upsert não apaga nada, então
    rodada incompleta atrasa, não estraga."""
    nome = url.rsplit("/", 1)[-1]
    for i in range(tentativas):
        try:
            r = requests.get(url, headers=UA, timeout=(20, 600))
            if r.status_code == 404:          # DFP do ano corrente ainda não existe
                _log(f"  [cvm] {nome}: ainda não publicado")
                return None
            if r.status_code != 200:
                _log(f"  [cvm] {nome}: HTTP {r.status_code}")
                return None
            return r.content
        except Exception as e:  # noqa: BLE001
            if i == tentativas - 1:
                _log(f"  [cvm] {nome}: {e}")
                return None
            time.sleep(5 * (i + 1))
    return None


def _linhas(z: zipfile.ZipFile, frag: str):
    nome = [n for n in z.namelist() if frag in n]
    if not nome:
        return
    with z.open(nome[0]) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="latin-1", newline=""), delimiter=";")


def _colher(z: zipfile.ZipFile, frag: str, periodo: bool) -> tuple[dict, dict]:
    """Lê um CSV do zip → {(ticker, ini, fim): {codigo: valor}} + {codigo: rótulo}.

    `periodo=False` para balanço (posição numa data, sem janela). Versão maior de um mesmo
    documento SUBSTITUI a anterior — reapresentação é correção, não linha nova."""
    contas: dict[tuple, dict[str, float]] = {}
    versao: dict[tuple, int] = {}
    # ⚠️ RÓTULO NA MESMA CHAVE DO VALOR — não por empresa, e muito menos por código solto.
    # Só o topo do plano de contas da CVM é fixo (3.01 receita, 1.01.01 caixa, 6.01 caixa
    # operacional). Abaixo disso o código é LIVRE e a companhia troca entre um protocolo e
    # outro: a depreciação da Vale é 6.01.01.05 num e 6.01.01.06 noutro, e no 2º o
    # 6.01.01.06 é outra conta. Medido: a Vale saiu com D&A de −2.198 no 2T25.
    rotulos: dict[tuple, dict[str, str]] = {}
    for r in _linhas(z, frag):
        t = CNPJ_TO_TICKER.get(r.get("CNPJ_CIA"))
        if not t:
            continue
        fim = (r.get("DT_FIM_EXERC") or "")[:10]
        ini = (r.get("DT_INI_EXERC") or "")[:10] if periodo else ""
        if not fim or (periodo and not ini):
            continue
        k = (t, ini, fim)
        v = int(r.get("VERSAO") or 1)
        if v < versao.get(k, 0):
            continue
        if v > versao.get(k, 0):
            versao[k] = v
            contas[k] = {}
            rotulos[k] = {}
        val = _num(r.get("VL_CONTA"))
        if val is None:
            continue
        cd = r.get("CD_CONTA") or ""
        contas.setdefault(k, {})[cd] = val
        rotulos.setdefault(k, {})[cd] = r.get("DS_CONTA") or ""
    return contas, rotulos


def _capital(z: zipfile.ZipFile) -> dict[tuple[str, str], tuple[int | None, int | None]]:
    """{(ticker, 'AAAA-MM-DD'): (total, tesouraria)} da composição do capital, versão mais nova.

    Número CRU: a escala (unidade ou milhar) muda de formulário para formulário e é decidida em
    `acoes`, linha a linha."""
    out: dict[tuple[str, str], tuple[int | None, int | None]] = {}
    versao: dict[tuple[str, str], int] = {}
    for r in _linhas(z, "composicao_capital"):
        t = CNPJ_TO_TICKER.get(r.get("CNPJ_CIA"))
        fim = (r.get("DT_REFER") or "")[:10]
        if not t or not fim:
            continue
        k, v = (t, fim), int(r.get("VERSAO") or 1)
        if v < versao.get(k, 0):
            continue
        versao[k] = v
        out[k] = (_inteiro(r.get("QT_ACAO_TOTAL_CAP_INTEGR")), _inteiro(r.get("QT_ACAO_TOTAL_TESOURO")))
    return out


_INDICE = re.compile(r"(itr|dfp)_cia_aberta_\d{4}\.csv$")


def _indice(z: zipfile.ZipFile) -> dict[tuple[str, str], dt.date]:
    """{(ticker, 'AAAA-MM-DD'): data da 1ª entrega do documento} — o índice do próprio zip (DT_RECEB).
    A reapresentação não é a entrega: vale a data mais antiga entre as versões."""
    nomes = [n for n in z.namelist() if _INDICE.search(n)]
    out: dict[tuple[str, str], dt.date] = {}
    if not nomes:
        return out
    with z.open(nomes[0]) as f:
        for r in csv.DictReader(io.TextIOWrapper(f, encoding="latin-1", newline=""), delimiter=";"):
            t = CNPJ_TO_TICKER.get(r.get("CNPJ_CIA"))
            fim = (r.get("DT_REFER") or "")[:10]
            try:
                d = dt.date.fromisoformat((r.get("DT_RECEB") or "")[:10])
            except ValueError:
                continue
            if t and fim and ((t, fim) not in out or d < out[(t, fim)]):
                out[(t, fim)] = d
    return out


def ler_zip(z: zipfile.ZipFile, doc: str) -> dict:
    """Um zip da CVM (doc = 'ITR' ou 'DFP') → demonstrações, composição do capital e datas de entrega."""
    def _com_reserva(frag_con: str, frag_ind: str, periodo: bool):
        """Consolidado; individual SÓ para quem não publica consolidado.
        A Bradespar é holding e entrega só o individual — sem isto ela some da tela."""
        c, rc = _colher(z, frag_con, periodo)
        com_con = {k[0] for k in c}
        i, ri = _colher(z, frag_ind, periodo)
        for k, v in i.items():
            if k[0] not in com_con:
                c[k] = v
        for k, v in ri.items():
            if k[0] not in com_con:
                rc.setdefault(k, v)
        return c, rc   # rótulos vêm na MESMA chave de janela dos valores

    dre, rot_dre = _com_reserva("DRE_con", "DRE_ind", True)
    dfc, rot_dfc = _com_reserva("DFC_MI_con", "DFC_MI_ind", True)
    bpa, _ = _com_reserva("BPA_con", "BPA_ind", False)
    bpp, _ = _com_reserva("BPP_con", "BPP_ind", False)
    # ⚠️ um dicionário de rótulo POR DEMONSTRAÇÃO: a DRE e o fluxo de caixa usam a MESMA
    # chave de janela (empresa, início, fim), então juntá-los faz um apagar o outro — e a
    # depreciação some de todas as empresas de uma vez.
    return {"dre": dre, "dfc": dfc, "bpa": bpa, "bpp": bpp,
            "rot": {"dre": rot_dre, "dfc": rot_dfc}, "doc": doc,
            "capital": _capital(z), "receb": _indice(z)}


def colher_ano(ano: int, doc: str) -> dict | None:
    """Baixa e lê um ano inteiro (doc = 'ITR' ou 'DFP')."""
    url = (CVM_ITR if doc == "ITR" else CVM_DFP).format(y=ano)
    b = baixar(url)
    if not b:
        return None
    try:
        z = zipfile.ZipFile(io.BytesIO(b))
    except zipfile.BadZipFile:
        _log(f"  [cvm] {doc} {ano}: zip inválido")
        return None
    f = ler_zip(z, doc)
    _log(f"  [cvm] {doc} {ano}: {len(f['dre'])} janelas de resultado, {len(f['bpa'])} de balanço, "
         f"{len(f['capital'])} composições do capital")
    return f


# ── ações ────────────────────────────────────────────────────────────────────

def _escala(bruto: int, ancora: float | None) -> int:
    """1 ou 1000: a escala que deixa a contagem mais perto da referência (o Formulário de Referência).
    Um desdobramento muda a contagem em 2×, 5×, 10× — longe dos 1000× que separam as duas escalas."""
    if ancora and ancora > 0:
        return min((1, 1000), key=lambda m: abs(math.log10(bruto * m / ancora)))
    return 1000 if bruto < PISO_ACOES else 1


def _pico(v: float | None, antes: float | None, depois: float | None, borda: bool,
          so_para_cima: bool = False) -> bool:
    """`v` é erro de digitação isolado? Destoa FATOR_PICO× dos dois vizinhos, e os vizinhos concordam.

    Com um vizinho só (a ponta da série) só vale se `borda`. Na tesouraria não vale, e só conta o
    pico PARA CIMA: ela zera num cancelamento e volta numa recompra, e isso é movimento de verdade."""
    if v is None or v <= 0:
        return False
    viz = [x for x in (antes, depois) if x is not None and x > 0]

    def destoa(x: float) -> bool:
        r = v / x
        return r >= FATOR_PICO or (not so_para_cima and r <= 1 / FATOR_PICO)

    if len(viz) == 2:
        return destoa(viz[0]) and destoa(viz[1]) and max(viz) / min(viz) < FATOR_VIZINHOS
    return len(viz) == 1 and borda and destoa(viz[0])


def acoes(fontes: list[dict], ancoras: dict[str, float] | None = None,
          avisos: list[str] | None = None) -> dict[tuple[str, str], dict]:
    """{(ticker, trimestre): {shares_total, shares_treasury, shares_out}} da composição do capital.

    Só entra trimestre cuja composição está nos zips desta rodada. `ancoras` = ações pelo Formulário de
    Referência (decide a escala); `avisos` recebe o que foi descartado e por quê."""
    bruto: dict[tuple[str, str], tuple] = {}
    for f in fontes:                                   # mais recente primeiro: a reapresentação vence
        for (t, fim), par in (f.get("capital") or {}).items():
            tri = _tri(fim)
            if tri:
                bruto.setdefault((t, tri), par)
    serie: dict[str, dict[str, list]] = {}
    for (t, tri), (total, tes) in bruto.items():
        if not total or total <= 0:
            continue
        m = _escala(total, (ancoras or {}).get(t))
        serie.setdefault(t, {})[tri] = [total * m, None if tes is None else tes * m]

    out: dict[tuple[str, str], dict] = {}
    for t, s in serie.items():
        tris = sorted(s)
        tot = [s[q][0] for q in tris]
        tes = [s[q][1] for q in tris]
        for i, q in enumerate(tris):
            def vizinhos(lst: list) -> tuple:
                return (lst[i - 1] if i else None), (lst[i + 1] if i + 1 < len(lst) else None)

            total = tot[i]
            if _pico(total, *vizinhos(tot), borda=True):
                if avisos is not None:
                    avisos.append(f"{t} {q}: {_milhar(total)} ações destoa dos vizinhos "
                                  f"({' · '.join(_milhar(x) for x in vizinhos(tot) if x)}) — descartado")
                total = None
            tesour = tes[i]
            if tesour is not None and (tesour < 0 or (total is not None and tesour >= total)
                                       or _pico(tesour, *vizinhos(tes), borda=False, so_para_cima=True)):
                if avisos is not None:
                    avisos.append(f"{t} {q}: {_milhar(tesour)} ações em tesouraria destoa — descartado")
                tesour = None
            out[(t, q)] = {"shares_total": total, "shares_treasury": tesour,
                           "shares_out": total - tesour if (total is not None and tesour is not None) else None}
    return out


def ancoras_de_acoes() -> dict[str, float]:
    """Ações pelo Formulário de Referência (Market Watch) — a referência da escala."""
    out: dict[str, float] = {}
    for r in rest_get("mw_share_capital", "select=company,shares_total,ref_date&order=ref_date.desc") or []:
        v = _num(r.get("shares_total"))
        if r.get("company") and v and r["company"] not in out:
            out[r["company"]] = v
    return out


# ── montagem dos trimestres ──────────────────────────────────────────────────

def _soma(contas: dict[str, float], codigos) -> float | None:
    vals = [contas[c] for c in codigos if c in contas]
    return sum(vals) if vals else None


def _met_dre(contas: dict[str, float]) -> dict[str, float | None]:
    m = {k: contas.get(cd) for k, cd in DRE.items()}
    lucro = contas.get(LUCRO_CONTROLADOR)
    if not lucro:                       # 0 ou ausente (caso da Aura) → consolidado
        lucro = contas.get(LUCRO_CONSOLIDADO)
    m["net_income"] = lucro
    return m


def _met_dfc(contas: dict[str, float], rotulo) -> dict[str, float | None]:
    return {"ocf": contas.get(OCF), "d_a": _da(contas, rotulo), "capex": _capex(contas, rotulo)}


def _subtrair(a: dict, b: dict) -> dict:
    """Trimestre isolado = acumulado menos o acumulado anterior, CAMPO A CAMPO.

    ⚠️ Tem de ser sobre o AGREGADO, nunca sobre as contas cruas. O ITR e o DFP não usam a
    mesma abertura de contas — no 4º trimestre da Vale, subtrair conta a conta deixava a
    linha de capex do DFP inteira de um lado e a do ITR do outro, e o 'trimestre' saía com
    o capex do ANO (R$ 49 bi num trimestre de R$ 8 bi). Somando primeiro, o código de cada
    arquivo não importa mais."""
    return {k: (None if (a.get(k) is None or b.get(k) is None) else a[k] - b[k])
            for k in set(a) | set(b)}


def _acumular(fontes: list[dict], chave: str, met, iso: dict, ytd: dict,
              doc_de: dict | None = None) -> None:
    """Separa as janelas em ISOLADAS (3 meses) e ACUMULADAS (começam em 1º de janeiro),
    já reduzidas às métricas. A janela de 3 meses que começa em janeiro é as duas coisas."""
    for f in fontes:
        for (t, ini, fim), contas in f[chave].items():
            m, tri = _meses(ini, fim), _tri(fim)
            if not m or not tri:
                continue
            valores = met(contas, f["rot"][chave].get((t, ini, fim), {}))
            # `setdefault`: a lista de fontes vem do ano mais RECENTE para o mais antigo,
            # e a reapresentação mais nova é a que vale
            if m == 3:
                iso.setdefault((t, tri), valores)
                if doc_de is not None:
                    doc_de.setdefault((t, tri), f["doc"])
            if ini[5:10] == "01-01":
                ytd.setdefault((t, int(tri[:4]), m), valores)
                if doc_de is not None:
                    doc_de.setdefault((t, tri), f["doc"])


def _isolar(iso: dict, ytd: dict, t: str, tri: str) -> dict | None:
    """O trimestre isolado. Direto quando a companhia publica a janela de 3 meses; senão,
    acumulado menos acumulado anterior — que é o caso do FLUXO DE CAIXA (a CVM só o traz
    acumulado) e do 4º TRIMESTRE, que não tem ITR nenhum."""
    if (t, tri) in iso:
        return iso[(t, tri)]
    ano, m = int(tri[:4]), int(tri[-1]) * 3
    atual = ytd.get((t, ano, m))
    if atual is None:
        return None
    if m == 3:
        return atual
    ant = ytd.get((t, ano, m - 3))
    return _subtrair(atual, ant) if ant is not None else None


def montar(fontes: list[dict], ancoras: dict[str, float] | None = None,
           avisos: list[str] | None = None) -> list[dict]:
    """Tudo que foi lido → uma linha por (empresa, trimestre).

    ⚠️ A linha só leva as colunas cuja FONTE está nos zips desta rodada. O ano mais antigo da rodada
    chega só como comparação dentro do ITR: a DRE e o fluxo de caixa do ano anterior vêm, mas o balanço
    vem só do fim do ano (nunca de março, junho e setembro) e a composição do capital não vem. Se a linha
    levasse essas colunas vazias, o upsert apagaria o que a carga de histórico gravou — e apagava: medido
    em set/2026, a rodada diária (3 anos) tinha zerado caixa e dívida do 1T23 ao 3T23 das 11 empresas."""
    iso_dre: dict[tuple, dict] = {}
    ytd_dre: dict[tuple, dict] = {}
    iso_dfc: dict[tuple, dict] = {}
    ytd_dfc: dict[tuple, dict] = {}
    balanco: dict[tuple, dict] = {}
    doc_de: dict[tuple, str] = {}

    for f in fontes:
        for origem, chave in ((f["bpa"], "bpa"), (f["bpp"], "bpp")):
            for (t, _, fim), contas in origem.items():
                tri = _tri(fim)
                if tri:
                    balanco.setdefault((t, tri), {}).setdefault(chave, contas)
    _acumular(fontes, "dre", lambda c, rot: _met_dre(c), iso_dre, ytd_dre, doc_de)
    _acumular(fontes, "dfc", lambda c, rot: _met_dfc(c, lambda cd: rot.get(cd, "")),
              iso_dfc, ytd_dfc)
    com_acoes = acoes(fontes, ancoras, avisos)

    chaves = sorted({k for k in iso_dre} | {(t, f"{ano}Q{m // 3}") for (t, ano, m) in ytd_dre})
    linhas = []
    for (t, tri) in chaves:
        dre = _isolar(iso_dre, ytd_dre, t, tri)
        if not dre or dre.get("net_revenue") is None:
            continue
        q = int(tri[-1])
        ebit = dre.get("ebit")
        fim = dt.date(int(tri[:4]), q * 3, [31, 30, 30, 31][q - 1])

        linha = {
            "company": t, "quarter": tri, "period_end": fim.isoformat(),
            "net_revenue": dre.get("net_revenue"),
            "cogs": dre.get("cogs"),
            "gross_profit": dre.get("gross_profit"),
            "ebit": ebit,
            "net_income": dre.get("net_income"),
            "currency": "BRL", "scale": "MIL",
            "source": doc_de.get((t, tri), "ITR"),
        }
        dfc = _isolar(iso_dfc, ytd_dfc, t, tri)
        if dfc is not None:                  # sem as janelas do fluxo de caixa nesta rodada: colunas fora
            da = dfc.get("d_a")
            linha.update({"d_a": da, "ebitda": (ebit + da) if (ebit is not None and da is not None) else None,
                          "ocf": dfc.get("ocf"), "capex": dfc.get("capex")})
        bal = balanco.get((t, tri))
        if bal:                              # sem o balanço do fim do trimestre nesta rodada: colunas fora
            caixa, divida = _soma(bal.get("bpa", {}), CAIXA), _soma(bal.get("bpp", {}), DIVIDA)
            linha.update({"cash": caixa, "debt": divida,
                          "net_debt": (divida - caixa) if (divida is not None and caixa is not None) else None})
        if (t, tri) in com_acoes:
            linha.update(com_acoes[(t, tri)])
        linhas.append(linha)
    return linhas


# ── câmbio (PTAX) ─────────────────────────────────────────────────────────────

def ptax_trimestres(dados: list, hoje: dt.date) -> list[dict]:
    """PTAX venda diária (SGS 1) → média e último dia útil de cada trimestre FECHADO.
    O trimestre corrente fica de fora: média de meio trimestre não é a média do trimestre."""
    acc: dict[str, list] = {}
    for it in dados or []:
        try:
            d = dt.datetime.strptime(str(it["data"]), "%d/%m/%Y").date()
            v = float(str(it["valor"]).replace(",", "."))
        except (KeyError, TypeError, ValueError):
            continue
        acc.setdefault(f"{d.year}Q{(d.month - 1) // 3 + 1}", []).append((d, v))
    corrente = f"{hoje.year}Q{(hoje.month - 1) // 3 + 1}"
    out = []
    for tri in sorted(acc):
        if tri >= corrente:
            continue
        vals = [v for _, v in sorted(acc[tri])]
        out.append({"ccy": "BRL", "quarter": tri, "avg_rate": round(sum(vals) / len(vals), 4),
                    "eop_rate": round(vals[-1], 4), "source": "PTAX"})
    return out


def atualizar_ptax(dry: bool) -> int:
    """Grava em quarterly_fx os trimestres fechados dos últimos 2 anos que faltam ou mudaram."""
    hoje = hoje_sp()
    url = BCB_PTAX.format(ini=dt.date(hoje.year - 2, 1, 1).strftime("%d/%m/%Y"), fim=hoje.strftime("%d/%m/%Y"))
    try:
        r = requests.get(url, headers=UA, timeout=(20, 60))
        r.raise_for_status()
        linhas = ptax_trimestres(r.json(), hoje)
    except Exception as e:  # noqa: BLE001
        _log(f"  [ptax] BCB indisponível ({type(e).__name__}) — o câmbio fica para a próxima rodada")
        return 0
    if not linhas:
        return 0
    banco = rest_get("quarterly_fx", "select=quarter,avg_rate,eop_rate&ccy=eq.BRL"
                                     f"&quarter=gte.{linhas[0]['quarter']}") or []
    tem = {b["quarter"]: (_num(b.get("avg_rate")), _num(b.get("eop_rate"))) for b in banco}
    agora = dt.datetime.now(dt.timezone.utc).isoformat()
    novas = [dict(l, updated_at=agora) for l in linhas if tem.get(l["quarter"]) != (l["avg_rate"], l["eop_rate"])]
    if not novas:
        _log(f"  [ptax] os {len(linhas)} trimestres fechados já estão no banco")
        return 0
    n = upsert("quarterly_fx", novas, "ccy,quarter", dry)
    _log(f"  [ptax] {n} trimestre(s): " + ", ".join(f"{l['quarter']} média {l['avg_rate']} fim {l['eop_rate']}"
                                                    for l in novas))
    return n


# ── aviso de trimestre novo ──────────────────────────────────────────────────

def trimestres_a_avisar(linhas: list[dict], recebidos: dict, modelos: dict, hoje: dt.date,
                        janela: int = JANELA_AVISO_DIAS) -> list[dict]:
    """Que (empresa, trimestre) merecem e-mail. Pura: os testes exercitam sem rede.

      recebidos  {(ticker, trimestre): data em que a companhia entregou o documento}
      modelos    {ticker do Stock Guide: último trimestre da versão publicada do modelo}

    Só trimestre ENTREGUE HÁ POUCO (carga de histórico nunca avisa), de empresa COM MODELO publicado
    (sem modelo não há o que subir — Bradespar, Metalúrgica Gerdau) que AINDA NÃO COBRE o trimestre.
    Uma por empresa: a mais recente. A repetição entre rodadas quem barra é o update_log (notify.once)."""
    melhor: dict[str, dict] = {}
    for l in linhas:
        receb = recebidos.get((l["company"], l["quarter"]))
        if receb is None or not 0 <= (hoje - receb).days <= janela:
            continue
        corte = modelos.get(TICKER_PAGINA.get(l["company"], l["company"]))
        if not corte or corte >= l["quarter"]:
            continue
        if l["company"] not in melhor or l["quarter"] > melhor[l["company"]]["quarter"]:
            melhor[l["company"]] = l
    return [melhor[k] for k in sorted(melhor)]


def texto_do_aviso(l: dict, nome: str, recebido: dt.date, corte: str, orgao: str) -> tuple[str, str]:
    """(assunto, corpo) do e-mail — em português, é para o analista."""
    pag = TICKER_PAGINA.get(l["company"], l["company"])
    tri = tri_pt(l["quarter"])
    moeda = {"BRL": "R$", "USD": "US$"}.get(l.get("currency") or "", l.get("currency") or "")
    assunto = f"📊 {nome} entregou o {tri} — hora de subir o modelo"
    corpo = [f"{nome} ({pag}) entregou o {l.get('source') or 'ITR'} do {tri} {orgao} em {recebido:%d/%m/%Y}.", "",
             'Os números oficiais já estão na página Quarterly, marcados como "Filed · preliminary":']
    for rotulo, campo in (("Receita líquida", "net_revenue"), ("EBITDA contábil (EBIT + D&A)", "ebitda"),
                          ("Lucro líquido", "net_income")):
        if l.get(campo) is not None:
            corpo.append(f"  • {rotulo}: {moeda} {_milhar(l[campo] / 1000)} mi")
    corpo += ["", f"O modelo publicado vai até o {tri_pt(corte)}. Para completar volumes, preços, custos e o "
              "EBITDA ajustado, suba o modelo trimestral em /admin → Stock Guide → Trimestral.",
              "", f"{PAGINA}#co/{pag}", "", "— robô Quarterly (CVM/SEC)"]
    return assunto, "\n".join(corpo)


def modelos_ativos() -> dict[str, str] | None:
    rows = rest_get("quarterly_imports", "select=company,cutoff_q&status=eq.active")
    return None if rows is None else {r["company"]: r["cutoff_q"] for r in rows if r.get("company")}


def notificar(linhas: list[dict], recebidos: dict, nomes: dict, orgao: str, dry: bool, sem_email: bool) -> int:
    """Manda o 'entregou o trimestre — suba o modelo'. Usado pelos robôs da CVM e da SEC. Nunca derruba a rodada."""
    try:
        modelos = modelos_ativos()
        if modelos is None:
            _log("  [aviso] não li os modelos publicados — sem e-mail nesta rodada")
            return 0
        enviados = 0
        for l in trimestres_a_avisar(linhas, recebidos, modelos, hoje_sp()):
            pag = TICKER_PAGINA.get(l["company"], l["company"])
            assunto, corpo = texto_do_aviso(l, nomes.get(l["company"], pag), recebidos[(l["company"], l["quarter"])],
                                            modelos[pag], orgao)
            if dry or sem_email:
                _log(f"  [aviso] {'(dry-run)' if dry else '(--sem-email)'} não enviado: {assunto}")
                continue
            import notify
            if notify.once("quarterly_kpis", f"{pag}:{l['quarter']}", "novo_trimestre", assunto, corpo):
                enviados += 1
        return enviados
    except Exception as e:  # noqa: BLE001
        _log(f"  [aviso] falhou (ignorado): {type(e).__name__}: {e}")
        return 0


# ── execução ────────────────────────────────────────────────────────────────

def ha_novidade(anos: list[int]) -> bool:
    """Vale a pena baixar 150 MB hoje? O gatilho é a PRÓPRIA FONTE.

    Seis chamadas HEAD contra o `Last-Modified` dos zips, comparadas com a hora da última
    gravação nossa. Sem estado guardado em lugar nenhum: se a CVM republicar um arquivo
    (empresa entregou, ou reapresentou), o robô acorda no mesmo dia; se não, sai em 2s.
    Erro de rede responde SIM — perder uma entrega é pior que baixar à toa.
    ⚠️ Só as gravações da CVM contam: a SEC (quarterly_sec.py) escreve na mesma tabela, e a gravação
    da Southern Copper esconderia o zip novo da CVM."""
    ult = rest_get("quarterly_kpis", "select=updated_at&source=in.(ITR,DFP)&order=updated_at.desc&limit=1")
    if not ult:
        return True
    try:
        nosso = dt.datetime.fromisoformat(str(ult[0]["updated_at"]).replace("Z", "+00:00"))
    except (KeyError, ValueError, TypeError):
        return True
    from email.utils import parsedate_to_datetime
    for ano in anos:
        for molde in (CVM_ITR, CVM_DFP):
            try:
                r = requests.head(molde.format(y=ano), headers=UA, timeout=60)
                lm = r.headers.get("last-modified")
                if lm and parsedate_to_datetime(lm) > nosso:
                    _log(f"  [cvm] {molde.format(y=ano).rsplit('/', 1)[-1]} é mais novo que a "
                         f"nossa última gravação ({lm})")
                    return True
            except Exception as e:  # noqa: BLE001
                _log(f"  [cvm] HEAD {ano}: {e} — vou baixar por precaução")
                return True
    return False


def run(anos: list[int], dry: bool, sem_email: bool = False) -> int:
    fontes = []
    for ano in sorted(anos, reverse=True):          # mais recente primeiro (vence em empate)
        f = colher_ano(ano, "ITR")
        if f:
            fontes.append(f)
        # o DFP do ano corrente só existe depois do fechamento — ausência não é erro
        f = colher_ano(ano, "DFP")
        if f:
            fontes.append(f)
    if not fontes:
        _log("  [cvm] nenhum arquivo baixado — nada a fazer")
        return 0
    descartes: list[str] = []
    linhas = montar(fontes, ancoras_de_acoes(), descartes)
    for d in descartes:
        _log(f"  [ações] {d}")
    if not linhas:
        _log("  [cvm] nenhum trimestre montado")
        return 0
    emp = len({l["company"] for l in linhas})
    tris = sorted({l["quarter"] for l in linhas})
    com_ebitda = sum(1 for l in linhas if l.get("ebitda") is not None)
    com_acoes = sum(1 for l in linhas if "shares_total" in l)
    _log(f"  {len(linhas)} trimestres de {emp} empresas ({tris[0]} → {tris[-1]}); "
         f"{com_ebitda} com EBITDA; {com_acoes} com ações")
    # uma leva por conjunto de colunas: linha sem a fonte de uma coluna NÃO leva a coluna (ver montar), e o
    # PostgREST exige as mesmas chaves no lote inteiro — juntar tudo num lote só as preencheria com vazio
    levas: dict[tuple, list[dict]] = {}
    for l in linhas:
        levas.setdefault(tuple(sorted(l)), []).append(l)
    n = sum(upsert("quarterly_kpis", leva, "company,quarter", dry) for leva in levas.values())
    _log(f"  {n} linha(s) gravada(s) em {len(levas)} leva(s)")
    if n == len(linhas):
        recebidos: dict[tuple[str, str], dt.date] = {}
        for f in fontes:
            for (t, fim), d in (f.get("receb") or {}).items():
                tri = _tri(fim)
                if tri and ((t, tri) not in recebidos or d < recebidos[(t, tri)]):
                    recebidos[(t, tri)] = d
        notificar(linhas, recebidos, {t: v["name"] for t, v in COMPANIES.items()}, "à CVM", dry, sem_email)
    return n


def tabela(ticker: str) -> None:
    """Imprime a série de uma empresa como ela está no banco (conferência rápida)."""
    rows = rest_get("quarterly_kpis", f"select=*&company=eq.{ticker}&order=quarter.asc") or []
    if not rows:
        print(f"{ticker}: sem linhas")
        return
    moeda = {"BRL": "R$", "USD": "US$"}.get(rows[-1].get("currency"), rows[-1].get("currency"))
    print(f"{ticker} — {moeda} milhões (o banco guarda em milhares)")
    print(f"{'tri':8s}{'receita':>12s}{'EBITDA':>12s}{'margem':>9s}{'EBIT':>12s}"
          f"{'lucro':>12s}{'dív.líq':>12s}{'ações (mi)':>12s}  fonte")
    for r in rows:
        def m(x):
            return "        —" if r.get(x) is None else f"{r[x] / 1000:>11,.0f}"
        mg = (r["ebitda"] / r["net_revenue"] * 100) if (r.get("ebitda") and r.get("net_revenue")) else None
        acs = "           —" if r.get("shares_out") is None else f"{r['shares_out'] / 1e6:>12,.1f}"
        print(f"{r['quarter']:8s}{m('net_revenue')}{m('ebitda')}"
              f"{('       —' if mg is None else f'{mg:>8.1f}%')}{m('ebit')}{m('net_income')}"
              f"{m('net_debt')}{acs}  {r.get('source')}")


def main(argv=None) -> int:
    hoje = dt.date.today()
    ap = argparse.ArgumentParser(description="Cheat sheet trimestral — KPIs da CVM (ITR + DFP)")
    ap.add_argument("--anos", type=int, nargs="+", default=[hoje.year - 2, hoje.year - 1, hoje.year])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--forcar", action="store_true", help="baixa mesmo sem arquivo novo na CVM")
    ap.add_argument("--sem-email", action="store_true", help="não avisa por e-mail (carga de histórico)")
    ap.add_argument("--tabela", help="só imprime a série de uma empresa (não baixa nada)")
    a = ap.parse_args(argv)
    if a.tabela:
        tabela(a.tabela.upper())
        return 0
    _log(f"=== Cheat sheet trimestral {hoje} {'(dry-run)' if a.dry_run else ''} ===")
    atualizar_ptax(a.dry_run)
    _log(f"[cvm] anos {a.anos}")
    if not (a.forcar or a.dry_run) and not ha_novidade(a.anos):
        _log("  [cvm] nenhum arquivo novo desde a última gravação — nada a fazer")
        _log("=== fim ===")
        return 0
    run(a.anos, a.dry_run, a.sem_email)
    _log("=== fim ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
