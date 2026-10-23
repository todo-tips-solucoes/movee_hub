'use client';

// lancamento-externo — diálogo "Pagos por fora da semana": LISTA os lançamentos já aplicados e permite EXCLUIR
// um (autorizado pelo operador em 2026-10-23; emenda datada da FR-040). Onde a informação já aparece hoje: a
// coluna "Pago por fora" da prévia mostra só o LÍQUIDO por motorista; aqui está cada lançamento (tipo, data, valor,
// observação, quem lançou), que em nenhum outro lugar se vê.
//
// Semana FECHADA não se exclui: o valor está congelado no repasse. O botão reflete `excluivel` (dica) e o servidor
// recusa de qualquer forma (409). A exclusão pede confirmação na própria linha — num caminho de dinheiro, um clique só
// não apaga.

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  LancamentoExternoApiError, excluirLancamentoExterno, listarLancamentosExternos,
  type LancamentoExternoItem,
} from '@/lib/hub/lancamento-externo';
import { formatBRL, formatDateBR } from '@/lib/utils';

const POR_PAGINA = 50;

export function useLancamentoExternoListaDialog({ periodo, onMudou }: { periodo: string; onMudou: () => void }) {
  const [open, setOpen] = useState(false);
  const [itens, setItens] = useState<LancamentoExternoItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState<number | null>(null);
  const [excluindo, setExcluindo] = useState<number | null>(null);
  // M2 (rodada 4, FR-057): busca por nome do motorista. `buscaDigitada` é o campo; `busca` é a aplicada (Enter/Buscar).
  const [buscaDigitada, setBuscaDigitada] = useState('');
  const [busca, setBusca] = useState('');

  const carregar = useCallback(async (off: number, manterErro = false) => {
    setCarregando(true); if (!manterErro) setErro(null);
    try {
      const r = await listarLancamentosExternos(periodo, { offset: off, limite: POR_PAGINA, busca: busca || undefined });
      // M13: página fora de faixa (os itens de trás foram excluídos): o servidor devolve o total real e itens vazios —
      // vai para a última página que existe em vez de afirmar "nenhum lançamento".
      if (r.itens.length === 0 && r.total > 0 && off > 0) {
        setTotal(r.total); setOffset(Math.floor((r.total - 1) / POR_PAGINA) * POR_PAGINA);
        return;
      }
      setItens(r.itens); setTotal(r.total);
    } catch (e) {
      setItens([]); setTotal(0);
      setErro(e instanceof LancamentoExternoApiError ? e.message : 'Não foi possível listar os lançamentos.');
    } finally {
      setCarregando(false);
    }
  }, [periodo, busca]);

  useEffect(() => { if (open) void carregar(offset); }, [open, offset, carregar]);

  const abrir = useCallback(() => { setOffset(0); setBusca(''); setBuscaDigitada(''); setConfirmando(null); setErro(null); setOpen(true); }, []);
  const buscar = useCallback(() => { setOffset(0); setBusca(buscaDigitada.trim()); }, [buscaDigitada]);

  const excluir = useCallback(async (id: number) => {
    setExcluindo(id); setErro(null);
    try {
      await excluirLancamentoExterno(id);
      setConfirmando(null);
      onMudou(); // a prévia e o aviso de FR-049 reconsultam
      // Se era o último da página, volta uma página (senão a tela mostra "vazio" com itens atrás).
      const proximoOffset = itens.length === 1 && offset > 0 ? Math.max(0, offset - POR_PAGINA) : offset;
      if (proximoOffset !== offset) setOffset(proximoOffset); else await carregar(offset);
    } catch (e) {
      setConfirmando(null);
      setErro(e instanceof LancamentoExternoApiError ? e.message : 'Não foi possível excluir agora.');
      void carregar(offset, true); // a lista pode estar velha (ex.: a semana fechou enquanto estava aberta)
    } finally {
      setExcluindo(null);
    }
  }, [carregar, itens.length, offset, onMudou]);

  return { open, setOpen, abrir, buscaDigitada, setBuscaDigitada, buscar, busca, itens, total, offset, setOffset, carregando, erro, confirmando, setConfirmando, excluindo, excluir, periodo };
}

export function LancamentoExternoListaDialog({ d }: { d: ReturnType<typeof useLancamentoExternoListaDialog> }) {
  const fim = Math.min(d.offset + POR_PAGINA, d.total);
  return (
    <Dialog open={d.open} onOpenChange={d.setOpen}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Pagos por fora da semana</DialogTitle>
          <DialogDescription>
            Lançamentos cuja data de pagamento cai na semana de {formatDateBR(d.periodo)}. Excluir devolve o valor ao repasse
            e libera reenviar a mesma linha. Semana já fechada não permite exclusão: o valor está congelado.
          </DialogDescription>
        </DialogHeader>
        {d.erro && (
          <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{d.erro}
          </p>
        )}
        <form className="flex gap-2" role="search" onSubmit={(e) => { e.preventDefault(); d.buscar(); }}>
          <Input value={d.buscaDigitada} onChange={(e) => d.setBuscaDigitada(e.target.value)} maxLength={100}
            placeholder="Buscar por nome do motorista" aria-label="Buscar por nome do motorista" className="max-w-sm" />
          <Button type="submit" variant="outline" disabled={d.carregando}>Buscar</Button>
        </form>
        {d.carregando && d.itens.length === 0 ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />Carregando…
          </p>
        ) : d.itens.length === 0 && !d.erro ? (
          <p className="text-sm text-muted-foreground">
            {d.busca ? `Nenhum lançamento de "${d.busca}" nesta semana.` : 'Nenhum lançamento pago por fora nesta semana.'}
          </p>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Motorista</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  <TableHead>Observação</TableHead>
                  <TableHead>Lançado por</TableHead>
                  <TableHead><span className="sr-only">Ações</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.itens.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-medium">{i.motorista}</TableCell>
                    <TableCell>{i.sinal < 0 ? 'Adiantamento' : 'Crédito'}</TableCell>
                    <TableCell>{formatDateBR(i.dataPagamento)}</TableCell>
                    <TableCell className="text-right font-mono">{i.sinal < 0 ? '− ' : '+ '}{formatBRL(Number(i.valor))}</TableCell>
                    <TableCell className="max-w-48 truncate" title={i.observacao ?? undefined}>{i.observacao ?? '—'}</TableCell>
                    <TableCell>{i.criadoPor ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      {!i.excluivel ? (
                        <span className="text-xs text-muted-foreground">{i.semanaFechada ? 'Semana fechada' : 'Sem permissão'}</span>
                      ) : d.confirmando === i.id ? (
                        <span className="flex justify-end gap-2">
                          <Button size="sm" variant="destructive" className="min-h-11 sm:min-h-8" disabled={d.excluindo === i.id}
                            onClick={() => d.excluir(i.id)}>
                            {d.excluindo === i.id ? <Loader2 className="mr-1 size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
                            Confirmar exclusão
                          </Button>
                          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={d.excluindo === i.id}
                            onClick={() => d.setConfirmando(null)}>Voltar</Button>
                        </span>
                      ) : (
                        <Button size="sm" variant="outline" className="min-h-11 gap-1.5 sm:min-h-8" aria-label={`Excluir lançamento de ${i.motorista}`}
                          onClick={() => d.setConfirmando(i.id)}>
                          <Trash2 className="size-4" aria-hidden="true" />Excluir
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {d.total > 0 ? `${d.offset + 1}–${fim} de ${d.total}` : ''}
          </span>
          <span className="flex gap-2">
            <Button variant="outline" disabled={d.offset === 0 || d.carregando} onClick={() => d.setOffset(Math.max(0, d.offset - POR_PAGINA))}>Anterior</Button>
            <Button variant="outline" disabled={fim >= d.total || d.carregando} onClick={() => d.setOffset(d.offset + POR_PAGINA)}>Próxima</Button>
            <Button onClick={() => d.setOpen(false)}>Fechar</Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
