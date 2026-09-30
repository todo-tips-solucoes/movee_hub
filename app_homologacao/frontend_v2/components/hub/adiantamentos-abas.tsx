'use client';

// adiantamento-motorista — components/hub/adiantamentos-abas.tsx (tasks.md 7.2.1)
//
// Navegação por abas do módulo `adiantamentos`, na ordem do fluxo do dinheiro:
// Solicitações · Aguardando lote · Lotes · Repasse · Contas bancárias ·
// Configurações.
//
// "Aguardando lote" chamava-se "Pagamentos" até 2026-09-30 e era o rótulo mais
// enganoso do módulo: a tela lista o que AINDA VAI ser pago (aprovado, fora de
// lote), nunca o que já foi. O operador procurou nela um lote já gerado — que
// por definição não está lá — e concluiu que o adiantamento havia sumido. O
// nome novo diz o estado e encadeia com a aba seguinte: "Aguardando lote" ->
// "Lotes".
//
// ⚠️ NÃO usar "A pagar" aqui: já é a coluna do extrato em `repasse/page.tsx`
// (quanto o motorista recebe na semana). Mesmo rótulo para duas contas
// diferentes no mesmo módulo é o vocabulário duplo que o CLAUDE.md proíbe.
//
// "Contas bancárias" desceu para depois de "Repasse": é cadastro de apoio, não
// etapa do caminho do dinheiro (pede -> a pagar -> lote -> repasse da semana). Cada aba só aparece se a entidade ativa
// tiver a permissão que o respectivo `GET` exige de fato no backend — NÃO a
// permissão de "gerenciar" da área, que é sobre ação, não sobre visão
// (contracts/hub-api.md §Parte 2, ground truth em routes/hub-adiantamentos.js):
//   - Solicitações  -> GET /            -> adiantamentos.consultar
//   - Aguardando lote -> GET /lotes      -> adiantamentos.pagamentos_consultar
//   - Lotes         -> GET /lotes       -> adiantamentos.pagamentos_consultar
//   - Repasse       -> GET /repasse     -> adiantamentos.pagamentos_consultar
//   - Contas        -> GET /contas      -> adiantamentos.contas_consultar
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
  { href: `${BASE}/pagamentos`, label: 'Aguardando lote', permissao: 'adiantamentos.pagamentos_consultar' },
  { href: `${BASE}/lotes`, label: 'Lotes', permissao: 'adiantamentos.pagamentos_consultar' },
  { href: `${BASE}/repasse`, label: 'Repasse', permissao: 'adiantamentos.pagamentos_consultar' },
  { href: `${BASE}/contas`, label: 'Contas bancárias', permissao: 'adiantamentos.contas_consultar' },
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
