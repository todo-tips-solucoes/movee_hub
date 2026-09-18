'use client';

// hub-avisos (push-motorista, FASE 7 — tasks.md 7.3) — diálogo "Novo aviso":
// título/mensagem com contador (60/180), 3 modos de destinatários (toda a
// base / individual / empresa-filial), prévia de alcance antes do disparo e
// guarda contra clique duplo (CHK011).
//
// Mesmo idioma de `components/hub/import-wizard.tsx` (hook
// `useXxx(onEnviado)` + componente que aceita `state` externo opcional) e de
// `entregador-combobox.tsx` (busca com debounce via Popover+Command).
//
// Ref: docs/specs/envioMassa_homologacao/contracts/hub-avisos.md
// §POST /avisos, §GET /avisos/alcance, §GET /avisos/destinatarios/*,
// tasks.md 7.3, checklists/api.md CHK011.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlertCircle, Loader2, Search, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';
import {
  AvisoApiError,
  buscarMotoristasDestino,
  dispararAviso,
  listarEmpresasDestino,
  obterAlcance,
} from '@/lib/hub/avisos-api';
import {
  MODOS_DESTINATARIOS,
  MODO_DESTINATARIOS_LABELS,
  type AvisoAlcance,
  type EmpresaDestino,
  type ModoDestinatarios,
  type MotoristaDestino,
} from '@/lib/hub/avisos-dto';

const TITULO_MAX = 60;
const CORPO_MAX = 180;
const BUSCA_DEBOUNCE_MS = 300;
const BUSCA_MIN_CHARS = 3;
const ALCANCE_DEBOUNCE_MS = 300;

/** Descrição de cada modo nos radio-cards — copy de UI, vive no componente
 * (mesmo padrão de `TIPO_DESCRICOES` em import-wizard.tsx). */
const MODO_DESCRICOES: Record<ModoDestinatarios, string> = {
  toda_base: 'Todos os motoristas com notificações ativas no momento do disparo.',
  individual: 'Busque e selecione motoristas específicos pelo nome.',
  empresa: 'Selecione uma ou mais empresas do grupo Movee.',
};

/** Lógica isolada do JSX (mesmo padrão de `useImportWizard`) — testável sem
 * depender da interação real com o Dialog (Base UI, portal). */
export function useAvisoDialog(onEnviado?: (id: number) => void) {
  const [open, setOpenState] = useState(false);
  const [titulo, setTitulo] = useState('');
  const [corpo, setCorpo] = useState('');
  const [modo, setModo] = useState<ModoDestinatarios>('toda_base');
  const [individuais, setIndividuais] = useState<MotoristaDestino[]>([]);
  const [empresasSelecionadas, setEmpresasSelecionadas] = useState<EmpresaDestino[]>([]);
  const [empresasDisponiveis, setEmpresasDisponiveis] = useState<EmpresaDestino[]>([]);
  const [carregandoEmpresas, setCarregandoEmpresas] = useState(false);
  const [chaveIdempotencia, setChaveIdempotencia] = useState('');
  const [alcance, setAlcance] = useState<AvisoAlcance | null>(null);
  const [carregandoAlcance, setCarregandoAlcance] = useState(false);
  const [erroAlcance, setErroAlcance] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [erroEnvio, setErroEnvio] = useState<string | null>(null);
  // CHK011 — guarda SÍNCRONA contra clique duplo: `enviando` (state) só
  // reflete no próximo render, e dois cliques na mesma tarefa de evento
  // ainda veriam `enviando === false`. O ref é checado/setado antes de
  // qualquer `await`, garantindo exatamente 1 requisição de rede.
  const enviandoRef = useRef(false);

  const reset = useCallback(() => {
    setTitulo('');
    setCorpo('');
    setModo('toda_base');
    setIndividuais([]);
    setEmpresasSelecionadas([]);
    setAlcance(null);
    setErroAlcance(null);
    setErroEnvio(null);
    setEnviando(false);
    enviandoRef.current = false;
  }, []);

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      if (next) {
        // FR-018/tasks.md 7.3 — "chaveIdempotencia gerada pelo cliente por
        // formulário aberto": 1 chave por abertura, sobrevive a retentativas
        // dentro da MESMA abertura (o backend trata reenvio com a mesma
        // chave como idempotente, sem criar 2º aviso).
        setChaveIdempotencia(crypto.randomUUID());
      } else {
        reset();
      }
    },
    [reset]
  );

  // Empresas do grupo Movee: carregadas 1x quando o modo "empresa" é
  // escolhido pela 1ª vez (fetch preguiçoso — sem custo em toda_base/individual).
  useEffect(() => {
    if (modo !== 'empresa' || empresasDisponiveis.length > 0 || carregandoEmpresas) return;
    setCarregandoEmpresas(true);
    listarEmpresasDestino()
      .then(setEmpresasDisponiveis)
      .catch(() => setEmpresasDisponiveis([]))
      .finally(() => setCarregandoEmpresas(false));
  }, [modo, empresasDisponiveis.length, carregandoEmpresas]);

  const idsSelecionados = useMemo(() => {
    if (modo === 'individual') return individuais.map((m) => m.id);
    if (modo === 'empresa') return empresasSelecionadas.map((e) => e.id);
    return [];
  }, [modo, individuais, empresasSelecionadas]);

  // Prévia de alcance (7.3.3) — recalcula ao trocar modo/seleção, debounced
  // (mesmo espírito do debounce de busca do entregador-combobox).
  useEffect(() => {
    if (!open) return undefined;
    if (modo !== 'toda_base' && idsSelecionados.length === 0) {
      setAlcance(null);
      setErroAlcance(null);
      setCarregandoAlcance(false);
      return undefined;
    }
    setCarregandoAlcance(true);
    setErroAlcance(null);
    const timer = setTimeout(() => {
      obterAlcance({ modo, ids: idsSelecionados })
        .then((a) => {
          setAlcance(a);
          setErroAlcance(null);
        })
        .catch((e) => {
          setAlcance(null);
          setErroAlcance(e instanceof AvisoApiError ? e.message : 'Não foi possível calcular o alcance.');
        })
        .finally(() => setCarregandoAlcance(false));
    }, ALCANCE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, modo, idsSelecionados]);

  const adicionarIndividual = useCallback((m: MotoristaDestino) => {
    setIndividuais((prev) => (prev.some((p) => p.id === m.id) ? prev : [...prev, m]));
  }, []);
  const removerIndividual = useCallback((id: number) => {
    setIndividuais((prev) => prev.filter((p) => p.id !== id));
  }, []);
  const toggleEmpresa = useCallback((e: EmpresaDestino) => {
    setEmpresasSelecionadas((prev) => (prev.some((p) => p.id === e.id) ? prev.filter((p) => p.id !== e.id) : [...prev, e]));
  }, []);

  const tituloValido = titulo.trim().length > 0 && titulo.trim().length <= TITULO_MAX;
  const corpoValido = corpo.trim().length > 0 && corpo.trim().length <= CORPO_MAX;
  const destinatariosValidos = modo === 'toda_base' || idsSelecionados.length > 0;
  // D-15 (FASE 5, 5.3.2): disparo agora só é desabilitado com público TOTAL
  // vazio (SEM_DESTINATARIOS) — 0 inscrições de push não bloqueia mais o
  // disparo, porque o histórico é gravado para todo o público mesmo sem push.
  const podeDisparar =
    tituloValido &&
    corpoValido &&
    destinatariosValidos &&
    !carregandoAlcance &&
    !erroAlcance &&
    alcance !== null &&
    alcance.motoristas > 0 &&
    !enviando;

  const disparar = useCallback(async () => {
    if (enviandoRef.current || !podeDisparar) return;
    enviandoRef.current = true;
    setEnviando(true);
    setErroEnvio(null);
    try {
      const criado = await dispararAviso({
        titulo: titulo.trim(),
        corpo: corpo.trim(),
        modoDestinatarios: modo,
        destinatariosIds: idsSelecionados,
        chaveIdempotencia,
      });
      toast.success('Aviso disparado.');
      setOpen(false);
      onEnviado?.(criado.id);
    } catch (e) {
      setErroEnvio(e instanceof AvisoApiError ? e.message : 'Falha ao disparar o aviso.');
    } finally {
      enviandoRef.current = false;
      setEnviando(false);
    }
  }, [podeDisparar, titulo, corpo, modo, idsSelecionados, chaveIdempotencia, onEnviado, setOpen]);

  return {
    open,
    setOpen,
    titulo,
    setTitulo,
    corpo,
    setCorpo,
    modo,
    setModo,
    individuais,
    adicionarIndividual,
    removerIndividual,
    empresasSelecionadas,
    empresasDisponiveis,
    carregandoEmpresas,
    toggleEmpresa,
    alcance,
    carregandoAlcance,
    erroAlcance,
    tituloValido,
    corpoValido,
    destinatariosValidos,
    podeDisparar,
    enviando,
    erroEnvio,
    disparar,
  };
}

interface BuscaMotoristaMultiSelectProps {
  selecionados: MotoristaDestino[];
  onAdicionar: (m: MotoristaDestino) => void;
  onRemover: (id: number) => void;
  disabled?: boolean;
}

/** Busca de motoristas por nome (mín. 3 caracteres) com seleção múltipla —
 * mesmo idioma Popover+Command+debounce de `EntregadorCombobox`, adaptado
 * para acumular vários selecionados (chips removíveis) em vez de 1. */
function BuscaMotoristaMultiSelect({ selecionados, onAdicionar, onRemover, disabled }: BuscaMotoristaMultiSelectProps) {
  const [busca, setBusca] = useState('');
  const [resultados, setResultados] = useState<MotoristaDestino[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const seqRef = useRef(0);

  const termo = busca.trim();
  const termoValido = termo.length >= BUSCA_MIN_CHARS;

  function aoDigitar(q: string) {
    setBusca(q);
    if (q.trim().length < BUSCA_MIN_CHARS) {
      setResultados([]);
      setErro(null);
      setCarregando(false);
    } else {
      setCarregando(true);
      setErro(null);
    }
  }

  useEffect(() => {
    if (!termoValido) return undefined;
    const meuSeq = ++seqRef.current;
    const timer = setTimeout(() => {
      buscarMotoristasDestino(termo)
        .then((items) => {
          if (seqRef.current !== meuSeq) return; // resposta obsoleta
          setResultados(items);
          setCarregando(false);
        })
        .catch(() => {
          if (seqRef.current !== meuSeq) return;
          setResultados([]);
          setCarregando(false);
          setErro('Não foi possível buscar motoristas. Tente novamente.');
        });
    }, BUSCA_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [termo, termoValido]);

  const jaSelecionado = (id: number) => selecionados.some((s) => s.id === id);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">Motoristas (busque pelo nome)</span>
      <Popover>
        <PopoverTrigger
          render={<Button type="button" variant="outline" size="sm" disabled={disabled} className="min-h-11 w-full justify-start gap-1.5 sm:min-h-9" />}
        >
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {selecionados.length > 0 ? `${selecionados.length} selecionado(s)` : 'Buscar motorista...'}
        </PopoverTrigger>
        <PopoverContent className="w-[320px] p-0" align="start">
          <Command onInputValueChange={aoDigitar}>
            <CommandInput placeholder="Digite ao menos 3 letras do nome..." aria-label="Buscar motorista por nome" />
            <CommandList>
              {!termoValido && (
                <CommandEmpty>
                  {termo.length === 0 ? 'Digite ao menos 3 caracteres para buscar.' : `Faltam ${BUSCA_MIN_CHARS - termo.length} caractere(s) para buscar.`}
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
                <CommandEmpty>Nenhum motorista encontrado.</CommandEmpty>
              )}
              {termoValido &&
                !carregando &&
                !erro &&
                resultados.map((m) => (
                  <CommandItem
                    key={m.id}
                    value={`motorista-${m.id}`}
                    aria-selected={jaSelecionado(m.id)}
                    onClick={() => !jaSelecionado(m.id) && onAdicionar(m)}
                    className={cn('cursor-pointer', jaSelecionado(m.id) && 'bg-accent/20 font-semibold')}
                  >
                    {m.nome}
                    {jaSelecionado(m.id) && <span className="ml-auto text-xs text-muted-foreground">selecionado</span>}
                  </CommandItem>
                ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selecionados.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selecionados.map((m) => (
            <span key={m.id} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
              {m.nome}
              <button
                type="button"
                aria-label={`Remover ${m.nome} dos destinatários`}
                onClick={() => onRemover(m.id)}
                disabled={disabled}
                className="rounded-full hover:bg-muted-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export interface AvisoDialogProps {
  onEnviado?: (id: number) => void;
  /** Gate de permissão (`avisos.enviar`) — resolvido pela página-mãe; o
   * componente não sabe de RBAC, só não renderiza nada sem permissão. */
  podeCriar?: boolean;
  /** Estado externo (mesmo idioma de `ImportWizard`): a página cria o hook e
   * pode reagir ao envio (ex.: navegar para o detalhe). Sem `state`, o
   * componente se auto-gerencia. */
  state?: ReturnType<typeof useAvisoDialog>;
}

export function AvisoDialog({ onEnviado, podeCriar = true, state }: AvisoDialogProps) {
  const interno = useAvisoDialog(onEnviado);
  const d = state ?? interno;
  const inputId = useId();

  if (!podeCriar) return null;

  return (
    <Dialog open={d.open} onOpenChange={d.setOpen}>
      <DialogTrigger render={<Button className="min-h-11 gap-1.5 sm:min-h-8" />}>
        <Send className="size-4" aria-hidden="true" />
        Novo aviso
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Novo aviso</DialogTitle>
          <DialogDescription>Envie uma notificação push para os motoristas do grupo Movee.</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          {/* FR-021 — alerta obrigatório: o texto passa por serviço de terceiro. */}
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs font-medium text-warning-strong"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            O texto passa por um serviço de notificação de terceiro — não inclua dado pessoal.
          </p>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label htmlFor={`${inputId}-titulo`} className="text-sm font-medium">
                Título
              </label>
              <span className={cn('text-xs', d.titulo.length > TITULO_MAX ? 'text-destructive' : 'text-muted-foreground')}>
                {d.titulo.length}/{TITULO_MAX}
              </span>
            </div>
            <Input
              id={`${inputId}-titulo`}
              value={d.titulo}
              maxLength={TITULO_MAX}
              disabled={d.enviando}
              onChange={(e) => d.setTitulo(e.target.value)}
              placeholder="Ex.: Manutenção programada"
            />
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label htmlFor={`${inputId}-corpo`} className="text-sm font-medium">
                Mensagem
              </label>
              <span className={cn('text-xs', d.corpo.length > CORPO_MAX ? 'text-destructive' : 'text-muted-foreground')}>
                {d.corpo.length}/{CORPO_MAX}
              </span>
            </div>
            <textarea
              id={`${inputId}-corpo`}
              value={d.corpo}
              maxLength={CORPO_MAX}
              disabled={d.enviando}
              onChange={(e) => d.setCorpo(e.target.value)}
              rows={3}
              placeholder="Escreva a mensagem que os motoristas vão receber."
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 md:text-sm dark:bg-input/30"
            />
          </div>

          <fieldset className="flex flex-col gap-1" disabled={d.enviando}>
            <legend className="mb-1 text-sm font-medium">Destinatários</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {MODOS_DESTINATARIOS.map((m) => (
                <label
                  key={m}
                  className={cn(
                    'flex cursor-pointer flex-col gap-0.5 rounded-md border p-3 text-sm transition-colors',
                    'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                    d.modo === m ? 'border-primary bg-primary/5' : 'border-input hover:bg-muted/50',
                    d.enviando && 'cursor-not-allowed opacity-60'
                  )}
                >
                  <input
                    type="radio"
                    name={`${inputId}-modo`}
                    value={m}
                    checked={d.modo === m}
                    onChange={() => d.setModo(m)}
                    className="sr-only"
                  />
                  <span className="font-medium">{MODO_DESTINATARIOS_LABELS[m]}</span>
                  <span className="text-xs text-muted-foreground">{MODO_DESCRICOES[m]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {d.modo === 'individual' && (
            <BuscaMotoristaMultiSelect
              selecionados={d.individuais}
              onAdicionar={d.adicionarIndividual}
              onRemover={d.removerIndividual}
              disabled={d.enviando}
            />
          )}

          {d.modo === 'empresa' && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Empresas do grupo Movee</span>
              {d.carregandoEmpresas ? (
                <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
                  Carregando empresas...
                </p>
              ) : d.empresasDisponiveis.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhuma empresa disponível.</p>
              ) : (
                <div className="flex max-h-40 flex-col gap-1.5 overflow-y-auto rounded-md border p-2">
                  {d.empresasDisponiveis.map((emp) => (
                    <label key={emp.id} className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={d.empresasSelecionadas.some((e) => e.id === emp.id)}
                        onChange={() => d.toggleEmpresa(emp)}
                        disabled={d.enviando}
                        className="size-4 rounded border-input"
                      />
                      {emp.nome ?? `Empresa #${emp.id}`}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 7.3.3 — prévia de alcance, atualizada ao trocar modo/seleção. */}
          <div role="status" className="rounded-md border bg-muted/30 p-3 text-sm">
            {d.carregandoAlcance ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
                Calculando alcance...
              </span>
            ) : d.erroAlcance ? (
              <span className="flex items-center gap-2 text-destructive">
                <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                {d.erroAlcance}
              </span>
            ) : d.alcance ? (
              <span>
                <strong className="font-medium text-foreground">{d.alcance.motoristas}</strong> motorista(s) ·{' '}
                <strong className="font-medium text-foreground">{d.alcance.comPush}</strong> com push
                {d.alcance.motoristas === 0 && ' — nenhum motorista corresponde aos destinatários selecionados.'}
                {d.alcance.motoristas > 0 &&
                  d.alcance.comPush === 0 &&
                  ' — ninguém tem push ativo; mesmo assim, o histórico será registrado para todos.'}
              </span>
            ) : (
              <span className="text-muted-foreground">Selecione os destinatários para ver o alcance.</span>
            )}
          </div>

          {d.erroEnvio && (
            <p role="alert" className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              {d.erroEnvio}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" className="min-h-11 sm:min-h-8" disabled={d.enviando} onClick={() => d.setOpen(false)}>
            Cancelar
          </Button>
          {/* CHK011 — desabilitado + estado de carregamento entre clique e
              resposta (impede um 2º clique disparar uma 2ª requisição). */}
          <Button className="min-h-11 sm:min-h-8" disabled={!d.podeDisparar} onClick={d.disparar}>
            {d.enviando ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
            Disparar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default AvisoDialog;
