import { jwtVerify, createRemoteJWKSet } from 'jose'

// Supabase usa ECC (P-256) — verificamos contra as chaves públicas via JWKS
const JWKS = createRemoteJWKSet(
  new URL('https://mmhkqkpjrvyxovpihnio.supabase.co/auth/v1/.well-known/jwks.json')
)

// Protege tudo, exceto a página de login e o favicon
export const config = {
  matcher: ['/((?!login\\.html|favicon\\.ico).*)']
}

export default async function middleware(request) {
  const token = request.cookies.get('sb-access-token')?.value

  // Sem token → redireciona para login
  if (!token) {
    return Response.redirect(new URL('/login.html', request.url), 302)
  }

  try {
    // Verifica o JWT contra a chave pública ECC do Supabase
    await jwtVerify(token, JWKS)
    // Token válido → deixa passar (Vercel serve o arquivo estático)
  } catch {
    // Token inválido ou expirado → limpa o cookie e redireciona
    const res = Response.redirect(new URL('/login.html', request.url), 302)
    res.headers.append(
      'Set-Cookie',
      'sb-access-token=; Max-Age=0; Path=/; SameSite=Lax; Secure'
    )
    return res
  }
}
