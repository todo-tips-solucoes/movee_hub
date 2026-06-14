'use client';

import { useState } from 'react';
import { Pencil, Trash2, ExternalLink, Check, X, AlertCircle, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { EnvioMassa } from '@/types';
import { formatBRL, formatDateBR } from '@/lib/utils';
import { EditDialog } from './edit-dialog';
import { DeleteDialog } from './delete-dialog';

interface DataTableProps {
  data: EnvioMassa[];
  selectedIds: Set<number>;
  onToggleSelectAll: () => void;
  onToggleSelect: (id: number) => void;
  onDelete: (id: number) => Promise<void>;
  onUpdate: (id: number, data: Record<string, unknown>) => Promise<void>;
}

function getXmlUrl(nota_ok: string | null): string | null {
  if (!nota_ok) return null;
  try {
    const parsed = JSON.parse(nota_ok);
    return parsed.url_download || parsed.url || null;
  } catch {
    if (nota_ok.startsWith('http')) return nota_ok;
    return null;
  }
}

export function DataTable({
  data,
  selectedIds,
  onToggleSelectAll,
  onToggleSelect,
  onDelete,
  onUpdate,
}: DataTableProps) {
  const [editRecord, setEditRecord] = useState<EnvioMassa | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const allSelected = data.length > 0 && selectedIds.size === data.length;

  return (
    <>
      {/* Mobile card layout */}
      <div className="md:hidden h-full overflow-auto space-y-2">
        {data.length === 0 ? (
          <div className="flex flex-col items-center gap-2 text-muted-foreground py-10">
            <FileText className="h-10 w-10 opacity-30" />
            <p className="font-medium">Nenhum registro encontrado</p>
            <p className="text-xs">Importe um arquivo XLSX ou ajuste os filtros</p>
          </div>
        ) : (
          data.map((item) => {
            const xmlUrl = getXmlUrl(item.nota_ok);
            return (
              <div key={item.id} className={`rounded-lg border p-3 space-y-2 ${item.enviado === 'erro' ? 'border-destructive/30 bg-destructive/5' : ''}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Checkbox
                      checked={selectedIds.has(item.id)}
                      onCheckedChange={() => onToggleSelect(item.id)}
                    />
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{item.nome}</p>
                      <p className="text-xs text-muted-foreground font-mono">{item.number}</p>
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditRecord(item)} aria-label={`Editar registro ${item.nome}`} title="Editar">
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => setDeleteId(item.id)} aria-label={`Excluir registro ${item.nome}`} title="Excluir">
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <span className="font-mono font-medium">{formatBRL(item.valor)}</span>
                  <span className="flex items-center gap-1">
                    {item.enviado === 'ok' ? (
                      <><Check className="h-3.5 w-3.5 text-success" /> Enviado</>
                    ) : item.enviado === 'erro' ? (
                      <><X className="h-3.5 w-3.5 text-destructive" /> Erro</>
                    ) : (
                      <span className="text-muted-foreground">Nao enviado</span>
                    )}
                  </span>
                  {item.numnota && <span className="text-muted-foreground">Nota: {item.numnota}</span>}
                  {item.data_emissao && <span className="text-muted-foreground">{formatDateBR(item.data_emissao)}</span>}
                  {item.erro_validacao && (
                    <span
                      className="flex items-center gap-1 font-medium text-destructive"
                      title={item.erro_validacao}
                      aria-label={`Erro de validação: ${item.erro_validacao}`}
                    >
                      <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" /> Erro val.
                    </span>
                  )}
                  {xmlUrl && (
                    <a href={xmlUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      XML <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Desktop table layout — R007: overflow-x explícito (scroll interno, sem estourar a página) */}
      <div className="hidden md:block rounded-lg border h-full overflow-x-auto overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card shadow-[0_1px_0_0] shadow-border">
            {/* R007: headers sem quebra de linha em larguras médias (densidade desktop) */}
            <TableRow className="whitespace-nowrap hover:bg-card">
              <TableHead className="w-10">
                <Checkbox checked={allSelected} onCheckedChange={onToggleSelectAll} />
              </TableHead>
              <TableHead>Numero</TableHead>
              <TableHead>Nome</TableHead>
              <TableHead>Valor</TableHead>
              <TableHead className="text-center">Enviado</TableHead>
              <TableHead className="text-center">Erro</TableHead>
              <TableHead>Num. Nota</TableHead>
              <TableHead>XML</TableHead>
              <TableHead>Data Emissao</TableHead>
              <TableHead className="text-center">Erro Val.</TableHead>
              <TableHead className="text-right">Acoes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={11} className="h-40 text-center">
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <FileText className="h-10 w-10 opacity-30" />
                    <p className="font-medium">Nenhum registro encontrado</p>
                    <p className="text-xs">Importe um arquivo XLSX ou ajuste os filtros</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              data.map((item) => {
                const xmlUrl = getXmlUrl(item.nota_ok);
                return (
                  <TableRow key={item.id} className="transition-colors hover:bg-muted/50">
                    <TableCell>
                      <Checkbox
                        checked={selectedIds.has(item.id)}
                        onCheckedChange={() => onToggleSelect(item.id)}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-sm">{item.number}</TableCell>
                    <TableCell className="max-w-[200px] truncate">{item.nome}</TableCell>
                    <TableCell className="font-mono">{formatBRL(item.valor)}</TableCell>
                    <TableCell className="text-center">
                      {item.enviado === 'ok' ? (
                        <Check className="mx-auto h-4 w-4 text-success" />
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      {item.enviado === 'erro' ? (
                        <X className="mx-auto h-4 w-4 text-destructive" />
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-sm">{item.numnota || ''}</TableCell>
                    <TableCell>
                      {xmlUrl ? (
                        <a
                          href={xmlUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline text-sm"
                        >
                          Ver XML <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{formatDateBR(item.data_emissao)}</TableCell>
                    <TableCell className="text-center">
                      {item.erro_validacao ? (
                        <Tooltip>
                          <TooltipTrigger
                            aria-label={`Erro de validação: ${item.erro_validacao}`}
                            className="mx-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                            Erro
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            <p>{item.erro_validacao}</p>
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setEditRecord(item)}
                          aria-label={`Editar registro ${item.nome}`}
                          title="Editar"
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => setDeleteId(item.id)}
                          aria-label={`Excluir registro ${item.nome}`}
                          title="Excluir"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <EditDialog
        open={!!editRecord}
        onOpenChange={(open) => !open && setEditRecord(null)}
        record={editRecord}
        onSave={onUpdate}
      />

      <DeleteDialog
        open={deleteId !== null}
        onOpenChange={(open) => !open && setDeleteId(null)}
        onConfirm={async () => {
          if (deleteId !== null) await onDelete(deleteId);
        }}
      />
    </>
  );
}
