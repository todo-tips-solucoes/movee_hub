'use client';

import { useState, useMemo } from 'react';
import { X, Search, ChevronDown, Filter } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { FilterState } from '@/types';
import { motion, AnimatePresence } from 'framer-motion';

interface FiltersProps {
  filters: FilterState;
  onChange: (partial: Partial<FilterState>) => void;
  onReset: () => void;
}

export function Filters({ filters, onChange, onReset }: FiltersProps) {
  const [expanded, setExpanded] = useState(true);

  const activeCount = useMemo(() => {
    let count = 0;
    if (filters.numero) count++;
    if (filters.nome) count++;
    if (filters.valor) count++;
    if (filters.numNota) count++;
    if (filters.dataEmissao) count++;
    if (filters.enviado !== 'all') count++;
    if (filters.sucesso !== 'all') count++;
    if (filters.validacao !== 'all') count++;
    if (filters.enviouNota !== 'all') count++;
    return count;
  }, [filters]);

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between p-3 text-sm font-medium hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <span>Filtros</span>
          {activeCount > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
              {activeCount}
            </span>
          )}
        </div>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="space-y-3 border-t px-3 pb-3 pt-3">
              {/* R001: 1 col <400px, 2 cols ≥400px, 4 cols ≥lg; inputs ≥44px no mobile */}
              <div className="grid grid-cols-1 gap-3 xs:grid-cols-2 lg:grid-cols-4">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Numero..."
                    value={filters.numero}
                    onChange={(e) => onChange({ numero: e.target.value })}
                    className="h-11 pl-8 md:h-8"
                  />
                </div>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Nome..."
                    value={filters.nome}
                    onChange={(e) => onChange({ nome: e.target.value })}
                    className="h-11 pl-8 md:h-8"
                  />
                </div>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Valor..."
                    value={filters.valor}
                    onChange={(e) => onChange({ valor: e.target.value })}
                    className="h-11 pl-8 md:h-8"
                  />
                </div>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Num. Nota..."
                    value={filters.numNota}
                    onChange={(e) => onChange({ numNota: e.target.value })}
                    className="h-11 pl-8 md:h-8"
                  />
                </div>
              </div>

              {/* R001: 2 cols <400px, 3 cols ≥400px, flex no desktop; selects ≥44px no mobile */}
              <div className="grid grid-cols-2 gap-3 xs:grid-cols-3 sm:flex sm:flex-wrap sm:items-end sm:gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Enviado</span>
                  <select
                    value={filters.enviado}
                    onChange={(e) => onChange({ enviado: e.target.value })}
                    className="h-11 w-full rounded-md border bg-background px-3 text-sm sm:h-9 sm:w-auto"
                  >
                    <option value="all">Todos</option>
                    <option value="yes">Enviados</option>
                    <option value="no">Nao Enviados</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Erro de Envio</span>
                  <select
                    value={filters.sucesso}
                    onChange={(e) => onChange({ sucesso: e.target.value })}
                    className="h-11 w-full rounded-md border bg-background px-3 text-sm sm:h-9 sm:w-auto"
                  >
                    <option value="all">Todos</option>
                    <option value="yes">Com Erro</option>
                    <option value="no">Sem Erro</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Erro de Validacao</span>
                  <select
                    value={filters.validacao}
                    onChange={(e) => onChange({ validacao: e.target.value })}
                    className="h-11 w-full rounded-md border bg-background px-3 text-sm sm:h-9 sm:w-auto"
                  >
                    <option value="all">Todos</option>
                    <option value="yes">Com Erro</option>
                    <option value="no">Sem Erro</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Enviou Nota</span>
                  <select
                    value={filters.enviouNota}
                    onChange={(e) => onChange({ enviouNota: e.target.value })}
                    className="h-11 w-full rounded-md border bg-background px-3 text-sm sm:h-9 sm:w-auto"
                  >
                    <option value="all">Todos</option>
                    <option value="yes">Sim</option>
                    <option value="no">Nao</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Data Emissao</span>
                  <Input
                    type="date"
                    className="h-11 w-full sm:h-9 sm:w-auto"
                    value={filters.dataEmissao}
                    onChange={(e) => onChange({ dataEmissao: e.target.value })}
                  />
                </div>

                {activeCount > 0 && (
                  <div className="col-span-2 flex items-end xs:col-span-1">
                    <Button size="sm" variant="ghost" className="h-11 w-full gap-1 text-muted-foreground hover:text-destructive sm:h-9 sm:w-auto" onClick={onReset}>
                      <X className="h-3.5 w-3.5" />
                      Limpar filtros
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
