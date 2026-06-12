// Middleware sem dependências externas — usa Web Crypto API nativa do Edge Runtime
// Supabase usa ECC P-256 (ES256) para assinar tokens JWT

const JWKS_URL = 'https://mmhkqkpjrvyxovpihnio.supabase.co/auth/v1/.well-known/jwks.json'

export const config = {
  matcher: ['/((?!login\\.html|favicon\\.ico).*)']
}

function getCookie(request, name) {
  const header = request.headers.get('cookie') || ''
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k.trim() === name) return v.join('=')
  }
  return null
}

// Cache de chaves com TTL de 1h para sobreviver a rotações de chave
let _keys = null
let _keysFetchedAt = 0
const KEYS_TTL_MS = 60 * 60 * 1000

async function getKeys() {
  const now = Date.now()
  if (_keys && (now - _keysFetchedAt) < KEYS_TTL_MS) return _keys
  try {
    const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`JWKS fetch ${res.status}`)
    const { keys } = await res.json()
    _keys = await Promise.all(keys.map(k =>
      crypto.subtle.importKey(
        'jwk', k,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, ['verify']
      )
    ))
    _keysFetchedAt = now
    return _keys
  } catch (e) {
    // Se o fetch falhou mas já temos chaves em cache, usa o cache antigo
    if (_keys) return _keys
    throw e
  }
}

function b64url(s) {
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
}

async function verifyJWT(token) {
  const [h, p, sig] = token.split('.')
  if (!h || !p || !sig) return false

  const payload = JSON.parse(new TextDecoder().decode(b64url(p)))
  if (payload.exp < Date.now() / 1000) return false

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

function redirectToLogin(requestUrl) {
  return Response.redirect(new URL('/login.html', requestUrl), 302)
}

export default async function middleware(request) {
  // Wrapper global — qualquer erro não tratado redireciona para login
  // em vez de retornar 500 MIDDLEWARE_INVOCATION_FAILED
  try {
    const token = getCookie(request, 'sb-access-token')

    if (!token) {
      return redirectToLogin(request.url)
    }

    try {
      const valid = await verifyJWT(token)
      if (!valid) throw new Error('invalid')
      // Token válido → deixa passar
    } catch {
      const res = redirectToLogin(request.url)
      res.headers.append(
        'Set-Cookie',
        'sb-access-token=; Max-Age=0; Path=/; SameSite=Lax; Secure'
      )
      return res
    }
  } catch {
    // Fallback seguro: qualquer crash inesperado vai para login, não para 500
    return redirectToLogin(request.url)
  }
}
