// Repasse semanal: a tela pede o DIA DA SEMANA do pagamento; o banco guarda
// `apuracao_dias_ate_repasse` e calcula `data_repasse = fim + dias`, com o fim
// INCLUSIVO (`v_fim := inicio + 6`, migrations 0067/0083). Dias: 0=domingo.

/** Dia da semana em que a janela de 7 dias termina. */
const fimDaJanela = (inicio: number) => (inicio + 6) % 7;

/**
 * Dias após o fim até o repasse, sempre de 1 a 7. Repasse no mesmo dia da
 * semana em que a janela fecha vira a semana SEGUINTE (7): pagar no próprio
 * dia do fechamento não existe — a produção do último dia só entra no dia
 * seguinte (importação D-1).
 */
export function diasAteRepasse(inicio: number, diaRepasse: number): number {
  return ((diaRepasse - fimDaJanela(inicio) + 6) % 7) + 1;
}

/** Inverso de `diasAteRepasse`. null quando o número salvo não cabe numa semana. */
export function diaDoRepasse(inicio: number, dias: number): number | null {
  if (!Number.isInteger(dias) || dias < 1 || dias > 7) return null;
  return (fimDaJanela(inicio) + dias) % 7;
}
