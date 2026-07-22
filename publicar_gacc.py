# -*- coding: utf-8 -*-
"""publicar_gacc.py — atualiza o GACC na dashboard com 1 clique, SEM logar no GitHub.

Feito pro PC do banco (restrito): NÃO usa git push, nem Supabase Storage, nem o github.com web
(que exige login). Usa SÓ a /contents API do GitHub (api.github.com) — o MESMO canal que a
dashboard já usa pra LER os dados — com um TOKEN local pra ESCREVER. Fluxo:

  lê o CSV do customs (Downloads) → baixa o pulp_paper.db atual (API, leitura) → troca só os
  meses do GACC (preserva o resto) → publica o banco de volta (API + token) → dashboard em ~1 min.

TOKEN (chave de API) — guardado SÓ no seu PC:
  arquivo  %USERPROFILE%\\.ibba\\token.txt   (ou a variável de ambiente IBBA_GH_TOKEN)
  Nunca vai pro código, pro repositório nem pro chat. Escopo mínimo: Contents Read/Write
  SÓ no repo IBBA-Research-Dashboard. Revogável a qualquer hora.

USO:  duplo-clique em "Atualizar GACC.bat"   (ou  python publicar_gacc.py [arquivo.csv ...])
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
import montar_gacc as mg                       # reaproveita CSV→pivô→merge (mesmo motor validado)

OWNER, REPO, BRANCH = mg.OWNER, mg.REPO, mg.BRANCH
API = "https://api.github.com/repos/{}/{}/contents/{}".format(
    OWNER, REPO, urllib.parse.quote(mg.DB_REL))
TOKEN_FILE = Path.home() / ".ibba" / "token.txt"
DASH = "https://metals-mining-pulp-paper-dashboard.vercel.app"


def load_token():
    t = (os.environ.get("IBBA_GH_TOKEN") or "").strip()
    if t:
        return t
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text(encoding="utf-8").strip()
    return None


def _req(method, headers=None, body=None):
    url = API + ("?ref=" + BRANCH if method == "GET" else "")
    req = urllib.request.Request(
        url, method=method, data=(json.dumps(body).encode() if body is not None else None),
        headers={"User-Agent": "ibba-publicar-gacc", "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", **(headers or {})})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.status, json.loads(r.read())


def fetch_current(destino):
    """GET do pulp_paper.db (leitura — não precisa de token). Devolve o sha atual (p/ o PUT)."""
    _, d = _req("GET")
    destino.write_bytes(base64.b64decode(d["content"]))
    return d["sha"]


def publish(db_bytes, sha, token, msg):
    body = {"message": msg, "content": base64.b64encode(db_bytes).decode(),
            "sha": sha, "branch": BRANCH}
    _, d = _req("PUT", headers={"Authorization": "token " + token}, body=body)
    return d.get("commit", {}).get("sha", "")[:7]


def main():
    print("=" * 70 + "\n  PUBLICAR GACC (cavaco China) -> dashboard  [sem login no GitHub]\n" + "=" * 70)

    # 1) CSV do customs
    csvs = mg.achar_csvs([a for a in sys.argv[1:] if not a.startswith("-")])
    if not csvs:
        sys.exit(f"\n  ✗ Não achei 'downloadData*.csv' em {mg.DOWNLOADS}.\n"
                 f"    Baixe o CSV no customs primeiro (ou passe o caminho como argumento).")
    print("\n  CSV(s) do customs:")
    for c in csvs:
        print(f"    - {c.name}  ({c.stat().st_size/1024:,.0f} KB)")
    agg, n = mg.ler_csvs([Path(c) for c in csvs])
    rows = mg.pivotar(agg)
    if not rows:
        sys.exit("  ✗ Não achei linhas de cavaco (HS 44012100/44012200) nos CSV.")

    token = load_token()   # lê já pra avisar cedo se faltar (mas só usa no fim)

    # 2) banco atual (leitura pela API — não precisa de token)
    out = SCRIPT_DIR / mg.OUT_NAME
    print("\n  [1/3] Baixando o pulp_paper.db atual (API, leitura)...")
    try:
        sha = fetch_current(out)
        print(f"        ok — versão atual {sha[:7]}")
    except Exception as e:
        sys.exit(f"  ✗ Não consegui LER o banco pela API ({e}).\n"
                 f"    Sem a leitura funcionar, não dá pra publicar. (api.github.com bloqueado?)")

    # 3) troca só os meses do GACC (preserva histórico + tabelas irmãs)
    print("  [2/3] Trocando só os meses do CSV (preserva o resto)...")
    antes, depois, g0, g1, periods, buracos = mg.merge_gacc(out, rows)
    print(f"        GACC: {g0[2]} -> {g1[2]}   (meses gravados: {', '.join(periods)})")
    mud = [t for t in depois if t != "gacc_woodchips" and antes.get(t) != depois.get(t)]
    if mud:
        sys.exit(f"  ✗ Outras tabelas mudaram ({mud}) — abortei por segurança (não publiquei).")
    if buracos:
        print("\n  ⚠⚠ BURACO na série: falta " + ", ".join(buracos))
        print("     Baixe esse(s) mês(es) e rode de novo. NÃO publiquei (não subo com buraco).")
        print(f"     (o banco montado está em {out})")
        return

    # 4) publica de volta (escrita pela API — precisa do token)
    if not token:
        print("\n  ⚠ Sem TOKEN configurado — montei o banco mas NÃO publiquei.")
        print(f"     Crie o arquivo:  {TOKEN_FILE}")
        print("     e cole dentro só o seu token (ver o passo a passo). Depois rode de novo.")
        print(f"     (o banco pronto está em {out})")
        return
    print("  [3/3] Publicando pela API (com o seu token)...")
    try:
        commit = publish(out.read_bytes(), sha, token, f"data: GACC cavaco China -> {periods[-1]}")
        print(f"\n  ✅ PUBLICADO!  commit {commit}. A dashboard atualiza em ~1 min:\n     {DASH}")
    except urllib.error.HTTPError as e:
        msg = e.read()[:300].decode("utf-8", "replace")
        print(f"\n  ✗ A ESCRITA foi recusada (HTTP {e.code}).")
        if e.code == 401:
            print("     → token inválido/expirado. Gere um novo e atualize o token.txt.")
        elif e.code == 403:
            print("     → pode ser (a) a rede do banco bloqueando ESCRITA, ou (b) o token sem a")
            print("       permissão 'Contents: Read and write' neste repo.")
        elif e.code == 409:
            print("     → o banco mudou no repo enquanto isso (conflito). Rode de novo.")
        else:
            print("     →", msg)
        print(f"\n     Plano B: o banco pronto está em {out} — publique-o de um PC com acesso ao GitHub.")
    except Exception as e:
        print(f"\n  ✗ Não consegui publicar ({e}). A rede do banco pode bloquear escrita na API.")
        print(f"     Plano B: o banco pronto está em {out} — publique de um PC com acesso.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n  Cancelado.")
