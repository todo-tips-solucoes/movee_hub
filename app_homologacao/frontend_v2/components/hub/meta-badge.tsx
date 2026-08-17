// impeccable r24 parte 2 — o sinal de "abaixo da meta" num registro de turno.
//
// Regras que este componente existe para garantir:
//
// 1. SEM META, SEM JULGAMENTO. Quem nunca configurou não vê nada — a tela não
//    inventa patamar nem sugere que 83% seja ruim por conta própria.
// 2. SEM LEITURA, SEM JULGAMENTO. Um turno sem corridas ofertadas não tem taxa
//    de aceitação; marcar isso como "abaixo" seria reprovar a ausência de dado.
// 3. A COR NUNCA É O ÚNICO SINAL. O badge diz "abaixo da meta" em texto e traz
//    os dois números; quem não distingue as cores lê a mesma coisa.

import { cn } from '@/lib/utils';

interface MetaBadgeProps {
  /** Leitura do indicador, já em fração 0..1. `null` = sem leitura. */
  valor: number | null;
  /** Meta do cruzamento, fração 0..1. `undefined` = não configurada. */
  meta: number | undefined;
  /** Rótulo humano do indicador, para o texto acessível. */
  rotulo: string;
  className?: string;
}

/** Uma casa decimal — a mesma que a comparação usa (ver abaixo). */
const CASAS = 1;
const arredondar = (v: number) => Math.round(v * 100 * 10 ** CASAS) / 10 ** CASAS;
const pct = (v: number) => `${arredondar(v).toLocaleString('pt-BR')}%`;

export function MetaBadge({ valor, meta, rotulo, className }: MetaBadgeProps) {
  // Sem meta configurada: silêncio total, e é o correto — a tela não inventa
  // patamar para quem nunca acordou nenhum.
  if (meta === undefined) return null;

  // Meta existe e leitura NÃO: dizer isso. Antes era silêncio, indistinguível
  // de "sem meta" — e a revisão adversarial mostrou que a ausência correlaciona
  // com o turno PIOR: um turno em que ninguém aceitou nada não tem taxa de
  // conclusão (sem denominador), então quanto pior o turno em certos eixos,
  // menos julgamento a tela emitia.
  if (valor === null) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full border border-border bg-muted px-1.5 py-0.5 text-[0.6875rem] font-medium text-muted-foreground',
          className
        )}
      >
        <span aria-hidden="true">—</span>
        <span>
          {rotulo}: sem leitura neste turno
          <span className="font-normal"> (meta de {pct(meta)})</span>
        </span>
      </span>
    );
  }

  // Comparar na MESMA precisão em que se exibe. Comparando em precisão total e
  // exibindo arredondado, o badge se contradizia na própria frase: leitura
  // 89,96% contra meta de 90% imprimia "90% abaixo da meta de 90%" — achado
  // adversarial, reproduzido em node. Alcançável com dado real, porque
  // `tempo_disponivel_pct` chega com 2 casas.
  const valorExibido = arredondar(valor);
  const metaExibida = arredondar(meta);
  const abaixo = valorExibido < metaExibida;
  const acima = valorExibido > metaExibida;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[0.6875rem] font-medium',
        abaixo
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-success/30 bg-success/10 text-success',
        className
      )}
    >
      <span aria-hidden="true">{abaixo ? '▼' : '▲'}</span>
      <span>
        {rotulo}: {pct(valor)}
        {/* Três estados, não dois: "na meta" em português operacional quer
            dizer EXATAMENTE no patamar. Dizer isso para quem entregou 95%
            contra meta de 70% subdeclara o desempenho de quem foi bem — e a
            cor verde já cobre os dois casos bons. */}
        <span className="font-normal">
          {' '}
          {abaixo ? 'abaixo da' : acima ? 'acima da' : 'na'} meta de {pct(meta)}
        </span>
      </span>
    </span>
  );
}
