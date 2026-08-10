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
 */
export function resolverTitulo(
  pathname: string,
  modulos: { codigo: string; nome: string }[]
): string {
  const candidatos = modulos
    .map((m) => ({ nome: m.nome, rota: moduloParaRota(m.codigo) }))
    .filter((m) => pathname === m.rota || pathname.startsWith(`${m.rota}/`))
    .sort((a, b) => b.rota.length - a.rota.length);

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
    document.title = resolverTitulo(pathname, modulos);
  }, [pathname, modulos]);

  return null;
}
