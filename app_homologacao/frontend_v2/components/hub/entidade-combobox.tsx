'use client';

// impeccable rodada 3 — combobox de entidade, extraído de
// `app/hub/dashboard/admin/page.tsx` (onde nasceu privado na uiux-hub F3) para
// atacar o h6 "Reconhecimento > memória" (2/4 no critique #2: "admin exige
// digitar ID da entidade; auditoria pede IDs de memória").
//
// Três fontes de reconhecimento, nesta ordem de preferência:
//   1. as entidades do próprio usuário (`GET /me` → `entidades[]`), que desde
//      a rodada 2 já vêm COM NOME — antes desta extração ninguém as usava
//      como fonte de escolha, só o EntitySwitcher;
//   2. o histórico local das últimas consultadas (localStorage), que cobre o
//      admin_plataforma alcançando entidades fora do próprio vínculo;
//   3. digitação livre do ID numérico, que continua aceita e é o único
//      caminho para uma entidade nunca vista.

import { useState } from 'react';
import { Building2, ChevronsUpDown, History, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { cn } from '@/lib/utils';

const HISTORICO_KEY = 'hub_admin_entidades_recentes';
const HISTORICO_MAX = 8;

/** Histórico local (localStorage) de IDs consultados — fail-safe: qualquer
 * erro de storage (modo privado, quota) degrada para lista vazia. */
export function lerHistorico(): number[] {
  try {
    const bruto = window.localStorage.getItem(HISTORICO_KEY);
    if (!bruto) return [];
    const lista = JSON.parse(bruto);
    return Array.isArray(lista) ? lista.filter((n) => Number.isInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}

export function gravarHistorico(id: number): number[] {
  const novo = [id, ...lerHistorico().filter((n) => n !== id)].slice(0, HISTORICO_MAX);
  try {
    window.localStorage.setItem(HISTORICO_KEY, JSON.stringify(novo));
  } catch {
    // storage indisponível — histórico só desta sessão de página
  }
  return novo;
}

/** Rótulo de uma entidade: nome quando conhecido, ID sempre visível — o
 * operador confere o número e o suporte consegue referenciá-lo. */
export function rotuloEntidade(id: number, nome?: string | null): string {
  return nome ? `${nome} (#${id})` : `Entidade #${id}`;
}

export interface EntidadeComboboxProps {
  entidadeId: number | null;
  /** Nome resolvido pelo chamador (ex.: o backend devolveu junto do recurso).
   * Quando ausente, o componente ainda tenta resolver pelas entidades do `/me`. */
  entidadeNome?: string | null;
  onSelecionar: (id: number | null) => void;
  /** Habilita a opção "Todas as entidades" (`null`) — usada por filtros de
   * lista, onde ausência de filtro é um valor legítimo. */
  permitirTodas?: boolean;
  rotuloTodas?: string;
  /** Texto do gatilho quando nada está selecionado e `permitirTodas` é falso. */
  placeholder?: string;
  'aria-labelledby'?: string;
  className?: string;
}

export function EntidadeCombobox({
  entidadeId,
  entidadeNome,
  onSelecionar,
  permitirTodas = false,
  rotuloTodas = 'Todas as entidades',
  placeholder = 'Selecionar entidade...',
  className,
  ...aria
}: EntidadeComboboxProps) {
  const { entidades } = useHubAuth();
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState('');
  const [historico, setHistorico] = useState<number[]>([]);

  // Carrega o histórico ao ABRIR (evento, não efeito): localStorage só existe
  // no cliente e assim a lista vem sempre fresca a cada abertura.
  const aoAbrirFechar = (v: boolean) => {
    setAberto(v);
    if (v) setHistorico(lerHistorico());
  };

  const termo = busca.trim();
  const buscaNumerica = /^\d+$/.test(termo) ? Number(termo) : null;
  const termoNormalizado = termo.toLowerCase();

  // As entidades do usuário casam por NOME ou por ID — é o ganho real sobre a
  // versão anterior, que só sabia comparar dígitos.
  const minhas = entidades.filter(
    (e) =>
      !termo ||
      String(e.empresaId).includes(termo) ||
      (e.nome ?? '').toLowerCase().includes(termoNormalizado),
  );
  const idsProprios = new Set(entidades.map((e) => e.empresaId));
  const recentes = historico.filter(
    (id) => !idsProprios.has(id) && (!termo || String(id).includes(termo)),
  );
  // Só oferece "consultar #N" quando o ID digitado não está em nenhuma lista.
  const mostrarConsultaDireta =
    buscaNumerica !== null && !idsProprios.has(buscaNumerica) && !recentes.includes(buscaNumerica);

  const selecionar = (id: number | null) => {
    if (id !== null) setHistorico(gravarHistorico(id));
    onSelecionar(id);
    setAberto(false);
    setBusca('');
  };

  const nomeExibido = entidadeNome ?? entidades.find((e) => e.empresaId === entidadeId)?.nome ?? null;

  return (
    <Popover open={aberto} onOpenChange={aoAbrirFechar}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={aberto}
            aria-label={aria['aria-labelledby'] ? undefined : 'Selecionar entidade'}
            aria-labelledby={aria['aria-labelledby']}
            className={cn('min-h-11 w-full justify-between gap-1.5 sm:min-h-9 sm:w-[240px]', className)}
          />
        }
      >
        <span className="flex items-center gap-1.5 truncate">
          <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {entidadeId !== null
            ? rotuloEntidade(entidadeId, nomeExibido)
            : permitirTodas
              ? rotuloTodas
              : placeholder}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <Command onInputValueChange={(q: string) => setBusca(q)}>
          <CommandInput placeholder="Busque por nome ou ID..." aria-label="Buscar entidade por nome ou ID" />
          <CommandList>
            {minhas.length === 0 && recentes.length === 0 && !mostrarConsultaDireta && (
              <CommandEmpty>
                {termo
                  ? 'Nenhuma entidade com esse nome. Digite o ID numérico para consultar outra.'
                  : 'Digite o nome ou o ID de uma entidade.'}
              </CommandEmpty>
            )}

            {permitirTodas && !termo && (
              <CommandItem value="todas" onClick={() => selecionar(null)} className="cursor-pointer">
                <X className="mr-2 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                {rotuloTodas}
              </CommandItem>
            )}

            {minhas.map((e) => (
              <CommandItem
                key={`propria-${e.empresaId}`}
                value={`propria-${e.empresaId}`}
                onClick={() => selecionar(e.empresaId)}
                className="cursor-pointer"
              >
                <Building2 className="mr-2 size-4 shrink-0 text-primary" aria-hidden="true" />
                <span className="truncate">{rotuloEntidade(e.empresaId, e.nome)}</span>
                {e.empresaId === entidadeId && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">atual</span>
                )}
              </CommandItem>
            ))}

            {mostrarConsultaDireta && (
              <CommandItem
                value={`consultar-${buscaNumerica}`}
                onClick={() => selecionar(buscaNumerica)}
                className="cursor-pointer"
              >
                <Search className="mr-2 size-4 shrink-0 text-primary" aria-hidden="true" />
                Consultar entidade #{buscaNumerica}
              </CommandItem>
            )}

            {recentes.map((id) => (
              <CommandItem
                key={`recente-${id}`}
                value={`recente-${id}`}
                onClick={() => selecionar(id)}
                className="cursor-pointer"
              >
                <History className="mr-2 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                Entidade #{id}
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">recente</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
