'use client';

// hub-motorista-canonico FASE 2 / WS-B (tasks.md 2.3) — combobox
// compartilhado de busca de entregador por nome, consumido pelas telas de
// faturamento e performance no lugar do input numérico de `entregador_id`.
//
// Idioma Popover+Command de `EntidadeCombobox`
// (app/hub/dashboard/admin/page.tsx) — Button trigger via `render` prop,
// Command controlado por `onInputValueChange`. Debounce 300ms antes de
// chamar `buscar` (injetada pelo caller: `buscarEntregadoresFaturamento`
// ou `buscarEntregadoresPerformance` — o componente NÃO conhece o
// endpoint concreto, mantém-se 100% compartilhado entre as 2 telas).
//
// Estados (tasks.md 2.3.2): digitando <3 caracteres, carregando, vazio,
// erro. Degradação para o input numérico (FR-010, D-B1) é responsabilidade
// do CALLER — este componente só avisa via `onIndisponivel` quando uma
// busca falha (rede/5xx); o caller decide trocar de componente.
//
// Ref: docs/specs/hub-motorista-canonico/contracts/api-motorista-canonico.md
// §WS-B, research.md Decision 3, quickstart.md Scenario 3-4.

import { useEffect, useId, useRef, useState } from 'react';
import { CheckIcon, ChevronsUpDown, Loader2, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';
import type { EntregadorBuscaItem } from '@/lib/hub/entregador-busca-dto';

const DEBOUNCE_MS = 300;
const MIN_CHARS = 3;

export interface EntregadorComboboxProps {
  /** id do trigger (associação com `<label htmlFor>` externo). */
  id?: string;
  /** `entregadorId` selecionado — `null` = nenhum filtro aplicado. */
  value: number | null;
  /** Nome exibido no trigger quando `value` não é `null` — controlado pelo
   * caller (evita o combobox precisar resolver id->nome sozinho quando o
   * valor é definido externamente, ex.: `resetFiltros`). */
  nomeSelecionado: string | null;
  /** Chamado ao selecionar (`id`, `nome`) ou ao limpar (`null`, `null`). */
  onSelecionar: (id: number | null, nome: string | null) => void;
  /** Função de busca injetada pelo caller — `buscarEntregadoresFaturamento`
   * ou `buscarEntregadoresPerformance` (mesmo shape, endpoints espelhados). */
  buscar: (termo: string) => Promise<EntregadorBuscaItem[]>;
  /** Chamado quando uma busca falha (rede/5xx) — o caller decide degradar
   * para o input numérico (FR-010, D-B1). Não é chamado para o caso
   * "menos de 3 caracteres" (não é erro, é apenas incompleto). */
  onIndisponivel?: () => void;
  /** Desabilita o combobox (ex.: mutuamente exclusivo com "sem entregador
   * vinculado" — FR-009). */
  disabled?: boolean;
  'aria-label'?: string;
  className?: string;
}

function EntregadorCombobox({
  id,
  value,
  nomeSelecionado,
  onSelecionar,
  buscar,
  onIndisponivel,
  disabled = false,
  'aria-label': ariaLabel = 'Buscar entregador por nome',
  className,
}: EntregadorComboboxProps) {
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState('');
  const [resultados, setResultados] = useState<EntregadorBuscaItem[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const liveRegionId = useId();
  // Guarda a última requisição disparada — descarta respostas fora de ordem
  // (usuário digitou mais rápido que o round-trip da anterior).
  const requestSeqRef = useRef(0);

  const termoLimpo = busca.trim();
  const termoValido = termoLimpo.length >= MIN_CHARS;

  // Atualização SÍNCRONA do estado "digitando" vive no EVENT HANDLER
  // (`aoDigitar`, chamado por `onInputValueChange` do Command a cada
  // keystroke), não dentro do `useEffect` abaixo — react-hooks/
  // set-state-in-effect (React Compiler) proíbe `setState` síncrono direto
  // no corpo de um efeito; o padrão correto é: handler de evento decide o
  // estado IMEDIATO (carregando/limpo), efeito só dispara o SIDE EFFECT
  // assíncrono (debounce + fetch) e chama `setState` de dentro do
  // callback do timer/promise (permitido pela regra).
  function aoDigitar(q: string) {
    setBusca(q);
    if (q.trim().length < MIN_CHARS) {
      setResultados([]);
      setErro(null);
      setCarregando(false);
    } else {
      setCarregando(true);
      setErro(null);
    }
  }

  // `buscar`/`onIndisponivel` deliberadamente FORA do array de deps abaixo
  // (eslint-disable-line na linha do array): são funções estáveis
  // (definidas no módulo de API, não recriadas por render do caller nesta
  // tela) — incluí-las quebraria o debounce a cada re-render.
  useEffect(() => {
    if (!termoValido) return undefined;

    const meuSeq = ++requestSeqRef.current;
    const timer = setTimeout(() => {
      buscar(termoLimpo)
        .then((items) => {
          if (requestSeqRef.current !== meuSeq) return; // resposta obsoleta
          setResultados(items);
          setCarregando(false);
        })
        .catch(() => {
          if (requestSeqRef.current !== meuSeq) return;
          setResultados([]);
          setCarregando(false);
          setErro('Não foi possível buscar entregadores. Tente novamente.');
          onIndisponivel?.();
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [termoLimpo, termoValido]); // eslint-disable-line react-hooks/exhaustive-deps

  function selecionar(item: EntregadorBuscaItem) {
    onSelecionar(item.id, item.nome);
    setAberto(false);
    setBusca('');
  }

  function limpar(e: React.MouseEvent) {
    e.stopPropagation();
    onSelecionar(null, null);
    setBusca('');
  }

  function aoAbrirFechar(next: boolean) {
    setAberto(next);
    if (!next) setBusca('');
  }

  const label = value !== null ? (nomeSelecionado ?? `#${value}`) : 'Buscar entregador...';

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Popover open={aberto} onOpenChange={aoAbrirFechar}>
        <PopoverTrigger
          render={
            <Button
              id={id}
              variant="outline"
              size="sm"
              role="combobox"
              aria-expanded={aberto}
              aria-label={ariaLabel}
              disabled={disabled}
              className="min-h-11 w-full justify-between gap-1.5 sm:min-h-9"
            />
          }
        >
          <span className="flex items-center gap-1.5 truncate">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{label}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {value !== null && !disabled && (
              <button
                type="button"
                aria-label="Limpar filtro de entregador"
                onClick={limpar}
                className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            )}
            <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" aria-hidden="true" />
          </span>
        </PopoverTrigger>

        <PopoverContent className="w-[280px] p-0" align="start">
          <Command onInputValueChange={aoDigitar}>
            <CommandInput placeholder="Digite ao menos 3 letras do nome..." aria-label={ariaLabel} />
            <CommandList>
              {!termoValido && (
                <CommandEmpty>
                  {termoLimpo.length === 0
                    ? 'Digite ao menos 3 caracteres para buscar.'
                    : `Faltam ${MIN_CHARS - termoLimpo.length} caractere(s) para buscar.`}
                </CommandEmpty>
              )}
              {termoValido && carregando && (
                <div role="status" className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                  <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
                  Buscando...
                </div>
              )}
              {termoValido && !carregando && erro && (
                <p role="alert" className="px-3 py-3 text-sm text-destructive">
                  {erro}
                </p>
              )}
              {termoValido && !carregando && !erro && resultados.length === 0 && (
                <CommandEmpty>Nenhum entregador encontrado.</CommandEmpty>
              )}
              {termoValido && !carregando && !erro && resultados.length > 0 && resultados.map((item) => (
                <CommandItem
                  key={item.id}
                  value={`entregador-${item.id}`}
                  aria-selected={value === item.id}
                  onClick={() => selecionar(item)}
                  className={cn('cursor-pointer', value === item.id && 'bg-accent/20 font-semibold')}
                >
                  <CheckIcon
                    className={cn('mr-2 size-4 shrink-0 text-primary', value === item.id ? 'opacity-100' : 'opacity-0')}
                    aria-hidden="true"
                  />
                  {item.nome}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <span id={liveRegionId} aria-live="polite" aria-atomic="true" className="sr-only">
        {carregando ? 'Buscando entregadores...' : ''}
      </span>
    </div>
  );
}

export { EntregadorCombobox };
export default EntregadorCombobox;
