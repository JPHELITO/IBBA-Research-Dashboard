// =============================================================================
// Edge Function: github-runs  (Fase D — monitor do GitHub DENTRO do painel admin)
//
// Lista as execuções recentes do GitHub Actions (dashboard + news-hunter), AO VIVO.
// O token do GitHub NUNCA vai pro navegador: fica em private_config (key='github_pat')
// e é lido aqui no servidor (service role). Só ADMIN consegue chamar (checa is_admin()).
//
// COMO PUBLICAR (Supabase → Edge Functions → Deploy a new function):
//   nome = github-runs ; cole este arquivo ; **DESLIGUE "Verify JWT"** (a checagem de
//   admin é feita aqui dentro). As variáveis SUPABASE_URL / SUPABASE_ANON_KEY /
//   SUPABASE_SERVICE_ROLE_KEY já vêm prontas (built-in) — não precisa configurar nada.
//   O token do GitHub é o mesmo que você já colou no painel (Atualizar dados → Configuração).
// =============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2"

const REPOS = [
  { slug: "JPHELITO/IBBA-Research-Dashboard", label: "dashboard" },
  { slug: "JPHELITO/news-hunter", label: "news-hunter" },
]
const PER_REPO = 12

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } })

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!

    // 1) Só admin: usa o JWT de quem chamou p/ rodar is_admin()
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    })
    const { data: isAdmin, error: adminErr } = await userClient.rpc("is_admin")
    if (adminErr || isAdmin !== true) return json({ error: "forbidden" }, 403)

    // 2) Lê o PAT (service role; private_config tem RLS sem policy)
    const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!)
    const { data: cfg } = await admin.from("private_config").select("value").eq("key", "github_pat").maybeSingle()
    const pat = cfg?.value
    if (!pat) return json({ error: "no_token" }, 400)

    // 3) Busca as runs de cada repo (best-effort: se o token não cobrir um repo, ignora)
    const out: Record<string, unknown>[] = []
    const notes: string[] = []
    for (const r of REPOS) {
      try {
        const resp = await fetch(
          `https://api.github.com/repos/${r.slug}/actions/runs?per_page=${PER_REPO}`,
          { headers: {
              Authorization: `Bearer ${pat}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "ibba-admin",
              "X-GitHub-Api-Version": "2022-11-28",
          } },
        )
        if (!resp.ok) { notes.push(`${r.label}: HTTP ${resp.status}`); continue }
        const j = await resp.json()
        for (const w of (j.workflow_runs ?? [])) {
          out.push({
            repo: r.label, name: w.name, title: w.display_title,
            status: w.status, conclusion: w.conclusion,
            created_at: w.created_at, url: w.html_url, branch: w.head_branch, event: w.event,
          })
        }
      } catch (e) { notes.push(`${r.label}: ${String(e)}`) }
    }
    out.sort((a, b) => (String(a.created_at) < String(b.created_at) ? 1 : -1))
    return json({ runs: out.slice(0, 25), notes })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
