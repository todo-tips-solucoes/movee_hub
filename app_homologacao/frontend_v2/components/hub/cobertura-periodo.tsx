'use client';

// impeccable r23 — a peça de conferência do faturamento.
//
// Por que ela existe: a tela de faturamento é usada para CONFERIR antes de
// liberar pagamento (decisão do operador, 2026-08-15), e a anomalia número 1
// de uma importação é um dia que não entrou. O gráfico anterior agrupava "por
// dia", mas cortava nos 10 primeiros e os rotulava como "os 10 maiores" —
// num período de 30 dias, mostrava os 10 primeiros CRONOLOGICAMENTE com um
// rótulo que dizia outra coisa, e um dia faltante no meio nunca aparecia.
//
// Aqui o eixo é o calendário, não o ranking: todos os dias do intervalo, em
// ordem, e o dia sem lançamento é DESENHADO como lacuna em vez de omitido.
// Uma barra ausente no meio de uma faixa contínua é lida antes de qualquer
// texto — é para isso que a peça existe.
//
// Honestidade dos valores: o total de cada dia é a string que veio do backend
// (`/faturamento/resumo?groupBy=dia`), nunca uma soma do cliente. O
// `parseFloat` calcula SÓ a altura proporcional da barra.

import { cn } from '@/lib/utils';

export interface DiaCobertura {
  /** `YYYY-MM-DD`. */
  chave: string;
  /** Total do dia, string decimal do backend. */
  total: string;
  /** Já formatado em pt-BR pelo chamador (evita duplicar regra de moeda). */
  totalFormatado: string;
  quantidade: number;
}

interface CoberturaPeriodoProps {
  /** Primeiro dia do intervalo, `YYYY-MM-DD`. */
  de: string;
  /** Último dia do intervalo, `YYYY-MM-DD`. */
  ate: string;
  dias: DiaCobertura[];
  /** O intervalo foi derivado dos próprios dados (o operador não filtrou por
   *  período) — muda a frase, porque aí "sem lançamento" só existe DENTRO do
   *  que veio, e não se pode afirmar nada sobre as bordas. */
  intervaloDerivado?: boolean;
  className?: string;
}

/**
 * Dias de `de` até `ate`, inclusive, em `YYYY-MM-DD`.
 *
 * `Date.UTC` e não `new Date('2026-07-01')` + `setDate`: o construtor local
 * aplica o fuso e, a oeste de Greenwich, `2026-07-01` vira 30/06 21:00 — o
 * primeiro dia do período sumiria da faixa. Em UTC a aritmética é sobre o dia
 * civil, que é o que a data de competência significa.
 */
/** Além disto a faixa não é legível (nem barata de renderizar): uma barra por
 *  dia vira um borrão, e o número de nós explode. */
export const MAX_DIAS_FAIXA = 400;

/** O intervalo existe e é válido, mas é largo demais para virar faixa. */
export function intervaloLongoDemais(de: string, ate: string): boolean {
  const inicio = Date.parse(`${de}T00:00:00Z`);
  const fim = Date.parse(`${ate}T00:00:00Z`);
  if (Number.isNaN(inicio) || Number.isNaN(fim) || fim < inicio) return false;
  return (fim - inicio) / 86_400_000 > MAX_DIAS_FAIXA;
}

export function diasDoIntervalo(de: string, ate: string): string[] {
  const inicio = Date.parse(`${de}T00:00:00Z`);
  const fim = Date.parse(`${ate}T00:00:00Z`);
  if (Number.isNaN(inicio) || Number.isNaN(fim) || fim < inicio) return [];
  const DIA = 86_400_000;
  // Guarda de sanidade — e ela dispara com dado REAL, não hipotético: a base
  // de QA tem lançamentos com competência em 1900 ao lado de 2026, então o
  // intervalo derivado passa de 46 mil dias. Sem a guarda seriam 46 mil nós;
  // com ela e sem a mensagem abaixo, a faixa sumiria em silêncio, que é pior
  // — some justamente quando há algo estranho no dado.
  if ((fim - inicio) / DIA > MAX_DIAS_FAIXA) return [];
  const dias: string[] = [];
  for (let t = inicio; t <= fim; t += DIA) {
    dias.push(new Date(t).toISOString().slice(0, 10));
  }
  return dias;
}

/** `2026-07-01` -> `01/07`. Rótulo curto: a faixa tem uma célula por dia. */
function diaMes(chave: string): string {
  const [, mes, dia] = chave.split('-');
  return mes && dia ? `${dia}/${mes}` : chave;
}

export function CoberturaPeriodo({
  de,
  ate,
  dias,
  intervaloDerivado = false,
  className,
}: CoberturaPeriodoProps) {
  const todos = diasDoIntervalo(de, ate);

  // Largo demais para desenhar: explica em vez de sumir. Um intervalo de anos
  // costuma ser sintoma (competência digitada errada na planilha), e é
  // exatamente o tipo de coisa que a conferência precisa ver.
  if (todos.length === 0 && intervaloLongoDemais(de, ate)) {
    return (
      <section aria-labelledby="cobertura-titulo" className={cn('flex flex-col gap-2', className)}>
        <h2 id="cobertura-titulo" className="text-sm font-medium">
          Cobertura do período
        </h2>
        <p className="rounded-lg border bg-card p-3 text-xs text-muted-foreground">
          Os lançamentos vão de {diaMes(de)}/{de.slice(0, 4)} a {diaMes(ate)}/{ate.slice(0, 4)} —
          mais de {MAX_DIAS_FAIXA} dias. Filtre por competência para conferir um período fechado.
          Um intervalo tão largo costuma indicar data de competência incorreta na planilha de
          origem.
        </p>
      </section>
    );
  }

  if (todos.length === 0) return null;

  const porChave = new Map(dias.map((d) => [d.chave, d]));
  const vazios = todos.filter((c) => !porChave.has(c));
  const max = Math.max(...dias.map((d) => parseFloat(d.total) || 0), 0);

  return (
    <section aria-labelledby="cobertura-titulo" className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="cobertura-titulo" className="text-sm font-medium">
          Cobertura do período
        </h2>
        {/* O status é TEXTO, não só a cor da lacuna: a ausência de barra é o
            sinal rápido, mas quem não distingue a falha visual precisa da
            frase — e ela também é o que o leitor de tela anuncia. */}
        <p
          className={cn(
            'text-xs',
            vazios.length > 0 ? 'font-medium text-warning-strong' : 'text-muted-foreground'
          )}
        >
          {vazios.length === 0
            ? `${todos.length} dias no período, todos com lançamento.`
            : `${vazios.length} de ${todos.length} dias sem nenhum lançamento${
                intervaloDerivado ? '' : ' no período filtrado'
              }.`}
        </p>
      </div>

      <ul className="flex items-end gap-px overflow-x-auto rounded-lg border bg-card p-3">
        {todos.map((chave) => {
          const dia = porChave.get(chave);
          const valor = dia ? parseFloat(dia.total) || 0 : 0;
          // Piso de 6% para que um dia de valor baixo continue sendo uma
          // barra visível: a distinção que importa aqui é "teve x não teve",
          // e um traço de 1px lido como lacuna inverteria o sinal.
          const pct = dia && max > 0 ? Math.max((valor / max) * 100, 6) : 0;
          return (
            <li
              key={chave}
              className="flex min-w-[0.5rem] flex-1 flex-col items-center justify-end gap-1"
              title={
                dia
                  ? `${diaMes(chave)}: ${dia.totalFormatado} em ${dia.quantidade} lançamento${dia.quantidade === 1 ? '' : 's'}`
                  : `${diaMes(chave)}: sem lançamento`
              }
            >
              {/* Cada dia é lido em texto pelo leitor de tela; a barra é
                  decoração do mesmo fato. */}
              <span className="sr-only">
                {dia
                  ? `${diaMes(chave)}: ${dia.totalFormatado}, ${dia.quantidade} lançamento${dia.quantidade === 1 ? '' : 's'}.`
                  : `${diaMes(chave)}: sem lançamento.`}
              </span>
              {/* A lacuna precisa ser lida como AUSÊNCIA, não como barra
                  baixa. Só a linha tracejada na base não bastava: visto na
                  renderização real, um dia de R$ 100 ao lado de um de R$
                  20.600 vira o mesmo traço fino que a lacuna, e o sinal se
                  perde. A coluna inteira tingida separa as duas leituras à
                  distância — e a cor não é o único sinal: há o tracejado, o
                  texto do cabeçalho e o `sr-only` de cada dia. */}
              <span
                aria-hidden="true"
                className={cn(
                  'flex h-16 w-full items-end',
                  // Sem `rounded-*` aqui: canto arredondado brigando com a
                  // borda tracejada de 2px foi achado pelo detector, e a
                  // coluna de lacuna é um retângulo por natureza.
                  !dia && 'border-b-2 border-dashed border-warning/70 bg-warning/10'
                )}
              >
                {dia && (
                  <span
                    className="w-full rounded-sm bg-[var(--chart-1)] transition-[height] duration-300 motion-reduce:transition-none"
                    style={{ height: `${pct}%` }}
                  />
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-muted-foreground">
        {intervaloDerivado
          ? 'Intervalo derivado dos lançamentos carregados — filtre por competência para conferir um período fechado.'
          : `De ${diaMes(de)} a ${diaMes(ate)}, um dia por barra. Dia sem lançamento aparece como lacuna.`}
      </p>
    </section>
  );
}
