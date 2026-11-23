'use client';

// Seletor de categorias do faturamento (busca, famílias, "Marcar visíveis").
// Extraído das Configurações do adiantamento para ser o MESMO componente nas
// campanhas "Melhor extrato" (PLANO-MELHOR-EXTRATO §7, deduplicação).

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { CategoriaProducao } from '@/lib/hub/adiantamentos-api';
import { filtrarItensCategoria, montarItensCategoria, type ItemCategoria } from '@/lib/hub/adiantamento-categorias';

export function Chip({ ativo, onClick, disabled, children }: { ativo: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={ativo}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'min-h-9 rounded-full border px-3 py-1 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
        ativo ? 'border-primary bg-primary/10 text-primary' : 'border-input text-muted-foreground hover:bg-muted'
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
export function SeletorCategorias({ titulo, textoVazio, disponiveis, selecionadas, onChange, aviso }: {
  titulo: string;
  textoVazio: string;
  disponiveis: CategoriaProducao[];
  selecionadas: string[];
  onChange: (categorias: string[]) => void;
  /** Mostrado quando nada está selecionado — o silêncio do repasse zerado
   *  custou meses sem ninguém perceber (F1, briefing repasse-nota-producao). */
  aviso?: string;
}) {
  const [busca, setBusca] = useState('');
  const itens = montarItensCategoria(disponiveis, selecionadas);
  const visiveis = filtrarItensCategoria(itens, busca);
  const familias = itens.filter((i) => i.familia && !i.ausente).map((i) => i.rotulo);
  const marcarVisiveis = (marcado: boolean) => {
    const chaves = visiveis.map((i) => i.chave);
    onChange(marcado ? [...new Set([...selecionadas, ...chaves])] : selecionadas.filter((s) => !chaves.includes(s)));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-sm font-medium">{titulo}</span>
        {itens.length > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">{selecionadas.length} de {itens.length} selecionadas</span>
        )}
      </div>
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
                <Chip key={i.chave} ativo={selecionadas.includes(i.chave)} onClick={() => onChange(toggleItem(selecionadas, i.chave))}>
                  {i.rotulo}
                  <span className="ml-1.5 text-xs font-normal opacity-75 tabular-nums">{detalheCategoria(i)}</span>
                </Chip>
              ))}
            </div>
          )}
          {aviso && selecionadas.length === 0 && (
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
