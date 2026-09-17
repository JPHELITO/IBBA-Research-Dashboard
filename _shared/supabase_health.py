# -*- coding: utf-8 -*-
"""supabase_health.py — sentinela diária do corte de cota do Supabase.

Vigia a ÚNICA falha que derruba tudo de uma vez: a Fair Use Policy do plano
grátis. Quando a organização passa dos 5 GB de egresso do ciclo, o Supabase
responde HTTP 402 em todo o /rest/v1, /auth/v1 e /storage/v1 — e caem juntos a
dashboard dos clientes, os robôs do Actions e o CLIPPING. Não existe conexão
direta com o Postgres em lugar nenhum do projeto (grep por psycopg/DATABASE_URL
= zero), então o 402 pega 100% do sistema.

Contexto (2026-09-17): a carência do estouro de agosto venceu hoje. Pela FAQ do
Supabase a carência NÃO se repete — "if you exceed your plan limits again, you
will not receive another grace period". O próximo estouro corta NA HORA, sem
e-mail de aviso. Daí esta sentinela.

Duas decisões de desenho, as duas de propósito:

1. Roda 06:30 BRT, 20 min ANTES do generate_clipping (06:50). Se o banco estiver
   cortado, o aviso chega ANTES de o clipping falhar, já explicando o porquê —
   em vez de o usuário descobrir pelo clipping que não chegou.
2. Usa notify.send, nunca notify.once. O once guarda o anti-spam no update_log
   do próprio Supabase; num corte ele é justamente o que está fora do ar. O send
   é SMTP puro, sem Supabase no caminho — o alerta sai mesmo com o banco morto.
   É a diferença entre um alarme e um alarme que só toca quando não há incêndio.

Silencioso quando está tudo bem: e-mail só quando há problema.
Saída: 0 = saudável · 1 = problema (deixa o workflow vermelho no Actions também,
para o alerta ter dois caminhos independentes até o usuário).

Rodar:
  python _shared/supabase_health.py              # checa e avisa se houver problema
  python _shared/supabase_health.py --dry-run    # checa e só imprime (não manda e-mail)
  python _shared/supabase_health.py --test-email # prova que o e-mail funciona
"""
from __future__ import annotations

import argparse
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import notify  # noqa: E402

# O console do Windows é cp1252 e estoura UnicodeEncodeError na seta "→" da tabela.
# Isso derrubaria a sentinela ANTES de ela mandar o alerta — o vigia morreria no
# log, calado, justamente no dia em que houvesse incêndio. Duas redes: forçar UTF-8
# na saída e, se ainda assim falhar, imprimir em ASCII puro.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _ascii(msg):
    """Versão ASCII de qualquer texto, para consoles que não aguentam UTF-8."""
    return str(msg).encode("ascii", "replace").decode("ascii")


def _imprimir(msg):
    """print que NUNCA levanta exceção."""
    try:
        print(msg)
    except Exception:
        try:
            print(_ascii(msg))
        except Exception:
            pass

# A chave "publishable" é PÚBLICA por desenho — já vai no HTML servido a qualquer
# visitante (admin.html, agenda.html, clipinator.html...). Não é segredo, e está
# aqui embutida de propósito: a sentinela tem que funcionar mesmo que os secrets
# do Actions falhem. Usar a chave pública (e não a service) também faz a checagem
# enxergar exatamente o que o navegador do cliente enxerga.
SUPA_URL = os.environ.get("SUPABASE_URL") or "https://mmhkqkpjrvyxovpihnio.supabase.co"
PUB_KEY = os.environ.get("SUPABASE_ANON_KEY") or "sb_publishable__0hsX4N8rRLNl-3DmGwCKw_p9mOkuxA"

ORG_USAGE = "https://supabase.com/dashboard/org/mpliktnwnshobpiluyep/usage"

# O ciclo de cobrança vira todo dia 27 (ancorado na criação da org: as credenciais
# entraram no repo em 27/05/2026). Confere com agosto: 6,01 GB no dia 19/08 é o
# 24º dia do ciclo 27/07→26/08 = 250 MB/dia, o ritmo medido na época.
CICLO_DIA = 27

CHECKS = [
    ("banco (PostgREST)", "rest/v1/commodities?select=name&limit=1"),
    ("login (Auth)", "auth/v1/health"),
    ("arquivos (Storage)", "storage/v1/bucket"),
]

TENTATIVAS = 3
ESPERA_S = 5
TIMEOUT_S = 25


# ── a rede ───────────────────────────────────────────────────────────────────
def _bater(path, timeout=TIMEOUT_S):
    """Bate num endpoint. Devolve (status, corpo). status=None → não respondeu."""
    req = urllib.request.Request(
        SUPA_URL.rstrip("/") + "/" + path.lstrip("/"),
        headers={"apikey": PUB_KEY, "Authorization": "Bearer " + PUB_KEY},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(600).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:          # 4xx/5xx respondem de verdade
        try:
            corpo = e.read(600).decode("utf-8", "replace")
        except Exception:
            corpo = ""
        return e.code, corpo
    except Exception as e:                       # DNS, timeout, TLS, rede morta
        return None, "{}: {}".format(type(e).__name__, e)


def _conclusivo(status):
    """Resposta que não adianta repetir. 5xx e silêncio podem ser soluço de rede."""
    return status is not None and status < 500


def checar(tentativas=TENTATIVAS, espera=ESPERA_S):
    """Bate nos 3 endpoints, com repetição só no que for inconclusivo."""
    out = []
    for nome, path in CHECKS:
        status = corpo = None
        for i in range(tentativas):
            status, corpo = _bater(path)
            if _conclusivo(status):
                break
            if i < tentativas - 1:
                time.sleep(espera)
        out.append({"nome": nome, "path": path.split("?")[0], "status": status, "corpo": corpo})
    return out


# ── o diagnóstico (puro: é o que os testes exercitam) ────────────────────────
def proximo_reset(hoje=None):
    """Próxima virada do ciclo (dia 27). No próprio dia 27, já é a do mês seguinte."""
    hoje = hoje or date.today()
    if hoje.day < CICLO_DIA:
        return date(hoje.year, hoje.month, CICLO_DIA)
    ano, mes = (hoje.year + 1, 1) if hoje.month == 12 else (hoje.year, hoje.month + 1)
    return date(ano, mes, CICLO_DIA)


def _codigo_402(resultados):
    """Tira o motivo do corpo do 402 (ex.: exceeded_egress_quota)."""
    for r in resultados:
        for marca in ("exceeded_egress_quota", "exceeded_db_size_quota", "overdue_payment"):
            if marca in (r.get("corpo") or ""):
                return marca
    return "exceeded_*_quota"


def _tabela(resultados):
    return "\n".join(
        "  {:<20} → ".format(r["nome"])
        + ("sem resposta" if r["status"] is None else "HTTP {}".format(r["status"]))
        for r in resultados
    )


def diagnosticar(resultados, hoje=None):
    """(codigo, assunto, corpo). codigo em {ok, restrito, fora_do_ar, estranho}."""
    status = [r["status"] for r in resultados]
    tabela = _tabela(resultados)

    # 402 tem prioridade sobre qualquer outra coisa: é o corte, o resto é ruído.
    if 402 in status:
        reset = proximo_reset(hoje).strftime("%d/%m")
        return (
            "restrito",
            "SUPABASE CORTADO — dashboard e clipping fora do ar",
            """O Supabase aplicou a Fair Use Policy na organização: as chamadas estão
voltando HTTP 402 ({codigo}).

O QUE ESTÁ FORA DO AR AGORA
  • a dashboard dos clientes (todas as páginas vazias)
  • os robôs do GitHub Actions (caça de notícias, preços, quarterly, calendário)
  • o CLIPPING — não vai sair

O QUE NÃO ACONTECEU
  Nenhum dado foi perdido. O console do Supabase continua acessível normalmente
  e os dados estão todos lá.

COMO RESOLVER, do mais rápido ao mais lento
  1. Subir para o Pro (US$ 25/mês) — levanta a restrição NA HORA e a cota de
     egresso vai de 5 GB para 250 GB.
  2. Esperar a virada do ciclo em {reset} — o contador zera e a restrição cai
     sozinha. O clipping fica parado até lá.
  3. Se o ciclo já virou e a restrição NÃO caiu, é bug do Supabase (acontece):
     abrir chamado em supabase.com/dashboard/support/new.

CHECAGEM
{tabela}

Uso do ciclo: {usage}

— sentinela supabase_health.py""".format(
                codigo=_codigo_402(resultados), reset=reset, tabela=tabela, usage=ORG_USAGE
            ),
        )

    if all(not _conclusivo(s) for s in status):
        return (
            "fora_do_ar",
            "Supabase não respondeu — pode ser queda do provedor",
            """Os três endpoints ficaram mudos depois de {n} tentativas. Isso NÃO é o corte de
cota (o corte responde HTTP 402, não silêncio) — é mais provável que seja queda
do Supabase ou problema de rede do runner do GitHub.

O que fazer: conferir status.supabase.com e rodar a sentinela de novo. Se voltar
sozinho, foi soluço.

CHECAGEM
{tabela}

— sentinela supabase_health.py""".format(n=TENTATIVAS, tabela=tabela),
        )

    if any(s != 200 for s in status):
        return (
            "estranho",
            "Sentinela do Supabase precisa de ajuste",
            """A checagem não deu 402 (ou seja: NÃO é o corte de cota), mas também não deu o
200 esperado em tudo. O palpite mais provável é que a chave pública do projeto
tenha sido trocada e a sentinela esteja usando a antiga — nesse caso a dash está
bem e quem precisa de conserto é o vigia, em _shared/supabase_health.py.

CHECAGEM
{tabela}

— sentinela supabase_health.py""".format(tabela=tabela),
        )

    return ("ok", "", "Supabase saudável.\n" + tabela)


# ── linha de comando ─────────────────────────────────────────────────────────
def main(argv=None):
    p = argparse.ArgumentParser(description="Sentinela do corte de cota do Supabase.")
    p.add_argument("--dry-run", action="store_true", help="checa e imprime, sem mandar e-mail")
    p.add_argument("--test-email", action="store_true", help="manda um e-mail de teste e sai")
    a = p.parse_args(argv)

    if a.test_email:
        ok = notify.send(
            "🧪 Teste da sentinela do Supabase",
            "Se este e-mail chegou, o canal de alerta funciona.\n\n"
            "A sentinela roda todo dia às 06:30 e só escreve quando há problema.\n"
            "Silêncio dela = tudo certo.\n\n— sentinela supabase_health.py",
        )
        _imprimir("e-mail de teste enviado." if ok else "FALHOU ao enviar (confira SMTP_USER/SMTP_PASS).")
        return 0 if ok else 1

    resultados = checar()
    codigo, assunto, corpo = diagnosticar(resultados)

    # O e-mail sai ANTES de qualquer impressão: o alerta é a razão de existir da
    # sentinela, e nada no caminho dele pode depender de log dar certo.
    if codigo != "ok" and not a.dry_run:
        notify.alert(assunto, corpo)   # alert() nunca levanta exceção; prefixa "⚠️"

    _imprimir("[{}] ".format(codigo) + _tabela(resultados).replace("\n", " |"))

    if codigo == "ok":
        return 0
    if a.dry_run:
        _imprimir("\n--- e-mail que SERIA enviado ---\n[!] {}\n\n{}".format(assunto, corpo))
        return 0
    return 1                           # workflow vermelho = segundo caminho de aviso


if __name__ == "__main__":
    raise SystemExit(main())
