'use client';

// Seletor de categorias do faturamento (busca, famílias, "Marcar visíveis").
// Extraído das Configurações do adiantamento para ser o MESMO componente nas
// campanhas "Melhor extrato" (PLANO-MELHOR-EXTRATO §7, deduplicação).

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CategoriaProducao } from '@/lib/hub/adiantamentos-api';
import {
  casaCategoria,
  dataLocalSP,
  filtrarItensCategoria,
  montarItensCategoria,
  semTokenModo,
  TOKEN_MODO_TODAS,
  trocarModo,
  type ItemCategoria,
  type ModoCategorias,
} from '@/lib/hub/adiantamento-categorias';
import { cn } from '@/lib/utils';

export function Chip({ ativo, onClick, disabled, excecao, children }: { ativo: boolean; onClick: () => void; disabled?: boolean; excecao?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={ativo}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'min-h-9 rounded-full border px-3 py-1 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
        ativo
          ? excecao ? 'border-destructive bg-destructive/10 text-destructive' : 'border-primary bg-primary/10 text-primary'
          : 'border-input text-muted-foreground hover:bg-muted'
      )}
    >
      {children}
    </button>
  );
}

export function toggleItem<T>(lista: T[], item: T): T[] {
  return lista.includes(item) ? lista.filter((x) => x !== item) : [...lista, item];
}

const numero = new Intl.NumberFormat('pt-BR');

function detalheCategoria(i: ItemCategoria): string {
  if (i.ausente === 'sem_lancamentos') return 'sem lançamentos em 90 dias';
  if (i.ausente === 'dentro_de_familia') return `já incluída em ${i.rotuloFamilia}`;
  const qtd = numero.format(i.lancamentos);
  if (i.ausente === 'fora_da_familia') return `${qtd} · faz parte de ${i.rotuloFamilia}`;
  if (i.familia) return `${i.membros} ${i.membros === 1 ? 'campanha' : 'campanhas'} · ${qtd}`;
  return i.semMotoristaIdentificado ? `${qtd} · parte sem motorista` : qtd;
}

// Só aparecem categorias com ao menos um lançamento COM motorista (0087), e
// as famílias (Promoção, Missões) vêm dobradas num item só — marcar a família
// inclui também as campanhas que surgirem depois.
const AJUDA_MODO: Record<ModoCategorias, string> = {
  todas: 'Categorias novas do relatório entram sozinhas. Marque só o que não é dinheiro do entregador.',
  marcadas: 'Só as categorias marcadas entram. Uma categoria nova fica de fora até alguém marcar.',
};
const MAX_NOMES_AVISO = 8;

export function SeletorCategorias({ titulo, textoVazio, disponiveis, selecionadas: selecionadasBrutas, onChange, aviso, modo, revisadoEm, destino = 'da antecipação' }: {
  titulo: string;
  textoVazio: string;
  disponiveis: CategoriaProducao[];
  selecionadas: string[];
  onChange: (categorias: string[]) => void;
  /** Mostrado quando nada está selecionado — o silêncio do repasse zerado
   *  custou meses sem ninguém perceber (F1, briefing repasse-nota-producao). */
  aviso?: string;
  /** Liga o "Como contar". O modo vive na própria lista (token `modo:todas`);
   *  `valor` deve ser `modoDaLista(selecionadas)`. Sem esta prop, o componente
   *  é o de sempre (a campanha não passa). */
  modo?: { valor: ModoCategorias; onChange?: (m: ModoCategorias) => void };
  /** Data (YYYY-MM-DD…) da última revisão = `vigenteDesde` da versão vigente. */
  revisadoEm?: string;
  /** Para onde a lista aponta, já com artigo ("da antecipação", "do repasse", "da nota"). */
  destino?: string;
}) {
  const [busca, setBusca] = useState('');
  const nomeRadio = useId();
  const todas = modo?.valor === 'todas';
  // O token de modo nunca vira chip nem entra na contagem de marcadas.
  const selecionadas = modo ? semTokenModo(selecionadasBrutas) : selecionadasBrutas;
  const emit = (marcadas: string[]) => onChange(todas ? [TOKEN_MODO_TODAS, ...marcadas] : marcadas);
  const itens = montarItensCategoria(disponiveis, selecionadas);
  const visiveis = filtrarItensCategoria(itens, busca);
  const familias = itens.filter((i) => i.familia && !i.ausente).map((i) => i.rotulo);
  const marcarVisiveis = (marcado: boolean) => {
    const chaves = visiveis.map((i) => i.chave);
    emit(marcado ? [...new Set([...selecionadas, ...chaves])] : selecionadas.filter((s) => !chaves.includes(s)));
  };
  const entram = modo ? disponiveis.filter((c) => casaCategoria(c.descricao, c.familia, selecionadasBrutas)).length : 0;
  const corte = revisadoEm ? dataLocalSP(revisadoEm) : undefined;
  const novas = modo && corte ? disponiveis.filter((c) => c.primeira && c.primeira > corte) : [];
  const novasAviso = novas.filter((c) => casaCategoria(c.descricao, c.familia, selecionadasBrutas) === todas);
  const nomesNovas = novasAviso.slice(0, MAX_NOMES_AVISO).map((c) => c.descricao).join(', ')
    + (novasAviso.length > MAX_NOMES_AVISO ? ` e mais ${novasAviso.length - MAX_NOMES_AVISO}` : '');
  const qtdNovas = `${novasAviso.length} ${novasAviso.length === 1 ? 'categoria nova' : 'categorias novas'}`;
  const desde = corte ? `${corte.slice(8, 10)}/${corte.slice(5, 7)}` : '';
  const trocar = (m: ModoCategorias) => {
    if (m === modo?.valor) return;
    onChange(trocarModo(m, disponiveis));
    modo?.onChange?.(m);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-sm font-medium">{titulo}</span>
        {itens.length > 0 && !modo && (
          <span className="text-xs text-muted-foreground tabular-nums">{selecionadas.length} de {itens.length} selecionadas</span>
        )}
        {itens.length > 0 && modo && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {todas
              ? `${selecionadas.length} ${selecionadas.length === 1 ? 'exceção' : 'exceções'} · ${entram} de ${disponiveis.length} categorias entram`
              : `${selecionadas.length} de ${itens.length} selecionadas`}
          </span>
        )}
      </div>
      {modo && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-xs text-muted-foreground">Como contar</legend>
          <div className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap">
            {([['marcadas', 'Só as marcadas'], ['todas', 'Todas, exceto as marcadas']] as const).map(([v, rotulo]) => (
              <label key={v} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 sm:min-h-9">
                <input type="radio" name={nomeRadio} checked={modo.valor === v} onChange={() => trocar(v)} />
                {rotulo}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{AJUDA_MODO[modo.valor]} Trocar o modo limpa as marcações, porque elas mudam de sentido.</p>
        </fieldset>
      )}
      {novasAviso.length > 0 && (
        <p
          role="status"
          className={cn(
            'rounded-lg border px-3 py-2 text-xs',
            todas ? 'border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200' : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
          )}
        >
          {todas
            ? `${qtdNovas} desde a última revisão (${desde}) — já estão entrando: ${nomesNovas}. Se alguma não for dinheiro do entregador, marque como exceção. Salvar as configurações marca a revisão.`
            : `${qtdNovas} desde a última revisão (${desde}) estão FORA ${destino}: ${nomesNovas}. Marque-as, ou troque para “Todas, exceto as marcadas” para que as próximas entrem sozinhas.`}
        </p>
      )}
      {itens.length === 0 ? (
        <p className="text-xs text-muted-foreground">{textoVazio}</p>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              type="search"
              aria-label="Buscar categoria"
              placeholder="Buscar categoria"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              className="sm:max-w-xs"
            />
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={visiveis.length === 0} onClick={() => marcarVisiveis(true)}>
                Marcar visíveis
              </Button>
              <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={visiveis.length === 0} onClick={() => marcarVisiveis(false)}>
                Desmarcar visíveis
              </Button>
            </div>
          </div>
          {visiveis.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nenhuma categoria encontrada para “{busca.trim()}”.</p>
          ) : (
            <div role="group" aria-label={titulo} className="flex flex-wrap gap-1.5">
              {visiveis.map((i) => (
                <Chip key={i.chave} ativo={selecionadas.includes(i.chave)} excecao={todas} onClick={() => emit(toggleItem(selecionadas, i.chave))}>
                  {i.rotulo}
                  <span className="ml-1.5 text-xs font-normal opacity-75 tabular-nums">
                    {detalheCategoria(i)}{todas && selecionadas.includes(i.chave) ? ' · fora' : ''}
                  </span>
                </Chip>
              ))}
            </div>
          )}
          {aviso && !todas && selecionadas.length === 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-500">{aviso}</p>
          )}
          {familias.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {familias.join(' e ')} {familias.length === 1 ? 'inclui' : 'incluem'} também as campanhas que surgirem depois.
            </p>
          )}
        </>
      )}
    </div>
  );
}
