'use client';

// Ciclo do lote de pagamento do repasse, dentro da aba Repasse (PLANO-F5 §3.4):
// prévia → gerar lote → baixar arquivo Transfeera → importar retorno (ou
// confirmar na mão) → cancelar. Os valores por pessoa já estão no extrato logo
// acima; aqui só se decide pagar. Os três diálogos são os do adiantamento,
// apontados para os endpoints do repasse.

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlertCircle, Ban, CheckCircle2, Download, FileUp, Loader2, PackagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { PaginationControls } from '@/components/pagination-controls';
import { LoteStatusBadge } from '@/components/hub/status-badge';
import { CancelarLoteDialog, useCancelarLoteDialog } from '@/components/hub/adiantamento-cancelar-lote-dialog';
import { ConfirmarLoteDialog, useConfirmarLoteDialog } from '@/components/hub/adiantamento-confirmar-lote-dialog';
import { ImportarRetornoDialog, useImportarRetornoDialog } from '@/components/hub/adiantamento-importar-retorno-dialog';
import { useHubAuth } from '@/contexts/hub-auth-context';
import {
  AdiantamentosApiError,
  baixarArquivoLoteRepasse,
  cancelarLoteRepasse,
  confirmarLoteRepasse,
  criarLoteRepasse,
  importarRetornoLoteRepasse,
  listarLotesRepasse,
  obterLoteRepasse,
  previaLoteRepasse,
  type Lote,
  type LoteItemDetalhe,
  type LotesListResponse,
  type RepasseLotePreviaResponse,
} from '@/lib/hub/adiantamentos-api';
import { acoesDoLote, agruparBloqueadas, avisoRecorte, mensagemErroGerar, montarCriacao, podeGerarLote, podeVerLotes, selecionarParaLote } from '@/lib/hub/repasse-lote';
import { formatBRL, formatDateBR } from '@/lib/utils';

const PAGE_SIZE = 10;
const msg = (e: unknown, padrao: string) => (e instanceof AdiantamentosApiError ? e.message : padrao);

/** Monta o diálogo de confirmação manual já com os itens carregados. Montar só
 *  quando o operador clica (e remontar a cada clique, via `key`) evita abrir o
 *  diálogo antes de os itens chegarem. */
function ConfirmarNaMao({ lote, itens, onSucesso }: { lote: Lote; itens: LoteItemDetalhe[]; onSucesso: () => void }) {
  const d = useConfirmarLoteDialog({ loteId: lote.id, itens, onSucesso, confirmarFn: confirmarLoteRepasse });
  const { abrir } = d;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { abrir(); }, []);
  return <ConfirmarLoteDialog d={d} />;
}

function LinhaLote({ lote, onMudou }: { lote: Lote; onMudou: () => void }) {
  const { permissoes } = useHubAuth();
  const acoes = acoesDoLote(lote.status, permissoes);
  const [baixando, setBaixando] = useState(false);
  const [confirmacao, setConfirmacao] = useState<{ n: number; itens: LoteItemDetalhe[] } | null>(null);

  const cancelar = useCancelarLoteDialog({
    loteId: lote.id, status: lote.status, cancelar: cancelarLoteRepasse,
    onSucesso: () => { toast.success('Lote cancelado. Os pagamentos voltaram a ficar disponíveis.'); onMudou(); },
  });
  const retorno = useImportarRetornoDialog({ loteId: lote.id, importar: importarRetornoLoteRepasse, produto: 'repasse', onSucesso: onMudou });

  const baixar = async () => {
    setBaixando(true);
    try {
      await baixarArquivoLoteRepasse(lote.id, lote.numero);
      onMudou();
    } catch (e) {
      toast.error(msg(e, 'Não foi possível baixar o arquivo do lote.'));
    } finally {
      setBaixando(false);
    }
  };

  const abrirConfirmacao = async () => {
    try {
      const det = await obterLoteRepasse(lote.id);
      setConfirmacao((c) => ({ n: (c?.n ?? 0) + 1, itens: det.itens }));
    } catch (e) {
      toast.error(msg(e, 'Não foi possível carregar os itens do lote.'));
    }
  };

  return (
    <TableRow>
      <TableCell className="font-mono">{lote.numero}</TableCell>
      <TableCell><LoteStatusBadge status={lote.status} /></TableCell>
      <TableCell className="text-right font-mono">{lote.quantidade}</TableCell>
      <TableCell className="text-right font-mono">{formatBRL(lote.valorTotal)}</TableCell>
      <TableCell>{formatDateBR(lote.criadoEm)}</TableCell>
      <TableCell>
        <div className="flex flex-wrap justify-end gap-2">
          {acoes.baixar && (
            <Button size="sm" className="min-h-11 gap-1.5 sm:min-h-8" disabled={baixando} onClick={baixar}>
              {baixando ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <Download className="size-4" aria-hidden="true" />}
              Baixar arquivo Transfeera
            </Button>
          )}
          {acoes.retorno && (
            <Button variant="outline" size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={retorno.abrir}>
              <FileUp className="size-4" aria-hidden="true" />
              Importar retorno
            </Button>
          )}
          {acoes.confirmar && (
            <Button variant="outline" size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={abrirConfirmacao}>
              <CheckCircle2 className="size-4" aria-hidden="true" />
              Confirmar na mão
            </Button>
          )}
          {acoes.cancelar && (
            <Button variant="destructive" size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={cancelar.abrir}>
              <Ban className="size-4" aria-hidden="true" />
              Cancelar lote
            </Button>
          )}
        </div>
        <CancelarLoteDialog
          d={cancelar}
          descricao="Os pagamentos voltam a ficar disponíveis e podem entrar num próximo lote. Esta ação é auditada."
        />
        <ImportarRetornoDialog d={retorno} prefixoId="REP-" />
        {confirmacao && (
          <ConfirmarNaMao
            key={confirmacao.n}
            lote={lote}
            itens={confirmacao.itens}
            onSucesso={() => { toast.success('Resultado do lote confirmado.'); onMudou(); }}
          />
        )}
      </TableCell>
    </TableRow>
  );
}

export function RepasseLotesSection() {
  const { permissoes } = useHubAuth();
  const ver = podeVerLotes(permissoes);
  const gerarPermitido = podeGerarLote(permissoes);

  const [previa, setPrevia] = useState<RepasseLotePreviaResponse | null>(null);
  const [erroPrevia, setErroPrevia] = useState<string | null>(null);
  const [lotes, setLotes] = useState<LotesListResponse | null>(null);
  const [erroLotes, setErroLotes] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [gerando, setGerando] = useState(false);
  // Uma chave por prévia: repetir o clique (ou a requisição) com a MESMA chave
  // devolve o mesmo lote em vez de criar outro. Renova quando a prévia é relida.
  const chave = useRef(crypto.randomUUID());

  const carregarPrevia = useCallback(async () => {
    setErroPrevia(null);
    try {
      setPrevia(await previaLoteRepasse());
      chave.current = crypto.randomUUID();
    } catch (e) {
      setErroPrevia(msg(e, 'Não foi possível carregar a prévia do lote.'));
    }
  }, []);

  const carregarLotes = useCallback(async () => {
    setErroLotes(null);
    try {
      setLotes(await listarLotesRepasse({ page, pageSize: PAGE_SIZE }));
    } catch (e) {
      setErroLotes(msg(e, 'Não foi possível carregar os lotes.'));
    }
  }, [page]);

  useEffect(() => { if (ver) void carregarPrevia(); }, [ver, carregarPrevia]);
  useEffect(() => { if (ver) void carregarLotes(); }, [ver, carregarLotes]);

  const atualizar = useCallback(() => { void carregarPrevia(); void carregarLotes(); }, [carregarPrevia, carregarLotes]);

  const gerar = async () => {
    const corpo = previa && montarCriacao(previa, chave.current);
    if (!corpo) return;
    setGerando(true);
    try {
      const lote = await criarLoteRepasse(corpo);
      toast.success(`Lote ${lote.numero} gerado. Baixe o arquivo e envie à Transfeera.`);
      setPage(1);
      atualizar();
    } catch (e) {
      toast.error((e instanceof AdiantamentosApiError && mensagemErroGerar(e.codigo)) || msg(e, 'Não foi possível gerar o lote.'));
      // A prévia mudou por baixo (ou item entrou em outro lote): relê, nunca insiste com ela velha.
      if (e instanceof AdiantamentosApiError && (e.codigo === 'PREVIA_DESATUALIZADA' || e.codigo === 'ITENS_EM_OUTRO_LOTE' || e.codigo === 'LOTE_ACIMA_DO_LIMITE')) void carregarPrevia();
    } finally {
      setGerando(false);
    }
  };

  if (!ver) return null;

  const grupos = previa ? agruparBloqueadas(previa.bloqueadas) : [];
  const selecao = previa ? selecionarParaLote(previa.aptas) : null;
  const aviso = selecao ? avisoRecorte(selecao.ficam, selecao.entram.length) : null;
  const totalPaginas = Math.max(1, Math.ceil((lotes?.total ?? 0) / PAGE_SIZE));

  return (
    <section aria-labelledby="repasse-lotes-titulo" className="flex flex-col gap-4 border-t pt-6">
      <div>
        <h2 id="repasse-lotes-titulo" className="font-heading text-lg font-semibold text-foreground">
          Pagamento do repasse
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Gere o lote com os pagamentos aptos, baixe o arquivo da Transfeera e importe o retorno para confirmar.
        </p>
      </div>

      {erroPrevia ? (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertCircle className="size-5 shrink-0" aria-hidden="true" />
          <span className="flex-1 font-medium">{erroPrevia}</span>
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => void carregarPrevia()}>Tentar novamente</Button>
        </div>
      ) : !previa ? (
        <p role="status" className="text-sm text-muted-foreground">Carregando pagamentos aptos...</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <p className="text-sm">
              <span className="font-medium">{previa.quantidadeApta}</span>{' '}
              {previa.quantidadeApta === 1 ? 'pagamento apto' : 'pagamentos aptos'} · A pagar{' '}
              <span className="font-mono font-semibold">{formatBRL(previa.totalApto)}</span>
            </p>
            {gerarPermitido && (
              <Button size="sm" className="min-h-11 gap-1.5 sm:min-h-8" disabled={previa.quantidadeApta === 0 || gerando} onClick={gerar}>
                {gerando ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <PackagePlus className="size-4" aria-hidden="true" />}
                Gerar lote de pagamento
              </Button>
            )}
          </div>

          {aviso && selecao && (
            <p role="status" className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
              {aviso} Este lote: {selecao.entram.length.toLocaleString('pt-BR')} · A pagar{' '}
              <span className="font-mono font-semibold">{formatBRL(selecao.total)}</span>.
            </p>
          )}

          {grupos.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Não entram no lote</h3>
              <ul className="divide-y rounded-lg border">
                {grupos.map((g) => (
                  <li key={g.motivo} className="p-3 text-sm">
                    <details>
                      <summary className="cursor-pointer font-medium">
                        {g.linhas.length} — {g.rotulo}
                      </summary>
                      {g.acao && <p className="mt-1 text-muted-foreground">{g.acao}</p>}
                      <ul className="mt-2 flex flex-col gap-0.5 text-xs text-muted-foreground">
                        {g.linhas.map((l) => (
                          <li key={`${l.apuracaoId}-${l.entregadorId}`}>
                            {l.motorista} · {formatBRL(l.valor)}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Lotes gerados</h3>
        {erroLotes ? (
          <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            <AlertCircle className="size-5 shrink-0" aria-hidden="true" />
            <span className="flex-1 font-medium">{erroLotes}</span>
            <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => void carregarLotes()}>Tentar novamente</Button>
          </div>
        ) : !lotes ? (
          <p role="status" className="text-sm text-muted-foreground">Carregando lotes...</p>
        ) : lotes.itens.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum lote de repasse gerado ainda.</p>
        ) : (
          <>
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Lote</TableHead>
                    <TableHead>Situação</TableHead>
                    <TableHead className="text-right">Pagamentos</TableHead>
                    <TableHead className="text-right">Valor total</TableHead>
                    <TableHead>Criado em</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lotes.itens.map((l) => <LinhaLote key={l.id} lote={l} onMudou={atualizar} />)}
                </TableBody>
              </Table>
            </div>
            <PaginationControls
              currentPage={page}
              totalPages={totalPaginas}
              recordsPerPage={PAGE_SIZE}
              totalRecords={lotes.total}
              onPageChange={setPage}
            />
          </>
        )}
      </div>
    </section>
  );
}
