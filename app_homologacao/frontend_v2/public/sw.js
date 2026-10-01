/**
 * Service worker do painel — existe por UM motivo: o Chrome só considera o app
 * instalável se houver um SW com fetch handler que responda quando a rede cai.
 *
 * ⚠️ Ele NÃO cacheia nada. Nenhum HTML, nenhum bundle, nenhum asset. Isso é
 * deliberado: SW que cacheia bundle é a forma clássica de um deploy novo não
 * chegar ao usuário, e aqui o produto é atualizado várias vezes por semana (a
 * prova de bundle do rito ficaria mentindo). Navegação sempre vai à rede; só
 * quando a rede FALHA o SW devolve a página de aviso abaixo, gerada aqui mesmo
 * (sem cache, sem rota extra no app).
 *
 * Se algum dia precisar de offline de verdade, use `@serwist/next` como o app
 * motorista faz — não acrescente cache à mão neste arquivo.
 */
const AVISO_OFFLINE = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sem conexão · Hub de Frota</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
         background:#f8fafc; color:#0f172a; padding:24px; }
  @media (prefers-color-scheme: dark) { body { background:#0f172a; color:#f8fafc; } }
  main { max-width:22rem; text-align:center; }
  h1 { font-size:1.25rem; margin:0 0 .5rem; }
  p { margin:0 0 1.5rem; opacity:.8; }
  button { font:inherit; font-weight:600; padding:.75rem 1.25rem; border:0; border-radius:.5rem;
           background:#2c67ea; color:#fff; min-height:44px; cursor:pointer; }
</style></head>
<body><main>
  <h1>Sem conexão</h1>
  <p>O Hub de Frota precisa de internet. Verifique a conexão e tente de novo.</p>
  <button onclick="location.reload()">Tentar de novo</button>
</main></body></html>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  // Só navegações. Todo o resto (JS, CSS, imagens, /api) passa direto para a
  // rede, sem o SW no caminho.
  if (e.request.mode !== 'navigate') return;
  e.respondWith(
    fetch(e.request).catch(
      () => new Response(AVISO_OFFLINE, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    ),
  );
});
