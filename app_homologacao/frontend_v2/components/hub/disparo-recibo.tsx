'use client';

// impeccable rodada 6 (P1-2, 3º item) — recibo do disparo em massa.
//
// O fim do ciclo de pagamento da semana — a ação de maior consequência do
// produto — era um toast de 4 segundos ("Processamento iniciado!") e, no fim,
// nada: a pílula voltava para "Parado" e o operador tinha que ler os cards
// para adivinhar se deu certo. Pela regra do pico-fim, o fim do fluxo é o que
// fica na memória de quem usa; aqui ele não existia.
//
// Este recibo aparece na transição `isActive: true → false` e FICA na tela
// até ser dispensado (ou até o próximo disparo começar) — não é toast, não
// tem timer.
//
// Os números vêm do `stats` VIVO da tela, não de um snapshot congelado na
// hora da transição: o refetch que fecha o disparo é assíncrono, então um
// snapshot tirado no instante da virada mostraria o penúltimo poll. Como o
// recibo é dispensável e diz "resultado do último disparo", exibir o estado
// atual do movimento é ao mesmo tempo mais simples e mais correto.

import { CheckCircle2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { StatsData } from '@/types';

interface DisparoReciboProps {
  stats: StatsData;
  /** Aplica o filtro "com erro" na tabela. Só é chamado quando há erros. */
  onVerErros: () => void;
  onDispensar: () => void;
}

/**
 * Pendentes = tudo que não foi nem enviado nem falhou. Não existe no
 * `StatsData` (que só conta `enviado === 'ok'` e `enviado === 'erro'`) —
 * o resto é `'off'`/vazio, ou seja, linha que o disparo não alcançou.
 * Clamp em 0: `stats` é derivado de uma lista só, mas um total menor que a
 * soma nunca deve virar "-3 sem envio" na tela.
 */
export function calcularPendentes(stats: StatsData): number {
  return Math.max(0, stats.total - stats.msgEnviada - stats.msgErro);
}

export function DisparoRecibo({ stats, onVerErros, onDispensar }: DisparoReciboProps) {
  const pendentes = calcularPendentes(stats);
  const temErro = stats.msgErro > 0;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-start gap-x-4 gap-y-2 rounded-lg border bg-card p-3"
    >
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-success/10"
        aria-hidden="true"
      >
        <CheckCircle2 className="h-4 w-4 text-success" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">Disparo concluído</p>
        {/* Números em text-foreground e rótulos em muted: o contraste do par
            número+rótulo não depende de nenhuma cor semântica (a rodada 5
            achou 1,54:1 justamente em texto colorido sobre superfície clara). */}
        <p className="mt-0.5 text-sm text-muted-foreground">
          <strong className="font-semibold text-foreground">{stats.msgEnviada}</strong> enviada
          {stats.msgEnviada === 1 ? '' : 's'}
          {' · '}
          <strong className="font-semibold text-foreground">{stats.msgErro}</strong> com erro
          {' · '}
          <strong className="font-semibold text-foreground">{pendentes}</strong> sem envio
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {temErro && (
          <Button size="sm" variant="outline" onClick={onVerErros}>
            Ver {stats.msgErro === 1 ? 'a linha' : `as ${stats.msgErro} linhas`} com erro
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={onDispensar}
          // Alvo de 44px no mobile (mesma convenção dos filtros): botão só de
          // ícone no `size="sm"` fica em 32px, abaixo do mínimo de toque.
          className="h-11 w-11 md:h-8 md:w-8"
          aria-label="Dispensar o recibo do disparo"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
