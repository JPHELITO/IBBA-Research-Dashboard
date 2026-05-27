// Middleware sem dependências externas — usa Web Crypto API nativa do Edge Runtime
// Supabase usa ECC P-256 (ES256) para assinar tokens JWT

const JWKS_URL = 'https://mmhkqkpjrvyxovpihnio.supabase.co/auth/v1/.well-known/jwks.json'

export const config = {
  matcher: ['/((?!login\\.html|favicon\\.ico).*)']
}

// Cache de chaves públicas (reutilizado entre requests no mesmo edge node)
let _keys = null
async function getKeys() {
  if (_keys) return _keys
  const res = await fetch(JWKS_URL)
  const { keys } = await res.json()
  _keys = await Promise.all(keys.map(k =>
    crypto.subtle.importKey(
      'jwk', k,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, ['verify']
    )
  ))
  return _keys
}

function b64url(s) {
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
}

async function verifyJWT(token) {
  const [h, p, sig] = token.split('.')
  if (!h || !p || !sig) return false

  // Verifica expiração
  const payload = JSON.parse(new TextDecoder().decode(b64url(p)))
  if (payload.exp < Date.now() / 1000) return false

  // Verifica assinatura ECC
  const msg = new TextEncoder().encode(`${h}.${p}`)
  const keys = await getKeys()
  for (const key of keys) {
    try {
      const valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' }, key, b64url(sig), msg
      )
      if (valid) return true
    } catch {}
  }
  return false
}

export default async function middleware(request) {
  const token = request.cookies.get('sb-access-token')?.value

  // Sem token → redireciona para login
  if (!token) {
    return Response.redirect(new URL('/login.html', request.url), 302)
  }

  try {
    const valid = await verifyJWT(token)
    if (!valid) throw new Error('invalid')
    // Token válido → deixa passar (Vercel serve o arquivo estático)
  } catch {
    // Token inválido ou expirado → limpa cookie e redireciona
    const res = Response.redirect(new URL('/login.html', request.url), 302)
    res.headers.append('Set-Cookie', 'sb-access-token=; Max-Age=0; Path=/; SameSite=Lax; Secure')
    return res
  }
}
