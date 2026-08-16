// impeccable r24 — o funil de corridas de um turno.
//
// A tabela de performance tinha 13 colunas, cinco delas contadores soltos:
// Ofertadas, Aceitas, Rejeitadas, Completadas, Canceladas. Ler "120 | 100 |
// 20 | 95 | 5" e montar a história — quanto foi aceito, quanto se perdeu no
// caminho — era trabalho que a tela empurrava para a pessoa. Mas esses cinco
// números não são grandezas independentes: são um funil, e o operador que
// ajusta escala ou cobra um parceiro precisa exatamente das duas passagens.
//
// Honestidade: as porcentagens são derivadas AQUI, para leitura, e os
// contadores de origem continuam à vista — quem quiser conferir, confere na
// mesma célula. Os agregados do topo da tela seguem vindo do backend
// (`/performance/resumo`), que é quem tem autoridade sobre a média do
// período. Uma coisa é a razão de uma linha, outra é a taxa do conjunto.

import { cn } from '@/lib/utils';

export interface FunilDados {
  ofertadas: number | null;
  aceitas: number | null;
  rejeitadas: number | null;
  completadas: number | null;
  canceladas: number | null;
}

/**
 * `null` significa "não sei" e nunca vira 0 — a mesma gramática do resto do
 * hub (`stats-cards`, `formatFracaoPct`). Sem denominador, não há razão: a
 * função devolve `null` em vez de 0%, que afirmaria um fato falso.
 */
export function razao(parte: number | null, todo: number | null): number | null {
  if (parte === null || todo === null || todo <= 0) return null;
  return parte / todo;
}

function pct(v: number | null): string {
  if (v === null) return '—';
  return `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`;
}

/** "1 cancelada", não "1 canceladas" — pego com dado real (um turno com
 *  exatamente 1 cancelamento). Contagem 1 é comum e a concordância errada
 *  aparece justo nela. */
function plural(v: number | null, singular: string): string {
  return v === 1 ? singular : `${singular}s`;
}

function num(v: number | null): string {
  return v === null ? '—' : v.toLocaleString('pt-BR');
}

export function FunilCorridas({ dados, className }: { dados: FunilDados; className?: string }) {
  const { ofertadas, aceitas, rejeitadas, completadas, canceladas } = dados;
  const taxaAceitacao = razao(aceitas, ofertadas);
  const taxaConclusao = razao(completadas, aceitas);

  // Larguras dos segmentos: sobre as OFERTADAS, que é o topo do funil. Sem
  // ofertadas não há barra — e não se desenha uma barra vazia que pareceria
  // "tudo zero" quando na verdade é "não sei".
  const base = ofertadas && ofertadas > 0 ? ofertadas : null;

  const perdas = [
    (rejeitadas ?? 0) > 0 ? `${num(rejeitadas)} ${plural(rejeitadas, 'rejeitada')}` : null,
    (canceladas ?? 0) > 0 ? `${num(canceladas)} ${plural(canceladas, 'cancelada')}` : null,
  ].filter((v): v is string => v !== null);
  const larg = (v: number | null) => (base && v !== null ? `${Math.max((v / base) * 100, 1.5)}%` : '0%');

  return (
    <div className={cn('flex min-w-[11rem] flex-col gap-1', className)}>
      {/* A leitura em texto vem primeiro no DOM: é ela que o leitor de tela
          anuncia, e a barra abaixo é a mesma informação em forma visual. */}
      <p className="font-mono text-xs tabular-nums">
        <span className="text-muted-foreground">{num(ofertadas)} of.</span>{' '}
        <span aria-hidden="true" className="text-muted-foreground/60">
          →
        </span>{' '}
        <span className="font-medium">{num(aceitas)} ac.</span>
        <span className="text-muted-foreground"> ({pct(taxaAceitacao)})</span>{' '}
        <span aria-hidden="true" className="text-muted-foreground/60">
          →
        </span>{' '}
        <span className="font-medium">{num(completadas)} compl.</span>
        <span className="text-muted-foreground"> ({pct(taxaConclusao)})</span>
      </p>

      {base && (
        <span
          aria-hidden="true"
          className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
          // O `title` repete o que já está em texto acima — é reforço, nunca
          // a única fonte (regra da r21: informação exclusiva em `title` = 0).
          title={`${num(rejeitadas)} rejeitadas, ${num(canceladas)} canceladas`}
        >
          <span className="bg-[var(--chart-2)]" style={{ width: larg(completadas) }} />
          <span className="bg-[var(--chart-4)]" style={{ width: larg(canceladas) }} />
          <span className="bg-muted-foreground/30" style={{ width: larg(rejeitadas) }} />
        </span>
      )}

      {/* Só o que de fato se perdeu. "5 rejeitadas · 0 canceladas" — visto na
          tela com dado real — gasta uma linha para dizer que nada aconteceu no
          segundo termo, e o zero compete com o número que importa. */}
      {perdas.length > 0 && (
        <p className="text-[0.6875rem] text-muted-foreground">{perdas.join(' · ')}</p>
      )}
    </div>
  );
}
