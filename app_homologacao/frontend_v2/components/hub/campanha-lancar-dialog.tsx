'use client';

// campanhas do motorista (W3a) — diálogo de lançamento ("HubConfirmar" do
// protótipo aprovado). Lançar é irreversível (o banco recusa qualquer edição
// depois), então o botão só habilita com a caixa "Revisei tudo…" marcada. O
// estado vive no filho de `DialogContent`, que desmonta ao fechar: cada
// abertura começa com a caixa desmarcada.

import { useRef, useState } from 'react';
import { AlertCircle, Loader2, Lock, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CampanhaApiError } from '@/lib/hub/campanhas-api';
import { formatCentavos, formatDiaMes, resumoPesos, rotuloFaixa, type FormularioCampanha } from '@/lib/hub/campanhas-form';

export interface AlcanceLancamento {
  rodaram: number;
  semModal: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: FormularioCampanha;
  alcance: AlcanceLancamento | null;
  /** Lança a campanha (o chamador grava `avisar` antes, se mudou). Rejeita com `CampanhaApiError`. */
  onLancar: (avisar: boolean) => Promise<void>;
}

const lista = (v: string[] | null, todos: string) => (v === null ? todos : v.join(', '));

function diasDe(inicio: string, fim: string) {
  const t = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((t(fim) - t(inicio)) / 86_400_000) + 1;
}

function Linha({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-[7rem_1fr] sm:gap-3">
      <dt className="text-xs font-medium text-muted-foreground sm:text-sm">{rotulo}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function Conteudo({ form, alcance, onLancar, onOpenChange }: Omit<Props, 'open'>) {
  const [avisar, setAvisar] = useState(form.avisar);
  const [confirmo, setConfirmo] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // Guarda síncrona contra clique duplo (o state só reflete no próximo render).
  const emVoo = useRef(false);

  async function lancar() {
    if (emVoo.current || !confirmo) return;
    emVoo.current = true;
    setEnviando(true);
    setErro(null);
    try {
      await onLancar(avisar);
    } catch (e) {
      setErro(e instanceof CampanhaApiError ? e.message : 'Não foi possível lançar a campanha.');
      emVoo.current = false;
      setEnviando(false);
    }
  }

  const fimFmt = form.dataFim ? formatDiaMes(form.dataFim, true) : '—';
  return (
    <>
      <DialogHeader>
        <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Lock className="size-5" aria-hidden="true" />
        </div>
        <DialogTitle>Lançar “{form.nome.trim()}”?</DialogTitle>
        <DialogDescription className="sr-only">Revise o resumo e confirme o lançamento.</DialogDescription>
      </DialogHeader>

      <div
        role="note"
        className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-sm text-warning-strong"
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>
          <strong>Depois de lançada, a campanha não pode ser alterada.</strong> Período, praças, turnos, indicadores,
          pesos, cortes e prêmios ficam travados. Se precisar mudar algo, a saída é cancelar (com motivo registrado) e
          lançar outra.
        </p>
      </div>

      <dl className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto">
        <Linha rotulo="Período">
          {formatDiaMes(form.dataInicio)} a {fimFmt} ({diasDe(form.dataInicio, form.dataFim)} dias)
        </Linha>
        <Linha rotulo="Praças">{lista(form.pracas, 'Todas as praças')}</Linha>
        <Linha rotulo="Turnos">
          {lista(form.turnos, 'Todos os turnos')} · mín. {form.minTurnos} turnos
        </Linha>
        <Linha rotulo="Modal">
          {lista(form.modais, 'Todos os modais')}
          {alcance && alcance.semModal > 0 && (
            <span className="font-medium text-warning-strong">
              {' '}
              · {alcance.semModal} sem modal no cadastro ficam de fora
            </span>
          )}
        </Linha>
        <Linha rotulo="Nota">{resumoPesos(form.pesos, form.cortes)}</Linha>
        <Linha rotulo="Prêmios">
          {form.premios
            .map(
              (p) =>
                `${rotuloFaixa(p.posicaoDe, p.posicaoAte)} ${p.descricao.trim()}${p.tipo === 'dinheiro' ? ` (${formatCentavos(p.valorCentavos)})` : ''}`
            )
            .join(' · ')}
        </Linha>
        {alcance && (
          <Linha rotulo="Alcance hoje">
            {alcance.rodaram} motoristas rodaram nesses turnos nos últimos 30 dias
          </Linha>
        )}
      </dl>

      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
        <Checkbox checked={avisar} onCheckedChange={(v) => setAvisar(v === true)} disabled={enviando} />
        <span>Avisar os motoristas por notificação quando a campanha começar</span>
      </label>
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium">
        <Checkbox checked={confirmo} onCheckedChange={(v) => setConfirmo(v === true)} disabled={enviando} />
        <span>Revisei tudo e entendo que não vou poder editar depois de lançar.</span>
      </label>

      {erro && (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {erro}
        </p>
      )}

      <DialogFooter>
        <Button variant="outline" className="min-h-11 sm:min-h-8" onClick={() => onOpenChange(false)} disabled={enviando}>
          Voltar e editar
        </Button>
        <Button className="min-h-11 sm:min-h-8" onClick={lancar} disabled={!confirmo || enviando}>
          {enviando && <Loader2 className="mr-2 size-4 motion-safe:animate-spin" aria-hidden="true" />}
          Lançar campanha
        </Button>
      </DialogFooter>
    </>
  );
}

export function CampanhaLancarDialog({ open, onOpenChange, form, alcance, onLancar }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <Conteudo form={form} alcance={alcance} onLancar={onLancar} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}
