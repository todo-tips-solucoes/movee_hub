'use client';

// impeccable rodada 8 (P2) — o título da aba passa a nomear o módulo aberto.
//
// Medido antes: 13 rotas, 1 único `document.title`. Aqui o nome sai dos
// próprios módulos do `GET /me` (os mesmos que desenham a navegação), então
// renomear um módulo no banco renomeia a aba junto — nada de mapa paralelo de
// rótulos para sair de sincronia.
//
// Não renderiza nada: só mantém `document.title` alinhado à rota.

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { moduloParaRota } from '@/lib/hub/module-nav';

const SUFIXO = 'Hub de Frota';

/**
 * Módulo cuja rota casa com o caminho atual. Casa por prefixo para que as
 * subrotas (`/importacoes/123`, `/usuarios/papeis`) herdem o título do módulo,
 * e escolhe o prefixo MAIS LONGO — sem isso `/hub/dashboard` (módulo "Painel
 * Geral") venceria todas as outras, já que é prefixo de todas.
 *
 * `tituloDaPagina` (rodada 9) é o `<h1>` que a tela já mostra. Ele resolve as
 * rotas que NÃO são módulos do `/me` — `/admin` e `/perfil` — e que, medidas,
 * anunciavam "Painel Geral · Hub de Frota" por serem subrotas de
 * `/hub/dashboard`. O título da aba passando a ser o mesmo texto do cabeçalho
 * visível é a resposta certa e não custa mapa paralelo nenhum: quando a rota
 * casa EXATAMENTE com um módulo, o nome do módulo continua mandando.
 */
export function resolverTitulo(
  pathname: string,
  modulos: { codigo: string; nome: string }[],
  tituloDaPagina?: string | null
): string {
  const candidatos = modulos
    .map((m) => ({ nome: m.nome, rota: moduloParaRota(m.codigo) }))
    .filter((m) => pathname === m.rota || pathname.startsWith(`${m.rota}/`))
    .sort((a, b) => b.rota.length - a.rota.length);

  const exato = candidatos.find((c) => c.rota === pathname);
  if (exato) return `${exato.nome} · ${SUFIXO}`;

  const daPagina = tituloDaPagina?.trim();
  if (daPagina) return `${daPagina} · ${SUFIXO}`;

  return candidatos.length > 0 ? `${candidatos[0].nome} · ${SUFIXO}` : SUFIXO;
}

export function TituloDaRota() {
  const pathname = usePathname();
  const { modulos } = useHubAuth();

  useEffect(() => {
    // Sem módulos ainda (o /me não resolveu), NÃO escreve: o fallback
    // sobrescreveria o título correto por alguns frames e, medido, aparecia
    // como título errado em execuções inteiras. Sem escrita, vale o metadata
    // do layout — que já é "Hub de Frota".
    if (modulos.length === 0) return;
    // Este efeito é do LAYOUT, então roda depois dos efeitos da página: o
    // `<h1>` já está no DOM quando chegamos aqui. Se ele depender de fetch
    // (`/importacoes/[id]`), a leitura vem vazia e o nome do módulo assume —
    // que é o comportamento certo para subrota.
    const h1 = document.querySelector('#conteudo-principal h1')?.textContent;
    document.title = resolverTitulo(pathname, modulos, h1);
  }, [pathname, modulos]);

  return null;
}
