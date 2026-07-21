# -*- coding: utf-8 -*-
"""
PUBLICAR BASE — atualiza uma base da dashboard direto do seu PC, sem Supabase.

O que ele faz, em ordem:
  1. baixa do GitHub SÓ o que precisa (o código do processador + o banco atual);
  2. processa a SUA planilha AQUI, no seu PC — a planilha nunca sai da máquina;
  3. publica só o BANCO DE DADOS final no GitHub (pela API, por HTTPS);
  4. a Vercel republica sozinha em ~1 min.

Roda em QUALQUER PC com Python. NÃO precisa do repositório clonado nem de git
instalado — só de conseguir abrir o github.com (já testado no PC do banco: ok).

ONDE DEIXAR AS PLANILHAS:
    Deixe este programa na mesma pasta das planilhas (ex.: G:\\Dashboard) — ele
    procura ali (e nas subpastas) automaticamente. Também procura em Downloads.
    (Ou defina a variável de ambiente IBBA_BASES_DIR com o caminho da pasta.)

USO:
    python publicar_base.py                 (menu)
    python publicar_base.py iba             (direto)
    python publicar_base.py iba "G:\\Dashboard\\planilha.xlsx"
    python publicar_base.py iba --dry-run   (faz tudo, menos publicar — pra testar)

TOKEN: na primeira publicação ele pede um token do GitHub (uma vez; fica guardado
       no seu PC em ~/.ibba_publish/token.txt). Como criar está no README que
       aparece se faltar. O token dá acesso só a este repositório.
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")   # acentos no console do Windows
except Exception:
    pass

OWNER, REPO, BRANCH = "JPHELITO", "IBBA-Research-Dashboard", "main"
API = f"https://api.github.com/repos/{OWNER}/{REPO}"
RAW = "https://raw.githubusercontent.com/{o}/{r}/{ref}/{path}"
TOKEN_FILE = Path.home() / ".ibba_publish" / "token.txt"
UA = "ibba-publish-base"

# Onde procurar as planilhas. Ordem: (1) pasta forçada por IBBA_BASES_DIR, se você
# definir; (2) a PRÓPRIA PASTA onde este programa está (ex.: G:\Dashboard) — inclui
# subpastas; (3) sua pasta Downloads. Basta deixar o programa junto das planilhas.
SCRIPT_DIR = Path(__file__).resolve().parent
DOWNLOADS = Path.home() / "Downloads"
def pastas_de_busca():
    fontes = []
    if os.environ.get("IBBA_BASES_DIR"):
        fontes.append((Path(os.environ["IBBA_BASES_DIR"]), True))
    fontes.append((SCRIPT_DIR, True))     # recursivo (pega subpastas)
    fontes.append((DOWNLOADS, False))     # só o nível de cima (não varre o PC todo)
    out, vistos = [], set()
    for d, rec in fontes:
        try:
            chave = str(d.resolve()).lower()
        except Exception:
            chave = str(d).lower()
        if chave in vistos or not d.exists():
            continue
        vistos.add(chave)
        out.append((d, rec))
    return out

# ── Bases. `run`/`post` chamam os MESMOS scripts que o robô do GitHub roda. ────
BASES = {
    "iba": {
        "titulo": "IBÁ papel — Brazilian Pulp & Paper Association",
        "globs": ["IBÁ*.xlsx", "IBA*.xlsx"],
        "precisa": ["Pulp and Paper/update_iba.py", "Pulp and Paper/extractor_pp.py"],
        "db": "Pulp and Paper/pulp_paper.db",
        "tabela": "iba_paper",
        "run": lambda root, xlsx: [sys.executable, str(root / "Pulp and Paper" / "update_iba.py"), str(xlsx)],
        "publicar": ["Pulp and Paper/pulp_paper.db"],
        "lib": "openpyxl",
    },
    "empapel": {
        "titulo": "Empapel — papelão ondulado",
        "globs": ["Empapel*.xlsx"],
        "precisa": ["Pulp and Paper/update_empapel.py", "Pulp and Paper/extractor_pp.py"],
        "db": "Pulp and Paper/pulp_paper.db",
        "tabela": "empapel",
        "run": lambda root, xlsx: [sys.executable, str(root / "Pulp and Paper" / "update_empapel.py"), str(xlsx)],
        "publicar": ["Pulp and Paper/pulp_paper.db"],
        "lib": "openpyxl",
    },
    "linha-preta": {
        "titulo": "Linha preta — SECEX Prediction Analysis (aço)",
        "globs": ["SECEX - Prediction Analysis*.xlsx"],
        "precisa": ["Steel and Mining/reload_pred_exports.py", "Steel and Mining/build_web_db.py",
                    "_shared/dictionary.py", "_shared/dictionary_codes.csv"],
        "db": "Steel and Mining/steel_sm.db",
        "tabela": "pred_exports",
        "run": lambda root, xlsx: [sys.executable, str(root / "Steel and Mining" / "reload_pred_exports.py"),
                                   "--pred", str(xlsx)],
        "post": lambda root: [sys.executable, str(root / "Steel and Mining" / "build_web_db.py")],
        "publicar": ["Steel and Mining/steel_sm.db", "Steel and Mining/steel_sm_web.db.gz"],
        "lib": "pandas",
    },
}

TOKEN_HELP = """\
  Como criar o token (uma vez só):
    1. Abra:  https://github.com/settings/personal-access-tokens/new
    2. Token name: 'IBBA publicar base' · Expiration: 1 ano
    3. Resource owner: JPHELITO
    4. Repository access: 'Only select repositories' -> IBBA-Research-Dashboard
    5. Permissions -> Repository permissions -> 'Contents' -> Read and write
    6. Generate token e copie (começa com 'github_pat_...')
"""


# ── HTTP (só stdlib; nada de instalar 'requests') ─────────────────────────────
def _req(url, method="GET", token=None, body=None):
    headers = {"User-Agent": UA, "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = json.dumps(body).encode() if body is not None else None
    if data is not None:
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(url, method=method, headers=headers, data=data)
    with urllib.request.urlopen(r, timeout=120) as resp:
        raw = resp.read()
        return resp.status, (json.loads(raw) if raw else None)


def api(path, method="GET", token=None, body=None):
    try:
        return _req(API + path, method, token, body)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.loads(e.read()).get("message", "")
        except Exception:
            pass
        raise RuntimeError(f"GitHub {method} {path} -> HTTP {e.code}: {detail}") from None


def baixar(path_rel, sha, destino):
    """Baixa um arquivo do repo (fixado no commit `sha`) para `destino`."""
    from urllib.parse import quote
    url = RAW.format(o=OWNER, r=REPO, ref=sha, path=quote(path_rel))
    destino.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=180) as resp:
        destino.write_bytes(resp.read())


# ── Token ─────────────────────────────────────────────────────────────────────
def obter_token(precisa_escrever):
    tok = os.environ.get("IBBA_GH_TOKEN") or (TOKEN_FILE.read_text().strip() if TOKEN_FILE.exists() else "")
    if tok or not precisa_escrever:
        return tok
    print("\n  Para PUBLICAR preciso de um token do GitHub (uma vez só).")
    print(TOKEN_HELP)
    try:
        import getpass
        tok = getpass.getpass("  Cole o token aqui (não aparece na tela): ").strip()
    except Exception:
        tok = input("  Cole o token aqui: ").strip()
    if not tok:
        sys.exit("  Sem token, não dá pra publicar.")
    if input("  Guardar no seu PC pra não pedir de novo? [S/n]: ").strip().lower() in ("", "s", "sim", "y"):
        TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        TOKEN_FILE.write_text(tok)
        print(f"  ✓ guardado em {TOKEN_FILE}")
    return tok


# ── período/linhas de uma tabela (o 'antes/depois' que você vê) ───────────────
def resumo(db_path, tabela):
    import sqlite3
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        r = con.execute(f'SELECT MAX(period), COUNT(*) FROM "{tabela}"').fetchone()
        con.close()
        return r
    except Exception:
        return None


def achar_planilha(base):
    cand = []
    for d, rec in pastas_de_busca():
        for g in base["globs"]:
            cand += list(d.rglob(g)) if rec else list(d.glob(g))
    achados = sorted({p for p in cand if not p.name.startswith("~$")},
                     key=lambda p: p.stat().st_mtime, reverse=True)
    if not achados:
        print(f"\n  ✗ Não achei planilha de '{base['titulo']}'. Procurei por "
              f"{' / '.join(base['globs'])} em:")
        for d, _ in pastas_de_busca():
            print(f"      - {d}")
        print("    Deixe a planilha numa dessas pastas (o ideal é a mesma pasta deste "
              "programa), ou passe o caminho como 2º argumento.")
        return None
    if len(achados) == 1:
        return achados[0]
    import datetime
    print("\n  Achei mais de uma planilha — qual é a nova?\n")
    for i, p in enumerate(achados[:6], 1):
        q = datetime.datetime.fromtimestamp(p.stat().st_mtime).strftime("%d/%m/%Y %H:%M")
        print(f"    [{i}] {p.name}   ({q})   [{p.parent}]{'  <- mais recente' if i == 1 else ''}")
    e = input("\n  Número (Enter = a mais recente): ").strip()
    return achados[0] if not e else (achados[int(e) - 1] if e.isdigit() and 1 <= int(e) <= len(achados) else None)


# ── publicação atômica (Git Data API): blobs -> tree -> commit -> ref ─────────
def publicar(token, base_sha, arquivos, mensagem):
    _, commit = api(f"/git/commits/{base_sha}", token=token)
    base_tree = commit["tree"]["sha"]
    tree = []
    for rel, conteudo in arquivos.items():
        _, blob = api("/git/blobs", "POST", token,
                      {"content": base64.b64encode(conteudo).decode(), "encoding": "base64"})
        tree.append({"path": rel, "mode": "100644", "type": "blob", "sha": blob["sha"]})
    _, novo_tree = api("/git/trees", "POST", token, {"base_tree": base_tree, "tree": tree})
    _, novo_commit = api("/git/commits", "POST", token,
                         {"message": mensagem, "tree": novo_tree["sha"], "parents": [base_sha]})
    # force:false -> se o robô publicou algo enquanto eu processava, dá 422 e NÃO
    # sobrescreve (seus dados ficam seguros; é só rodar de novo).
    api(f"/git/refs/heads/{BRANCH}", "PATCH", token, {"sha": novo_commit["sha"], "force": False})
    return novo_commit["sha"]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    dry = "--dry-run" in sys.argv or "--check" in sys.argv
    print("=" * 70)
    print("  PUBLICAR BASE DA DASHBOARD" + ("   [DRY-RUN — não vai publicar]" if dry else ""))
    print("=" * 70)

    # 1) qual base
    chave = args[0].lower() if args else None
    if chave not in BASES:
        print("\n  Qual base atualizar?\n")
        for i, (k, b) in enumerate(BASES.items(), 1):
            print(f"    [{i}] {b['titulo']}")
        e = input("\n  Número: ").strip()
        if not (e.isdigit() and 1 <= int(e) <= len(BASES)):
            sys.exit("\n  Cancelado.")
        chave = list(BASES)[int(e) - 1]
    base = BASES[chave]
    print(f"\n  Base: {base['titulo']}")

    # 2) checa a biblioteca que o processador usa
    try:
        __import__(base["lib"])
    except Exception:
        sys.exit(f"\n  ✗ Falta a biblioteca '{base['lib']}'. Instale com:\n"
                 f"      pip install {base['lib']}")

    # 3) token (só se for publicar de fato)
    token = obter_token(precisa_escrever=not dry)

    # 4) planilha
    xlsx = Path(args[1]) if len(args) > 1 else achar_planilha(base)
    if not xlsx or not xlsx.exists():
        sys.exit("\n  ✗ Planilha não encontrada.")
    print(f"  Planilha: {xlsx.name}  ({xlsx.stat().st_size/1024:,.0f} KB)")
    print(f"            em {xlsx.parent}")

    # 5) fixa o ponto de partida (commit atual) e baixa o necessário DAQUELE ponto
    print("\n  [1/4] Baixando o código e o banco atual do GitHub...")
    _, ref = api(f"/git/ref/heads/{BRANCH}", token=token or None)
    base_sha = ref["object"]["sha"]
    tmp = Path(tempfile.mkdtemp(prefix="ibba_pub_"))
    try:
        for rel in base["precisa"] + [base["db"]]:
            baixar(rel, base_sha, tmp / rel)
        antes = resumo(tmp / base["db"], base["tabela"])
        if antes:
            print(f"        {base['tabela']}: hoje vai até {antes[0]} ({antes[1]:,} linhas)")

        # 6) processa LOCALMENTE (mesmo script do robô)
        print("\n  [2/4] Processando a planilha aqui no seu PC...\n")
        env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
        r = subprocess.run(base["run"](tmp, xlsx), cwd=str(tmp), env=env)
        depois = resumo(tmp / base["db"], base["tabela"])
        if r.returncode:
            aviso = " (mas o banco FOI alterado)" if depois != antes else ""
            sys.exit(f"\n  ✗ O processador falhou{aviso}. Nada foi publicado. "
                     "Confira se a planilha é a certa e tem o formato esperado.")
        if "post" in base:
            print("\n        Regerando o banco web (arquivo leve do cliente)...")
            if subprocess.run(base["post"](tmp), cwd=str(tmp), env=env).returncode:
                sys.exit("\n  ✗ Falhou ao gerar o banco web. Nada publicado.")

        # 7) resumo + confirmação
        print("\n  [3/4] Resumo:")
        if antes and depois:
            print(f"        {base['tabela']}:  {antes[0]} ({antes[1]:,})  ->  {depois[0]} ({depois[1]:,})")
        if antes and depois and antes == depois:
            print("        ⚠ Período e nº de linhas NÃO mudaram — parece a MESMA planilha já publicada.")
        conteudo = {rel: (tmp / rel).read_bytes() for rel in base["publicar"]}
        for rel, b in conteudo.items():
            print(f"        publicar: {rel}  ({len(b)/1e6:.2f} MB)")

        if dry:
            print("\n  [DRY-RUN] Chegaria aqui e publicaria — mas o modo teste para por aqui.")
            return
        if input("\n  Publicar para os clientes? [s/N]: ").strip().lower() not in ("s", "sim", "y"):
            print("\n  Cancelado — nada publicado.")
            return

        # 8) publica
        print("\n  [4/4] Publicando no GitHub...")
        msg = f"data: {base['titulo']} atualizado" + (f" -> {depois[0]}" if depois and depois[0] else "")
        try:
            sha = publicar(token, base_sha, conteudo, msg)
        except RuntimeError as e:
            if "422" in str(e):
                sys.exit("\n  ✗ Alguém/robô publicou enquanto eu processava. SEUS DADOS ESTÃO SEGUROS "
                         "(nada foi sobrescrito). É só rodar de novo.")
            raise
        print("\n" + "=" * 70)
        print(f"  ✓ PUBLICADO (commit {sha[:7]}). A Vercel republica em ~1 min.")
        print("    https://metals-mining-pulp-paper-dashboard.vercel.app")
        print("=" * 70)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n  Cancelado.")
    except RuntimeError as e:
        sys.exit(f"\n  ✗ {e}")
