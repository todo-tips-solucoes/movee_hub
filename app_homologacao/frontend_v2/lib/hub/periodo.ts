// impeccable rodada 3 — atalhos de período dos filtros do hub (h7
// "Flexibilidade/eficiência" 2/4 no critique #2: "datas à mão sem presets").
//
// Funções PURAS: recebem "hoje" como parâmetro em vez de chamar `new Date()`
// por dentro — é o que torna o comportamento testável sem congelar o relógio.
//
// Convenção de data: string `YYYY-MM-DD` no fuso LOCAL, o mesmo formato que
// `<input type="date">` emite e que os filtros já mandam para o backend.
// `toISOString()` está proibido aqui de propósito: ele converte para UTC e,
// em UTC-3, "hoje" às 21h vira o dia seguinte.

export type PeriodoPreset = 'hoje' | '7d' | '30d' | 'mes';

export interface Intervalo {
  de: string;
  ate: string;
}

export const PERIODO_PRESETS: Array<{ id: PeriodoPreset; rotulo: string; descricao: string }> = [
  { id: 'hoje', rotulo: 'Hoje', descricao: 'Somente o dia de hoje' },
  { id: '7d', rotulo: '7 dias', descricao: 'Os últimos 7 dias, incluindo hoje' },
  { id: '30d', rotulo: '30 dias', descricao: 'Os últimos 30 dias, incluindo hoje' },
  { id: 'mes', rotulo: 'Este mês', descricao: 'Do dia 1º do mês corrente até hoje' },
];

/** `Date` → `YYYY-MM-DD` no fuso local (ver nota sobre `toISOString` acima). */
export function paraISO(d: Date): string {
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

/** `YYYY-MM-DD` → `DD/MM/AAAA` para exibição pt-BR. String vazia ou fora do
 * formato devolve `null` — o chamador decide o que mostrar no lugar. */
export function formatarISOparaBR(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** Intervalo fechado [de, ate] correspondente ao preset. */
export function intervaloDoPreset(preset: PeriodoPreset, hoje: Date = new Date()): Intervalo {
  const ate = paraISO(hoje);
  if (preset === 'hoje') return { de: ate, ate };
  if (preset === 'mes') {
    return { de: paraISO(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), ate };
  }
  // "7 dias" INCLUI hoje — por isso -6, não -7. `new Date(ano, mes, dia)`
  // normaliza dia <= 0 para o mês anterior, então a virada de mês/ano sai de graça.
  const dias = preset === '7d' ? 6 : 29;
  const inicio = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - dias);
  return { de: paraISO(inicio), ate };
}

/** Qual preset o par (de, ate) representa, ou `null` se for um intervalo
 * personalizado. É o que permite ao chip acender sozinho depois de um reload
 * — o estado do filtro continua sendo só `de`/`ate`, sem preset persistido.
 *
 * `preferido` desempata quando DOIS presets produzem o mesmo intervalo, que é
 * mais comum do que parece: no dia 7 de qualquer mês, "7 dias" e "Este mês"
 * são ambos 01..07; no dia 30, "30 dias" e "Este mês" coincidem; no dia 1º,
 * "Hoje" e "Este mês" também. Sem o desempate, quem clicava em "Este mês" via
 * "7 dias" acender (achado da verificação viva da rodada 4, em 2026-08-07).
 * O chamador passa o último preset clicado; se ele ainda descreve o intervalo
 * atual, é ele que vence. Nada é persistido: após um reload sem `preferido`,
 * volta a valer a ordem da lista. */
export function presetAtivo(
  de: string,
  ate: string,
  hoje: Date = new Date(),
  preferido?: PeriodoPreset | null,
): PeriodoPreset | null {
  if (!de || !ate) return null;
  const casa = (id: PeriodoPreset) => {
    const alvo = intervaloDoPreset(id, hoje);
    return alvo.de === de && alvo.ate === ate;
  };
  if (preferido && casa(preferido)) return preferido;
  for (const { id } of PERIODO_PRESETS) {
    if (casa(id)) return id;
  }
  return null;
}
