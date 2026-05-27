import { jwtVerify } from 'jose'

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
    // Verifica o JWT com o segredo do Supabase (HS256)
    const secret = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET)
    await jwtVerify(token, secret)
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
