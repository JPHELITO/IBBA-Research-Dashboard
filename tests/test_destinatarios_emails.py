# -*- coding: utf-8 -*-
"""Quem recebe cada e-mail da dashboard (pedido do usuário, 03/11/2026).

"Continue enviando, mas apenas para o joao.helito@itaubba.com. O único que quero que você continue
enviando para o restante do time é o resumo do dia e quando saem as informações das fontes de
informação (tipo secex, etc). O resto, não mande para eles."

A regra que estes testes travam:
  • o PADRÃO de todo e-mail é só o João (registry.DEFAULT_RECIPIENTS);
  • o TIME (registry.TEAM_RECIPIENTS) só sai de quem pede de propósito — o resumo do dia e o aviso de
    DADO NOVO publicado por uma fonte (mês novo; revisão sem mês novo fica só com o João);
  • a lista do time mora num lugar só: nenhum workflow a escreve à mão (antes eram 4 cópias).

Rodar:  python -m pytest tests/test_destinatarios_emails.py -q
"""
import ast
import glob
import os
import re
import sys

import pytest
import yaml

BASE = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.abspath(os.path.join(BASE, ".."))
sys.path.insert(0, os.path.join(RAIZ, "_shared"))
sys.path.insert(0, os.path.join(RAIZ, "Pulp and Paper"))
import notify    # noqa: E402
import registry  # noqa: E402

JOAO = "joao.helito@itaubba.com"
OUTROS = ("marcelo.palhares", "daniel.sasson", "rafael.giacometti")
WF = os.path.join(RAIZ, ".github", "workflows")


def test_padrao_e_so_o_joao_e_o_time_sao_os_4():
    assert registry.DEFAULT_RECIPIENTS == [JOAO]
    assert registry.TEAM_RECIPIENTS[0] == JOAO and len(registry.TEAM_RECIPIENTS) == 4
    assert all(any(o in t for t in registry.TEAM_RECIPIENTS) for o in OUTROS)
    assert notify.DEFAULT_RECIPIENTS == registry.DEFAULT_RECIPIENTS
    assert notify.TEAM_RECIPIENTS == registry.TEAM_RECIPIENTS
    # toda fonte do registro herda o padrão (é o que o notify.new_data usa)
    assert all(s["recipients"] == [JOAO] for s in registry.all_sources())


def test_a_reserva_do_notify_tem_as_mesmas_listas():
    """O notify.py tem uma cópia para quando roda fora do _shared — ela não pode divergir."""
    src = open(os.path.join(RAIZ, "_shared", "notify.py"), encoding="utf-8").read()
    reserva = src.split("except Exception:", 1)[1].split("def get(", 1)[0]
    ns = {}
    exec(reserva.replace("    ", ""), ns)   # noqa: S102 — só as duas atribuições de lista
    assert ns["DEFAULT_RECIPIENTS"] == registry.DEFAULT_RECIPIENTS
    assert ns["TEAM_RECIPIENTS"] == registry.TEAM_RECIPIENTS


class _SMTPFalso:
    entregas = []

    def __init__(self, *a, **k):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def starttls(self, **k):
        pass

    def login(self, *a):
        pass

    def sendmail(self, de, para, raw):
        _SMTPFalso.entregas.append(list(para))


@pytest.fixture
def smtp(monkeypatch):
    _SMTPFalso.entregas = []
    monkeypatch.setenv("SMTP_USER", "robo@exemplo.com")
    monkeypatch.setenv("SMTP_PASS", "x")
    monkeypatch.setattr(notify.smtplib, "SMTP", _SMTPFalso)
    monkeypatch.setattr(notify.smtplib, "SMTP_SSL", _SMTPFalso)
    return _SMTPFalso.entregas


def _cli(monkeypatch, *args):
    monkeypatch.setattr(sys, "argv", ["notify.py", "--subject", "s", "--body", "b", *args])
    with pytest.raises(SystemExit) as e:
        notify.main()
    assert e.value.code == 0


def test_sem_destinatario_vai_so_para_o_joao(smtp):
    assert notify.send("aviso", "corpo") is True
    assert notify.alert("problema", "corpo") is True
    assert smtp == [[JOAO], [JOAO]]


def test_linha_de_comando_padrao_joao_e_team_a_lista_de_fontes(monkeypatch, smtp):
    _cli(monkeypatch)
    _cli(monkeypatch, "--team")
    _cli(monkeypatch, "--to", "a@x.com,b@y.com")
    assert smtp == [[JOAO], registry.SOURCE_ALERT_RECIPIENTS, ["a@x.com", "b@y.com"]]


def test_avisos_de_fonte_pausados_para_o_time():
    # 2026-11-05 (pedido do usuário): "no momento" os avisos de dado novo de fonte vão só para o João.
    # Religar = registry.FONTES_PARA_O_TIME = True (e trocar este teste).
    assert registry.FONTES_PARA_O_TIME is False
    assert registry.SOURCE_ALERT_RECIPIENTS == [JOAO]
    assert notify.SOURCE_ALERT_RECIPIENTS == [JOAO]
    assert len(registry.TEAM_RECIPIENTS) == 4      # o resumo do dia continua indo para os 4


# ── workflows ─────────────────────────────────────────────────────────────────────────────────────
def _workflows():
    return {os.path.basename(p): open(p, encoding="utf-8").read()
            for p in sorted(glob.glob(os.path.join(WF, "*.yml")))}


def test_nenhum_workflow_escreve_a_lista_do_time_a_mao():
    for nome, txt in _workflows().items():
        for o in OUTROS:
            assert o not in txt, f"{nome}: lista do time escrita à mão — use --team (registry.py)"
        # a CHAMADA, não a menção: o comentário que explica a troca cita o action-send-mail
        usos = [s.get("uses", "") for j in (yaml.safe_load(txt).get("jobs") or {}).values()
                for s in j.get("steps", [])]
        assert not any("send-mail" in u for u in usos), f"{nome}: e-mail fora do notify.py"


# Só estes workflows avisam o TIME — todos de dado novo de fonte. Quem não está aqui fala só com o João.
TIME_PERMITIDO = {"update_secex.yml", "update_pulp_secex.yml", "update_korea.yml",
                  "update_iabr.yml", "update_inda.yml", "update_iba.yml"}


def test_so_dado_novo_de_fonte_usa_team():
    usam = {n for n, t in _workflows().items() if "--team" in t}
    assert usam <= TIME_PERMITIDO, f"--team fora dos avisos de dado novo: {usam - TIME_PERMITIDO}"
    assert {"update_secex.yml", "update_pulp_secex.yml", "update_iabr.yml",
            "update_inda.yml", "update_iba.yml"} <= usam


@pytest.mark.parametrize("arquivo,condicao", [
    ("update_secex.yml", r'if \[ -n "\$NEW_MONTH" \]; then PARA="--team"; fi'),
    ("update_pulp_secex.yml", r'if \[ -n "\$PULP_NEW_MONTH" \]; then PARA="--team"; fi'),
    ("update_iabr.yml", r'if \[ "\$IABR_KIND" = "updated" \]; then PARA="--team"; fi'),
])
def test_revisao_sem_mes_novo_fica_so_com_o_joao(arquivo, condicao):
    """SECEX/celulose/IABr também avisam REVISÃO de meses já publicados — essa vai só para o João."""
    txt = _workflows()[arquivo]
    assert re.search(condicao, txt), f"{arquivo}: o --team tem de depender de mês novo"
    assert txt.count('PARA="--team"') == 1
    assert "notify.py --team" not in txt, f"{arquivo}: --team incondicional"


def test_os_passos_de_email_tem_smtp_e_python():
    """Os 3 que saíram do action-send-mail: o passo precisa das credenciais e do notify.py."""
    for arquivo in ("update_secex.yml", "update_pulp_secex.yml", "update_korea.yml"):
        doc = yaml.safe_load(_workflows()[arquivo])
        passos = [s for j in doc["jobs"].values() for s in j.get("steps", [])
                  if s.get("name") == "Send email notification"]
        assert len(passos) == 1, arquivo
        p = passos[0]
        assert set(p.get("env", {})) >= {"SMTP_USER", "SMTP_PASS"}, arquivo
        assert "python _shared/notify.py" in p["run"] and "--require" in p["run"], arquivo
        assert "<<FIM" in p["run"] and "\nFIM\n" in p["run"], arquivo


# ── código Python ─────────────────────────────────────────────────────────────────────────────────
def test_team_recipients_so_em_quem_pode():
    permitidos = {os.path.join("_shared", "registry.py"), os.path.join("_shared", "notify.py"),
                  os.path.join("_shared", "daily_digest_mail.py")}
    usam = set()
    for p in glob.glob(os.path.join(RAIZ, "**", "*.py"), recursive=True):
        rel = os.path.relpath(p, RAIZ)
        if rel.startswith("tests"):
            continue
        if "TEAM_RECIPIENTS" in open(p, encoding="utf-8", errors="ignore").read():
            usam.add(rel)
    assert usam == permitidos


def test_empapel_so_avisa_o_time_de_numero_publicado():
    arv = ast.parse(open(os.path.join(RAIZ, "Pulp and Paper", "update_empapel_news.py"), encoding="utf-8").read())
    chamadas = [n for n in ast.walk(arv) if isinstance(n, ast.Call)
                and getattr(n.func, "id", None) == "_mail"]
    assert chamadas
    for c in chamadas:
        kind = c.args[0].value
        team = any(k.arg == "team" and getattr(k.value, "value", False) for k in c.keywords)
        assert team == (kind in ("updated", "new")), f"_mail('{kind}'): team={team}"


def test_empapel_entrega_no_endereco_certo(monkeypatch):
    """O de cima olha as CHAMADAS; este olha o que o _mail faz com a marcação."""
    import update_empapel_news as E
    para = []
    monkeypatch.setattr(E.notify, "once", lambda s, p, k, subj, body, to=None, html=False: para.append(to))
    E._mail("review", "2026-10", "s", "b")
    E._mail("new", "2026-10", "s", "b", team=True)
    assert para == [None, registry.SOURCE_ALERT_RECIPIENTS]  # None = o padrão do notify = só o João


def test_celulose_separa_mes_novo_de_revisao(tmp_path, monkeypatch):
    import update_pulp_secex as U
    env = tmp_path / "env"
    monkeypatch.setenv("GITHUB_ENV", str(env))
    U._write_gh_env("true", "2026-10", ["2026-10"])
    U._write_gh_env("true", "2026-10", ())
    linhas = env.read_text(encoding="utf-8").splitlines()
    assert linhas.count("PULP_NEW_MONTH=2026-10") == 1 and linhas.count("PULP_NEW_MONTH=") == 1
