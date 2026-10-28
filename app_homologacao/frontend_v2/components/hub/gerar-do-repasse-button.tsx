'use client';

// repasse-gera-movimento FASE 4 — botão ÚNICO "Gerar do repasse" (FR-014), usado na tela de Repasse e
// nas duas telas de Envio em Massa. Um acionamento fecha a apuração (se ainda aberta) e cria o movimento
// de cada motorista; a rota é uma só (`gerarMovimentos`), por isso as três telas dão o mesmo resultado.
//
// A guarda do antigo `FecharApuracaoDialog` mora aqui, preservada: remanescente negativo é INFORMADO, não
// bloqueado. A caixa de confirmação é exigida quando `qtdNegativo > 0` OU quando o resumo é desconhecido
// (carregando, erro, campo ausente) — e, marcada a caixa, a geração segue. Nunca recusa.

import { useCallback, useEffect, useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { AvisoLancamentoExterno, useResumoLancamentoExterno } from '@/components/hub/lancamento-externo-aviso';
import { rotuloStatusAdiantamento } from '@/components/hub/status-badge';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { formatBRL } from '@/lib/utils';
import { formatarISOparaBR, inicioDaSemanaApuracao, paraISO } from '@/lib/hub/periodo';
import { resumirRecusas } from '@/lib/hub/adiantamento-recusas';
import {
  AdiantamentosApiError,
  gerarMovimentos,
  obterConfiguracoes,
  pendentesDoErro,
  type AdiantamentosPendentes,
} from '@/lib/hub/adiantamentos-api';

/** Semana de apuração IMEDIATAMENTE anterior à corrente: a corrente sempre recusa `PERIODO_EM_ABERTO`. */
export function semanaAnterior(hoje: Date, diaInicio: number): string {
  const [a, m, d] = inicioDaSemanaApuracao(hoje, diaInicio).split('-').map(Number);
  return paraISO(new Date(a, m - 1, d - 7));
}

function textoDaRecusa(e: unknown): { erro: string; pendentes: AdiantamentosPendentes | null } {
  let pendentes = pendentesDoErro(e);
  // Corrida rara: o RPC de fechar recusa depois do pré-flight e devolve só a contagem por status (sem nomes).
  if (!pendentes && e instanceof AdiantamentosApiError && e.codigo === 'APURACAO_COM_PENDENCIAS' && e.detalhe) {
    pendentes = { total: Object.values(e.detalhe).reduce((a, n) => a + n, 0), porStatus: e.detalhe, motoristas: [], motoristasOmitidos: 0 };
  }
  if (!(e instanceof AdiantamentosApiError)) return { erro: 'Não foi possível gerar os movimentos.', pendentes };
  if (e.codigo === 'PERIODO_EM_ABERTO') {
    const lib = e.corpo?.liberaApos as { data?: string; horario?: string | null } | undefined;
    const data = lib?.data ? formatarISOparaBR(lib.data) : null;
    if (data) {
      const hora = lib?.horario ? ` às ${lib.horario.slice(0, 5)}` : '';
      return { erro: `A semana ainda pode receber pedidos de adiantamento. Volte a partir de ${data}${hora}.`, pendentes };
    }
  }
  return { erro: e.message, pendentes };
}

export function GerarDoRepasseButton({ periodo, onSucesso }: { periodo?: string; onSucesso?: () => void }) {
  const { permissoes } = useHubAuth();
  const pode = permissoes.includes('adiantamentos.pagamento_confirmar');

  const [open, setOpen] = useState(false);
  const [escolhido, setEscolhido] = useState('');
  const [gerando, setGerando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [pendentes, setPendentes] = useState<AdiantamentosPendentes | null>(null);
  const [confirmouNegativo, setConfirmouNegativo] = useState(false);

  const alvo = periodo ?? escolhido;

  // Uma leitura da configuração ao abrir serve a duas coisas: (1) sem `periodo` da tela, o default é a semana anterior à
  // corrente; (2) aviso PROATIVO de modelo de mensagem ausente (a regra não muda: o backend recusa e diz o motivo; aqui só
  // se evita descobrir isso depois de confirmar uma ação irreversível). Falha na leitura = sem aviso, nunca bloqueio.
  const [modeloAusente, setModeloAusente] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    let vivo = true;
    obterConfiguracoes()
      .then((r) => {
        if (!vivo) return;
        setModeloAusente(!!r.vigente && !String(r.vigente.mensagem1Modelo ?? '').trim());
        const dia = r.vigente?.apuracaoDiaInicio;
        if (periodo === undefined && typeof dia === 'number') setEscolhido((atual) => atual || semanaAnterior(new Date(), dia));
      })
      .catch(() => { /* sem configuração o campo fica vazio: o operador escolhe a data */ });
    return () => { vivo = false; };
  }, [open, periodo]);

  const estado = useResumoLancamentoExterno(open ? alvo : '');
  const qtdNeg = estado.resumo?.qtdNegativo;
  const negativoDesconhecido = estado.erro || !estado.resumo || typeof qtdNeg !== 'number';
  const exigeConfirmacao = negativoDesconhecido || qtdNeg > 0;

  const abrir = useCallback(() => {
    setErro(null);
    setPendentes(null);
    setConfirmouNegativo(false);
    setOpen(true);
  }, []);

  const confirmar = useCallback(async () => {
    setGerando(true);
    setErro(null);
    setPendentes(null);
    try {
      const r = await gerarMovimentos(alvo);
      if (r.gerados === 0 && r.recusados.length === 0) {
        toast.info('Nada a gerar nesta apuração.');
      } else {
        const partes = [`${r.gerados} movimento(s) gerado(s)`];
        if (r.semTelefone > 0) partes.push(`${r.semTelefone} sem telefone`);
        if (r.recusados.length > 0) partes.push(`${r.recusados.length} não gerado(s)`);
        toast.success(partes.join(' · '), {
          description: r.recusados.length ? resumirRecusas(r.recusados) : undefined,
          duration: 10000,
        });
      }
      setOpen(false);
      onSucesso?.();
    } catch (e) {
      const t = textoDaRecusa(e);
      setErro(t.erro);
      setPendentes(t.pendentes);
    } finally {
      setGerando(false);
    }
  }, [alvo, onSucesso]);

  if (!pode) return null;

  return (
    <>
      <Button variant="outline" size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={abrir}>
        <FileText className="size-4" aria-hidden="true" />
        Gerar do repasse
      </Button>
      <AlertDialog open={open} onOpenChange={(v) => { if (!gerando) setOpen(v); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Gerar do repasse?</AlertDialogTitle>
            <AlertDialogDescription>
              Fecha a apuração desta semana, se ainda estiver aberta, e cria o movimento de cada motorista no Envio em Massa.
              Fechar não pode ser desfeito.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {periodo === undefined && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="gerar-repasse-periodo">Semana de apuração (início)</Label>
              <Input id="gerar-repasse-periodo" type="date" className="h-11 sm:h-9" value={escolhido} disabled={gerando}
                onChange={(e) => { setEscolhido(e.target.value); setConfirmouNegativo(false); }} />
            </div>
          )}

          {open && modeloAusente && (
            <p role="alert" className="rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-strong">
              O modelo da mensagem ao motorista ainda não está cadastrado na configuração do adiantamento: a geração será
              recusada. Cadastre o modelo antes de gerar.
            </p>
          )}

          {open && <AvisoLancamentoExterno periodo={alvo} estado={estado} />}

          {open && exigeConfirmacao && (
            <label className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-sm">
              <Checkbox
                checked={confirmouNegativo}
                disabled={gerando}
                onCheckedChange={(v) => setConfirmouNegativo(v === true)}
                aria-label="Confirmo o fechamento mesmo com valor negativo que não será pago nem transportado"
              />
              {negativoDesconhecido ? (
                <span>
                  Ainda não sei se algum motorista fecha com valor negativo. Confirmo gerar assim mesmo, <strong>sabendo que
                  um negativo não será pago nem transportado</strong> e que fechar não pode ser desfeito.
                </span>
              ) : (
                <span>
                  Confirmo que {formatBRL(estado.resumo?.totalNegativo ?? 0)} <strong>não serão pagos nem transportados</strong> e
                  que fechar não pode ser desfeito.
                </span>
              )}
            </label>
          )}

          {pendentes && (
            <div role="alert" className="flex flex-col gap-1.5 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-strong">
              <p className="font-medium">Há adiantamentos pendentes nesta semana — nada foi fechado nem gerado.</p>
              <ul className="flex flex-col gap-0.5 pl-4 text-xs">
                {Object.entries(pendentes.porStatus).map(([status, quantidade]) => (
                  <li key={status} className="list-disc">
                    {rotuloStatusAdiantamento(status)}: <span className="font-mono">{quantidade}</span>
                  </li>
                ))}
              </ul>
              {pendentes.motoristas.length > 0 && <p className="text-xs font-medium">Quem está travando:</p>}
              <ul className="flex flex-col gap-0.5 pl-4 text-xs">
                {pendentes.motoristas.map((m, i) => (
                  <li key={`${m.entregadorId}-${m.status}-${i}`} className="list-disc">
                    {m.nome ?? `Motorista ${m.entregadorId}`} — {rotuloStatusAdiantamento(m.status)}
                  </li>
                ))}
                {pendentes.motoristasOmitidos > 0 && <li className="list-disc">e mais {pendentes.motoristasOmitidos}</li>}
              </ul>
              <p className="text-xs">Confirme os pagamentos, reprocesse ou encerre sem pagamento as falhas, depois tente de novo.</p>
            </div>
          )}

          {erro && !pendentes && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
              {erro}
            </p>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={gerando}>Voltar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void confirmar(); }}
              disabled={gerando || !alvo || (exigeConfirmacao && !confirmouNegativo)}
            >
              {gerando && <Loader2 className="mr-2 size-4 motion-safe:animate-spin" aria-hidden="true" />}
              Gerar do repasse
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
