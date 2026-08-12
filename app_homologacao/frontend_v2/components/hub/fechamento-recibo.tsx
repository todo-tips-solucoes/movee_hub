'use client';

// impeccable rodada 20 (P1 da crítica) — o fim do ciclo semanal deixa de ser
// um toast de 4 segundos.
//
// Fechar o movimento é a ação mais definitiva do produto: depois dela as
// linhas somem da tela e não há histórico para consultar (a própria crítica
// pergunta "o que acontece com um movimento depois de fechado?" — hoje, nada).
// O único vestígio era um toast que some sozinho, e logo abaixo um estado
// vazio genérico dizendo "Importe um arquivo XLSX", como se nada tivesse
// acontecido ali.
//
// Este recibo é o vestígio. Ele fica até ser dispensado, com os números do
// movimento que acabou de fechar — capturados ANTES do fechamento, porque
// depois a lista recarrega vazia e eles deixam de existir.
//
// ⚠️ Sem `aria-live`, de propósito (lição da r17): quem anuncia o marco é o
// toast, que é efêmero por natureza. Uma região viva permanente faria quem
// navega o documento tropeçar no recibo horas depois — e o disparo já tinha
// esse defeito, corrigido nesta mesma rodada.

import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { StatsData } from '@/types';

export interface MovimentoFechado {
  stats: StatsData;
  /** "01/08/2026 a 07/08/2026" — nulo quando as linhas não declaram período. */
  periodo: string | null;
  /** ISO do instante do fechamento. */
  fechadoEm: string;
}

export function FechamentoRecibo({
  movimento,
  onDispensar,
}: {
  movimento: MovimentoFechado;
  onDispensar: () => void;
}) {
  const { stats, periodo } = movimento;
  // Mesma conta do recibo de disparo: o que não foi enviado nem falhou.
  const semEnvio = Math.max(0, stats.total - stats.msgEnviada - stats.msgErro);

  return (
    <div
      role="status"
      aria-live="off"
      className="flex flex-wrap items-start gap-x-4 gap-y-2 rounded-lg border border-success/30 bg-success/5 p-3"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">
          Movimento fechado
          {periodo ? <span className="font-normal text-muted-foreground"> · {periodo}</span> : null}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          <strong className="font-semibold text-foreground">{stats.total}</strong> linha
          {stats.total === 1 ? '' : 's'}
          {' · '}
          <strong className="font-semibold text-foreground">{stats.msgEnviada}</strong> com mensagem
          enviada
          {' · '}
          <strong className="font-semibold text-foreground">{stats.msgErro}</strong> com erro
          {' · '}
          <strong className="font-semibold text-foreground">{semEnvio}</strong> sem envio
        </p>
        {/* O que a pessoa precisa saber para agir: as linhas não voltam. Dizer
            isso aqui evita que ela procure na tela o que já não existe. */}
        <p className="mt-1 text-xs text-muted-foreground">
          As linhas saíram desta tela. A próxima importação começa um movimento novo.
        </p>
      </div>

      <Button
        size="sm"
        variant="ghost"
        onClick={onDispensar}
        className="h-11 w-11 shrink-0 md:h-8 md:w-8"
        aria-label="Dispensar o recibo do fechamento"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}
