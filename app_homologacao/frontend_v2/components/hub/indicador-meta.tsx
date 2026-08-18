// O indicador de um turno com a distância até a meta — uma célula da tabela
// de Performance (docs/plans/performance-linha-por-turno.md §5.3).
//
// Substituiu, no grão do turno, o par `FunilCorridas` + `MetaBadge` (removidos
// nesta entrega): os três badges de meta ocupavam 106px dos 143px de altura da
// linha (74%), e o veredito era emitido por LINHA, quando a meta é cadastrada
// por praça × TURNO. Aqui o número e o julgamento moram na mesma célula, numa
// linha só.
//
// As quatro regras vieram de achados adversariais da rodada 24 sobre o
// `MetaBadge` e continuam valendo — mudou o formato, não a semântica:
//
// 1. SEM META, SEM JULGAMENTO. O número aparece; o veredito, não. A tela não
//    inventa patamar para quem nunca acordou nenhum.
// 2. SEM LEITURA, SEM JULGAMENTO. Turno sem corridas ofertadas não tem taxa de
//    aceitação. E o silêncio não serve: a ausência CORRELACIONA com o turno
//    pior (quem não aceitou nada não tem denominador de conclusão), então calar
//    faria a tela julgar menos justamente onde mais importa.
// 3. COMPARAR NA PRECISÃO EM QUE SE EXIBE. Comparando em precisão total e
//    exibindo arredondado, a célula se contradizia na própria frase: 89,96%
//    contra meta de 90% imprimia "90%, abaixo da meta de 90%".
// 4. A COR NUNCA É O ÚNICO SINAL. A distância vem escrita em pontos
//    percentuais (`−15,0pp`), e a frase inteira existe em texto para leitor de
//    tela e no `title` do mouse.

import { cn } from '@/lib/utils';

export interface IndicadorMetaProps {
  /** Leitura já em fração 0..1 (mesma unidade das metas). `null` = sem leitura. */
  valor: number | null;
  /** Meta do cruzamento praça × turno, fração 0..1. `undefined` = não configurada. */
  meta: number | undefined;
  /** Rótulo humano do indicador — entra na frase acessível. */
  rotulo: string;
  /** Contexto que só existe no texto acessível (ex.: "8 aceitas de 12
   *  ofertadas"). Preserva os contadores brutos que saíram da tabela junto
   *  com a coluna do funil. */
  detalhe?: string;
  className?: string;
}

/** Uma casa decimal — a MESMA precisão em que se compara (regra 3 acima). */
const CASAS = 1;
const arredondar = (v: number) => Math.round(v * 100 * 10 ** CASAS) / 10 ** CASAS;
// Sem `minimumFractionDigits`: a casa decimal aparece quando existe (66,7%) e
// some quando não (90%). Forçá-la transformaria toda meta redonda em "90,0%",
// ruído numa coluna que se lê de relance.
const numero = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: CASAS });
const pct = (v: number) => `${numero(arredondar(v))}%`;

export function IndicadorMeta({ valor, meta, rotulo, detalhe, className }: IndicadorMetaProps) {
  const sufixo = detalhe ? ` (${detalhe})` : '';

  // Sem leitura: "—", nunca "0%". Zero é uma afirmação sobre o desempenho;
  // a ausência de leitura é a falta dela.
  if (valor === null) {
    const frase = meta === undefined
      ? `${rotulo}: sem leitura neste turno.${sufixo}`
      : `${rotulo}: sem leitura neste turno (meta de ${pct(meta)}).${sufixo}`;
    return (
      <span className={cn('inline-flex flex-col items-end leading-tight', className)}>
        <span className="sr-only">{frase}</span>
        <span aria-hidden="true" className="text-sm text-muted-foreground" title={frase}>
          —
        </span>
      </span>
    );
  }

  // Sem meta configurada: o número, e só. Silêncio é o correto aqui.
  if (meta === undefined) {
    const frase = `${rotulo}: ${pct(valor)}.${sufixo}`;
    return (
      <span className={cn('inline-flex flex-col items-end leading-tight', className)}>
        <span className="sr-only">{frase}</span>
        <span aria-hidden="true" className="font-mono text-sm" title={frase}>
          {pct(valor)}
        </span>
      </span>
    );
  }

  const valorExibido = arredondar(valor);
  const metaExibida = arredondar(meta);
  const abaixo = valorExibido < metaExibida;
  const acima = valorExibido > metaExibida;
  // Distância em PONTOS percentuais, calculada sobre os valores já exibidos —
  // senão a distância pode contradizer os dois números que estão ao lado dela.
  const distancia = Math.round((valorExibido - metaExibida) * 10 ** CASAS) / 10 ** CASAS;
  const situacao = abaixo ? 'abaixo da' : acima ? 'acima da' : 'na';
  const frase = `${rotulo}: ${pct(valor)}, ${situacao} meta de ${pct(meta)}.${sufixo}`;

  return (
    <span className={cn('inline-flex flex-col items-end leading-tight', className)} title={frase}>
      <span className="sr-only">{frase}</span>
      <span
        aria-hidden="true"
        className={cn('font-mono text-sm', abaixo && 'font-semibold text-destructive')}
      >
        {pct(valor)}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'font-mono text-[0.6875rem]',
          abaixo ? 'text-destructive' : 'text-success'
        )}
      >
        {/* O glifo carrega o estado junto com a cor — quem não distingue as
            cores lê a mesma informação, e "na meta" é um terceiro estado:
            dizer "acima" a quem entregou exatamente o combinado é impreciso. */}
        {abaixo ? '▼' : acima ? '▲' : '='}{' '}
        {distancia === 0 ? 'na meta' : `${distancia > 0 ? '+' : '−'}${numero(Math.abs(distancia))}pp`}
      </span>
    </span>
  );
}
