'use client';

// impeccable rodada 3 — filtro de período único do hub (auditoria,
// importações, performance, faturamento). Ataca três achados do critique #2
// de uma vez:
//   h7 (2/4) "datas à mão sem presets" → chips Hoje/7 dias/30 dias/Este mês;
//   h2 (2/4) "datas mm/dd/yyyy em browser EN" → o formato do `<input
//     type="date">` é do browser e NÃO é controlável por HTML/CSS; o que dá
//     para fazer é (a) deixar o caminho comum sem digitação e (b) ecoar o
//     intervalo resolvido em pt-BR abaixo dos campos, que é o que este
//     componente faz;
//   h5 (3/4) "filtros sem validação" → intervalo invertido é dito na hora.
//
// O estado continua sendo só `de`/`ate` no chamador — nenhum preset é
// persistido. Qual chip acende é DERIVADO do par via `presetAtivo`.

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  PERIODO_PRESETS,
  formatarISOparaBR,
  intervaloDoPreset,
  presetAtivo,
  type Intervalo,
  type PeriodoPreset,
} from '@/lib/hub/periodo';

export interface PeriodFilterProps {
  /** Prefixo dos `id`/`htmlFor` — único por página (ex.: `auditoria-filtro`). */
  idPrefix: string;
  de: string;
  ate: string;
  /** Recebe SEMPRE o par completo: um preset move as duas pontas juntas. */
  onChange: (intervalo: Intervalo) => void;
  rotuloDe?: string;
  rotuloAte?: string;
  /** Descreve a qual data o intervalo se aplica (ex.: "de competência").
   * Vira o texto de apoio dos chips, para o operador não confundir a base. */
  legenda?: string;
  /** Janela que o BACKEND aplica quando nenhum período é informado (em dias).
   *  Omitida: a rota realmente devolve tudo. Ver o comentário do eco abaixo —
   *  afirmar "todo o período" onde a API corta é mentir para quem confere. */
  janelaPadraoDias?: number;
  className?: string;
}

export function PeriodFilter({
  idPrefix,
  de,
  ate,
  onChange,
  rotuloDe = 'De',
  rotuloAte = 'Até',
  legenda,
  janelaPadraoDias,
  className,
}: PeriodFilterProps) {
  // Último chip clicado — usado SÓ para desempatar quando dois presets geram o
  // mesmo intervalo (dia 7: "7 dias" == "Este mês"). Não é o estado do filtro:
  // se o intervalo deixar de casar, `presetAtivo` ignora este valor.
  const [ultimoClicado, setUltimoClicado] = useState<PeriodoPreset | null>(null);
  const ativo = presetAtivo(de, ate, new Date(), ultimoClicado);
  const deBR = formatarISOparaBR(de);
  const ateBR = formatarISOparaBR(ate);
  // Comparação lexicográfica funciona porque `YYYY-MM-DD` ordena como texto.
  const invertido = Boolean(de && ate && de > ate);

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">
          Período{legenda ? ` ${legenda}` : ''}:
        </span>
        {PERIODO_PRESETS.map((p) => {
          const selecionado = ativo === p.id;
          return (
            <button
              key={p.id}
              type="button"
              // aria-pressed em vez de radio: os chips são um atalho para os
              // dois campos abaixo, não um campo próprio — o valor real do
              // filtro continua sendo `de`/`ate`.
              aria-pressed={selecionado}
              title={p.descricao}
              onClick={() => {
                setUltimoClicado(p.id);
                onChange(intervaloDoPreset(p.id));
              }}
              className={cn(
                'min-h-11 rounded-full border px-2.5 text-xs font-medium transition-colors sm:min-h-8', // r9 (P2): 32px medidos a 390px nos 4 chips de período
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                selecionado
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-muted-foreground hover:border-primary/40 hover:bg-muted hover:text-foreground',
              )}
            >
              {p.rotulo}
            </button>
          );
        })}
        {(de || ate) && (
          <button
            type="button"
            onClick={() => {
              setUltimoClicado(null);
              onChange({ de: '', ate: '' });
            }}
            className="min-h-11 rounded-full px-2 text-xs text-muted-foreground sm:min-h-8 underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Todo o período
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 xs:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${idPrefix}-de`} className="text-xs text-muted-foreground">
            {rotuloDe}
          </label>
          <Input
            id={`${idPrefix}-de`}
            type="date"
            value={de}
            max={ate || undefined}
            onChange={(e) => onChange({ de: e.target.value, ate })}
            className="h-11 sm:h-9"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${idPrefix}-ate`} className="text-xs text-muted-foreground">
            {rotuloAte}
          </label>
          <Input
            id={`${idPrefix}-ate`}
            type="date"
            value={ate}
            min={de || undefined}
            onChange={(e) => onChange({ de, ate: e.target.value })}
            className="h-11 sm:h-9"
          />
        </div>
      </div>

      {/* O `<input type="date">` mostra a data no formato do BROWSER (mm/dd em
          locale EN). Este eco em pt-BR é a única forma honesta de garantir que
          o operador leia o intervalo no formato do país. */}
      {invertido ? (
        <p role="alert" className="text-xs text-destructive">
          A data inicial ({deBR}) é posterior à final ({ateBR}) — inverta as duas para ver resultados.
        </p>
      ) : deBR && ateBR ? (
        <p className="text-xs text-muted-foreground">
          Exibindo de <strong className="font-medium text-foreground">{deBR}</strong> a{' '}
          <strong className="font-medium text-foreground">{ateBR}</strong>.
        </p>
      ) : deBR ? (
        <p className="text-xs text-muted-foreground">
          Exibindo a partir de <strong className="font-medium text-foreground">{deBR}</strong>.
        </p>
      ) : ateBR ? (
        <p className="text-xs text-muted-foreground">
          Exibindo até <strong className="font-medium text-foreground">{ateBR}</strong>.
        </p>
      ) : janelaPadraoDias ? (
        // impeccable r23 — MENTIRA CORRIGIDA. Sem `de`/`ate`, o backend NÃO
        // devolve tudo: aplica `JANELA_PADRAO_DIAS = 30`
        // (lib/hub-faturamento-dto.js, idem performance). A tela dizia
        // "Exibindo todo o período disponível" e mostrava 30 dias — pego na
        // verificação em tela: a base de QA tem R$ 21.159,34 em 220
        // lançamentos e o total aparecia como R$ 0,00, porque nada caía nos
        // últimos 30 dias. Numa tela usada para conferir antes de pagar,
        // acreditar que se está vendo tudo é o pior defeito possível.
        <p className="text-xs text-muted-foreground">
          Exibindo os últimos{' '}
          <strong className="font-medium text-foreground">{janelaPadraoDias} dias</strong> — informe
          um período para ver além disso.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Exibindo todo o período disponível.</p>
      )}
    </div>
  );
}
