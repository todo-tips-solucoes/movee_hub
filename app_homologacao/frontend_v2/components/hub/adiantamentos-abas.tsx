'use client';

// adiantamento-motorista — components/hub/adiantamentos-abas.tsx (tasks.md 7.2.1)
//
// Navegação por abas do módulo `adiantamentos`: Solicitações · Pagamentos ·
// Contas · Repasse · Configurações. Cada aba só aparece se a entidade ativa
// tiver a permissão que o respectivo `GET` exige de fato no backend — NÃO a
// permissão de "gerenciar" da área, que é sobre ação, não sobre visão
// (contracts/hub-api.md §Parte 2, ground truth em routes/hub-adiantamentos.js):
//   - Solicitações  -> GET /            -> adiantamentos.consultar
//   - Pagamentos    -> GET /lotes       -> adiantamentos.pagamentos_consultar
//   - Contas        -> GET /contas      -> adiantamentos.contas_consultar
//   - Repasse       -> GET /repasse     -> adiantamentos.pagamentos_consultar
//   - Configurações -> GET /configuracoes -> adiantamentos.consultar (só o
//     PUT exige `configurar` — quem só consulta ainda vê a regra vigente)
//
// Mesmo padrão de navegação por `<Link>`+`usePathname` de
// `frontend_motorista/components/bottom-nav.tsx` (adaptado ao hub: aba
// sublinhada em vez de barra inferior).
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useHubAuth } from '@/contexts/hub-auth-context';

interface Aba {
  href: string;
  label: string;
  permissao: string;
}

const BASE = '/hub/dashboard/adiantamentos';

const ABAS: Aba[] = [
  { href: BASE, label: 'Solicitações', permissao: 'adiantamentos.consultar' },
  { href: `${BASE}/pagamentos`, label: 'Pagamentos', permissao: 'adiantamentos.pagamentos_consultar' },
  { href: `${BASE}/contas`, label: 'Contas bancárias', permissao: 'adiantamentos.contas_consultar' },
  { href: `${BASE}/repasse`, label: 'Repasse', permissao: 'adiantamentos.pagamentos_consultar' },
  { href: `${BASE}/configuracoes`, label: 'Configurações', permissao: 'adiantamentos.consultar' },
];

export function AdiantamentosAbas() {
  const pathname = usePathname();
  const { permissoes } = useHubAuth();
  const visiveis = ABAS.filter((aba) => (permissoes ?? []).includes(aba.permissao));

  // Sem permissão para nenhuma aba (não deveria acontecer — o módulo só
  // aparece no menu com `adiantamentos.consultar` mínimo) ou só uma
  // visível: nada para navegar, evita barra vazia/com 1 item solto.
  if (visiveis.length <= 1) return null;

  return (
    <nav aria-label="Seções de Adiantamentos" className="flex gap-1 overflow-x-auto border-b border-border">
      {visiveis.map((aba) => {
        // BASE (Solicitações) é prefixo de TODAS as demais rotas — só conta
        // como ativa em match exato, senão "Pagamentos"/"Contas"/etc.
        // acendiam as duas abas ao mesmo tempo (startsWith bateria sempre).
        const ativa =
          pathname === aba.href || (aba.href !== BASE && (pathname?.startsWith(`${aba.href}/`) ?? false));
        return (
          <Link
            key={aba.href}
            href={aba.href}
            aria-current={ativa ? 'page' : undefined}
            className={cn(
              'shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              ativa
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {aba.label}
          </Link>
        );
      })}
    </nav>
  );
}
