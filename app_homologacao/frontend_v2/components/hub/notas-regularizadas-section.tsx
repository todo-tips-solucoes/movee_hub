'use client';

// F4b (nota-pendente-motorista) — lista das notas que o motorista enviou
// DEPOIS do fechamento do movimento. Existe porque o pagamento retido é
// liberado por UMA PESSOA: não há gate automático entre nota e pagamento.
// Sem esta lista, o motorista regulariza e ninguém é avisado.
//
// Só aparece quando há itens: sem nenhuma regularização não há o que o
// operador fazer, e um "nenhuma regularização" fixo viraria ruído permanente.
//
// Ações (migration 0113, só com `adiantamentos.pagamento_confirmar`):
// "Já foi pago" tira o item da lista e o lote do repasse passa a bloqueá-lo;
// vai para o bloco recolhido "Marcados como já pagos", com Desfazer.
// "Apagar nota" desvincula a nota: o movimento volta a pendente no app.

import { useCallback, useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { formatBRL, formatDateBR } from '@/lib/utils';
import {
  ValidacaoXmlApiError,
  apagarNota,
  desfazerJaPago,
  listarRegularizadas,
  marcarJaPago,
  type NotaRegularizada,
  type RegularizadasResponse,
} from '@/lib/hub/validacao-xml-api';

const PERMISSAO_ACAO = 'adiantamentos.pagamento_confirmar';
const TEXTO_MAX = 200;
const CAMPO =
  'w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30';

type Acao = { tipo: 'ja-pago' | 'apagar'; item: NotaRegularizada };

function semana(n: NotaRegularizada): string {
  return `${formatDateBR(n.dtInicial) || '—'} a ${formatDateBR(n.dtFinal) || '—'}`;
}

function erroDe(e: unknown, padrao: string): string {
  return e instanceof ValidacaoXmlApiError ? e.message : padrao;
}

function AcaoDialog({
  acao,
  onFechar,
  onConcluir,
}: {
  acao: Acao | null;
  onFechar: () => void;
  onConcluir: (acao: Acao, resultado: NotaRegularizada | { podeReenviarNoApp: boolean }) => void;
}) {
  const campoId = useId();
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const apagar = acao?.tipo === 'apagar';
  const podeConfirmar = !enviando && (!apagar || texto.trim().length > 0);

  const fechar = (aberto: boolean) => {
    if (aberto || enviando) return;
    setTexto('');
    setErro(null);
    onFechar();
  };

  const confirmar = async () => {
    if (!acao || !podeConfirmar) return;
    setEnviando(true);
    setErro(null);
    try {
      const r = apagar ? await apagarNota(acao.item.id, texto.trim()) : await marcarJaPago(acao.item.id, texto.trim());
      setTexto('');
      onConcluir(acao, r);
    } catch (e) {
      setErro(erroDe(e, apagar ? 'Não foi possível apagar a nota.' : 'Não foi possível marcar como pago.'));
    } finally {
      setEnviando(false);
    }
  };

  const n = acao?.item;
  return (
    <Dialog open={acao !== null} onOpenChange={fechar}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{apagar ? 'Apagar a nota deste movimento?' : 'Marcar como já pago?'}</DialogTitle>
          <DialogDescription>
            {apagar
              ? n?.podeReenviarNoApp === false
                ? 'A nota sai do movimento e ele volta a ficar sem nota. A semana está antes do corte configurado: o motorista NÃO conseguirá reenviar pelo app.'
                : 'A nota sai do movimento e ele volta a ficar pendente: o motorista verá este movimento de novo no app e poderá enviar outra nota.'
              : 'O pagamento já foi feito fora da plataforma. O item sai desta lista e o lote do repasse não deixa pagá-lo de novo. Dá para desfazer.'}
          </DialogDescription>
        </DialogHeader>

        {n && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border p-3 text-sm">
            <dt className="text-muted-foreground">Motorista</dt>
            <dd className="font-medium text-foreground">{n.nome || '—'}</dd>
            <dt className="text-muted-foreground">Semana</dt>
            <dd>{semana(n)}</dd>
            <dt className="text-muted-foreground">Valor</dt>
            <dd className="tabular-nums">{formatBRL(n.valor)}</dd>
            <dt className="text-muted-foreground">Nota</dt>
            <dd>{n.numeroNota ? `nº ${n.numeroNota}` : '—'}</dd>
          </dl>
        )}

        <div className="flex flex-col gap-1">
          <label htmlFor={campoId} className="text-sm font-medium">
            {apagar ? 'Motivo (obrigatório)' : 'Referência do pagamento (opcional)'}
          </label>
          <textarea
            id={campoId}
            value={texto}
            maxLength={TEXTO_MAX}
            disabled={enviando}
            onChange={(e) => setTexto(e.target.value)}
            rows={2}
            placeholder={apagar ? 'Por que esta nota está sendo apagada?' : 'Ex.: pago via UneCont, NF 14'}
            className={CAMPO}
          />
        </div>

        {erro && (
          <p role="alert" className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            {erro}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" className="min-h-11 sm:min-h-8" disabled={enviando} onClick={() => fechar(false)}>
            Voltar
          </Button>
          <Button
            variant={apagar ? 'destructive' : 'default'}
            className="min-h-11 sm:min-h-8"
            disabled={!podeConfirmar}
            onClick={() => void confirmar()}
          >
            {enviando && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />}
            {apagar ? 'Apagar nota' : 'Marcar como pago'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatarQuando(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function NotasRegularizadasSection() {
  const { permissoes } = useHubAuth();
  const [dados, setDados] = useState<RegularizadasResponse | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [acao, setAcao] = useState<Acao | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [desfazendo, setDesfazendo] = useState<number | null>(null);
  const podeAgir = permissoes.includes(PERMISSAO_ACAO);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      setDados(await listarRegularizadas());
    } catch (e) {
      setErro(e instanceof ValidacaoXmlApiError ? e.message : 'Não foi possível carregar as notas enviadas após o fechamento.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  if (carregando) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Carregando notas enviadas após o fechamento...
      </p>
    );
  }

  if (erro) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
        <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
        <p className="text-sm font-medium text-destructive">{erro}</p>
        <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => void carregar()}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  // Some sem itens — exceto logo depois de apagar o último, para a confirmação não sumir junto.
  if (!dados || (dados.itens.length === 0 && !aviso)) return null;

  const pendentes = dados.itens.filter((n) => !n.jaPago);
  const pagos = dados.itens.filter((n) => n.jaPago);

  const substituir = (item: NotaRegularizada) =>
    setDados((d) => (d ? { ...d, itens: d.itens.map((x) => (x.id === item.id ? item : x)) } : d));

  const concluir = (a: Acao, r: NotaRegularizada | { podeReenviarNoApp: boolean }) => {
    setAcao(null);
    if (a.tipo === 'ja-pago') {
      substituir(r as NotaRegularizada);
      setAviso(`${a.item.nome || 'Movimento'} marcado como já pago.`);
      return;
    }
    setDados((d) => (d ? { ...d, itens: d.itens.filter((x) => x.id !== a.item.id), total: d.total - 1 } : d));
    setAviso(
      (r as { podeReenviarNoApp: boolean }).podeReenviarNoApp
        ? `Nota apagada. ${a.item.nome || 'O motorista'} verá o movimento de novo no app.`
        : 'Nota apagada. A semana está antes do corte: o motorista não consegue reenviar pelo app.'
    );
  };

  const desfazer = async (n: NotaRegularizada) => {
    setDesfazendo(n.id);
    setAviso(null);
    try {
      substituir(await desfazerJaPago(n.id));
      setAviso(`${n.nome || 'Movimento'} voltou para os pagamentos retidos.`);
    } catch (e) {
      setAviso(erroDe(e, 'Não foi possível desfazer.'));
    } finally {
      setDesfazendo(null);
    }
  };

  return (
    <section aria-labelledby="notas-regularizadas-titulo" className="space-y-3">
      <div>
        <h2 id="notas-regularizadas-titulo" className="font-heading text-lg font-semibold text-foreground">
          Pagamentos retidos aguardando liberação
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Estes motoristas enviaram a nota depois que o movimento foi fechado. O pagamento deles segue retido até
          você liberá-lo manualmente: o sistema não libera sozinho.
        </p>
        {podeAgir && (
          <p className="mt-1 text-sm text-muted-foreground">
            Se o financeiro já pagou por fora, use <strong className="font-medium text-foreground">Já foi pago</strong>.
            Se a nota não serve, <strong className="font-medium text-foreground">Apagar nota</strong> devolve o movimento
            ao motorista.
          </p>
        )}
        {permissoes.includes('adiantamentos.pagamentos_consultar') && (
          <p className="mt-1 text-sm">
            <Link href="/hub/dashboard/adiantamentos/repasse" className="font-medium text-primary underline underline-offset-4">
              Gerar o lote de pagamento na aba Repasse
            </Link>
          </p>
        )}
        {dados.total > dados.limite && (
          <p className="mt-1 text-sm text-muted-foreground">
            Mostrando as {dados.itens.length} mais recentes de {dados.total} no total.
          </p>
        )}
      </div>
      {aviso && (
        <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm text-foreground">
          {aviso}
        </p>
      )}
      {pendentes.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {pendentes.map((n) => (
            <li key={n.id} className="grid gap-2 p-3 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">{n.nome || '—'}</p>
                <p className="text-xs text-muted-foreground">
                  CNPJ {n.cnpjPrestador || '—'} · Movimento de {semana(n)}
                  {n.numeroNota ? ` · NF nº ${n.numeroNota}` : ''}
                </p>
                <p className="text-xs text-muted-foreground">Regularizada em {formatarQuando(n.regularizadaEm)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium tabular-nums text-foreground">{formatBRL(n.valor)}</span>
                <Badge variant={n.notaAprovada ? 'success' : 'destructive'}>
                  {n.notaAprovada ? 'Nota aprovada' : 'Nota recusada'}
                </Badge>
                {podeAgir && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      className="min-h-11 sm:min-h-8"
                      onClick={() => { setAviso(null); setAcao({ tipo: 'ja-pago', item: n }); }}
                    >
                      Já foi pago
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="min-h-11 sm:min-h-8"
                      onClick={() => { setAviso(null); setAcao({ tipo: 'apagar', item: n }); }}
                    >
                      Apagar nota
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Nenhum pagamento retido aguardando decisão.</p>
      )}
      {pagos.length > 0 && (
        <details className="rounded-lg border">
          <summary className="min-h-11 cursor-pointer px-3 py-2 text-sm font-medium text-foreground sm:min-h-8">
            Marcados como já pagos ({pagos.length})
          </summary>
          <ul className="divide-y border-t">
            {pagos.map((n) => (
              <li key={n.id} className="grid gap-2 p-3 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{n.nome || '—'}</p>
                  <p className="text-xs text-muted-foreground">
                    Movimento de {semana(n)} · {formatBRL(n.valor)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {n.jaPago?.manual
                      ? `Marcado em ${formatarQuando(n.jaPago.em)}${n.jaPago.por ? ` por ${n.jaPago.por}` : ''}${n.jaPago.referencia ? ` · ${n.jaPago.referencia}` : ''}`
                      : 'Pago fora da plataforma (conciliação com a planilha)'}
                  </p>
                </div>
                {podeAgir && n.jaPago?.manual && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-11 sm:min-h-8"
                    disabled={desfazendo === n.id}
                    onClick={() => void desfazer(n)}
                  >
                    {desfazendo === n.id && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />}
                    Desfazer
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      <AcaoDialog acao={acao} onFechar={() => setAcao(null)} onConcluir={concluir} />
    </section>
  );
}
