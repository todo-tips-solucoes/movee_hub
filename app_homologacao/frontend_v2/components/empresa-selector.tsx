'use client';

import { useState, useEffect, useRef, useId } from 'react';
import { CheckIcon, ChevronsUpDownIcon, Loader2 } from 'lucide-react';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api-client';

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface Empresa {
  id: number;
  nome_empresa: string;
}

interface GrupoEscopoResponse {
  empresas: Empresa[];
  default: number;
}

export interface EmpresaSelectorProps {
  /** ID da empresa selecionada. null = ainda não escolhido (usará default do endpoint). */
  value: number | null;
  /** Chamado quando o usuário seleciona uma empresa. Recebe o id numérico. */
  onChange: (id: number) => void;
  /** Classe CSS adicional no botão trigger. */
  className?: string;
  /** Desabilita o seletor externamente (ex.: durante carregamento de dados). */
  disabled?: boolean;
}

// ─── Hook de fetch ─────────────────────────────────────────────────────────────

export function useGrupoEscopo() {
  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [defaultId, setDefaultId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .get<GrupoEscopoResponse>('/grupo/escopo')
      .then((data) => {
        if (cancelled) return;
        setEmpresas(data.empresas);
        setDefaultId(data.default);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : 'Erro ao carregar filiais.',
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { empresas, defaultId, loading, error };
}

// ─── Componente principal ─────────────────────────────────────────────────────

function EmpresaSelector({
  value,
  onChange,
  className,
  disabled = false,
}: EmpresaSelectorProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const { empresas, defaultId, loading, error } = useGrupoEscopo();
  const liveRegionId = useId();
  const prevValueRef = useRef<number | null>(null);
  const [liveMessage, setLiveMessage] = useState('');

  // Aplicar default quando o endpoint responder e value ainda não foi definido
  useEffect(() => {
    if (!loading && defaultId !== null && value === null) {
      onChange(defaultId);
    }
  }, [loading, defaultId, value, onChange]);

  // Filtro de busca: substrings case-insensitive sobre nome_empresa — CHK008/FR-006
  const filtered =
    searchQuery.trim() === ''
      ? empresas
      : empresas.filter((e) =>
          e.nome_empresa.toLowerCase().includes(searchQuery.toLowerCase()),
        );

  // Label exibido no trigger
  const selectedLabel =
    value !== null
      ? (empresas.find((e) => e.id === value)?.nome_empresa ?? 'Selecionar filial...')
      : 'Selecionar filial...';

  function handleSelect(empresa: Empresa) {
    const isNew = empresa.id !== prevValueRef.current;
    onChange(empresa.id);
    prevValueRef.current = empresa.id;
    setOpen(false);
    setSearchQuery('');
    if (isNew) {
      setLiveMessage(
        `Filial ${empresa.nome_empresa} selecionada. Dados recarregados.`,
      );
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      // Limpar busca ao fechar — boa prática UX
      setSearchQuery('');
    }
  }

  const isDisabled = disabled || loading || !!error;

  return (
    <div className="flex flex-col gap-1">
      {/* Label visível — CHK007 / WCAG 1.3.1 */}
      <label
        htmlFor="empresa-selector-trigger"
        className="text-sm font-medium text-foreground"
      >
        Filial
      </label>

      <Popover open={open} onOpenChange={handleOpenChange}>
        {/* Trigger — CHK007: role="combobox", aria-expanded, aria-haspopup */}
        <PopoverTrigger
          id="empresa-selector-trigger"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label="Selecionar filial"
          aria-disabled={isDisabled}
          disabled={isDisabled}
          className={cn(
            // Área de toque ≥ 44 × 44 px — CHK014-UX / WCAG 2.5.5
            'min-h-[44px] min-w-[44px]',
            // Base visual — tokens do design system EntreGô 2.0 (CHK013)
            // foreground sobre background: ratio > 4.5:1 garantido pelos tokens CSS
            'flex w-full items-center justify-between gap-2 rounded-md border border-border',
            'bg-background px-3 py-2 text-sm text-foreground',
            // Estados interativos
            'hover:bg-accent hover:text-accent-foreground',
            // Focus ring — navegação por teclado visível
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            // Estado desabilitado
            'disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          <span className="truncate">
            {loading ? (
              // Estado loading — CHK005-UX
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                Carregando...
              </span>
            ) : error ? (
              // Estado erro — CHK006-UX
              <span className="text-destructive">Erro ao carregar filiais</span>
            ) : (
              selectedLabel
            )}
          </span>
          <ChevronsUpDownIcon
            className="h-4 w-4 shrink-0 opacity-50"
            aria-hidden="true"
          />
        </PopoverTrigger>

        {/* Mensagem de erro acessível quando API indisponível — CHK006-UX */}
        {error && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {error}
          </p>
        )}

        {/* Região aria-live para anunciar seleção aos leitores de tela — CHK010 */}
        <span
          id={liveRegionId}
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {liveMessage}
        </span>

        <PopoverContent
          // Responsivo ≤375 px: ocupa quase toda a largura — CHK015
          className={cn(
            'w-[var(--radix-popover-trigger-width,220px)]',
            'max-w-[calc(100vw-2rem)]',
            'max-h-[60vh]',
            'overflow-y-auto',
            'p-0',
          )}
          align="start"
          sideOffset={4}
        >
          {/*
           * Command gerencia o ComboboxRoot do Base UI internamente.
           * Filtro de busca é feito em JS (lista `filtered`) — usamos
           * onInputValueChange para capturar a query e re-renderizamos
           * apenas os itens que passam no filtro.
           * Isso garante filtro por nome_empresa, case-insensitive
           * (CHK008/FR-006 substrings).
           */}
          <Command
            onInputValueChange={(q: string) => setSearchQuery(q)}
          >
            {/* Campo de busca — CHK008: aria-label="Buscar filial" */}
            <CommandInput
              placeholder="Buscar filial..."
              aria-label="Buscar filial"
            />
            <CommandList>
              {filtered.length === 0 && (
                <CommandEmpty>Nenhuma filial encontrada.</CommandEmpty>
              )}
              {filtered.map((empresa) => (
                <CommandItem
                  key={empresa.id}
                  value={String(empresa.id)}
                  aria-selected={value === empresa.id}
                  onClick={() => handleSelect(empresa)}
                  className="cursor-pointer"
                >
                  {/* Indicador claro do item selecionado */}
                  <CheckIcon
                    className={cn(
                      'mr-2 h-4 w-4 shrink-0',
                      value === empresa.id ? 'opacity-100' : 'opacity-0',
                    )}
                    aria-hidden="true"
                  />
                  {/* Texto visível = nome_empresa — nunca só ID — CHK009 */}
                  {empresa.nome_empresa}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export { EmpresaSelector };
export default EmpresaSelector;
