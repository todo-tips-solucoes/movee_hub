'use client';

// campanhas do motorista (W3a) — formulário de criar/editar RASCUNHO ("HubCriar"
// do protótipo aprovado): 1 identificação e período · 2 público · 3 indicadores
// com peso e corte · 4 prêmios por faixa. Tipo "Melhor extrato" (PLANO-MELHOR-
// EXTRATO E1/E10): o bloco 3 vira "mínimo no turno" (sem peso) e entra o bloco
// "Valor do turno" com o seletor de categorias do faturamento. "Salvar rascunho" grava; "Revisar e
// lançar" grava e abre o diálogo de lançamento. Foto do prêmio sobe DEPOIS de
// salvar (rota própria, corpo binário).

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle, CheckCircle2, ImageIcon, Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { SelectFiltro } from '@/components/hub/select-filtro';
import { SeletorCategorias } from '@/components/hub/seletor-categorias';
import { CampanhaVisibilidade } from '@/components/hub/campanha-visibilidade';
import { CampanhaLancarDialog } from '@/components/hub/campanha-lancar-dialog';
import {
  CampanhaApiError,
  atualizarCampanha,
  criarCampanha,
  enviarFotoPremio,
  lancarCampanha,
  listarCategoriasCampanha,
  obterCampanha,
  obterOpcoes,
  urlFotoPremio,
} from '@/lib/hub/campanhas-api';
import {
  INDICADORES_CAMPANHA,
  ROTULO_INDICADOR_CAMPANHA,
  TIPO_CAMPANHA_LABELS,
  TIPO_PREMIO_LABELS,
  type IndicadorCampanha,
  type OpcoesCampanha,
  type TipoCampanha,
  type TipoPremio,
} from '@/lib/hub/campanhas-dto';
import {
  LIMITES,
  alternarSelecao,
  centavosParaReais,
  erroFoto,
  fechamentoExtrato,
  fracaoParaPercentual,
  hojeSP,
  pedidosBloqueado,
  percentualParaFracao,
  premioVazio,
  reaisParaCentavos,
  somaPesos,
  validarFormulario,
  type ErrosFormulario,
  type FormularioCampanha,
  type PremioForm,
} from '@/lib/hub/campanhas-form';
import type { CategoriaProducao } from '@/lib/hub/adiantamentos-api';
import { cn } from '@/lib/utils';

const CLASSE_CAMPO =
  'w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive md:text-sm dark:bg-input/30';
const CLASSE_INPUT = 'min-h-11 sm:min-h-9';

function Erro({ id, texto }: { id: string; texto?: string }) {
  if (!texto) return null;
  return (
    <p id={id} role="alert" className="flex items-start gap-1.5 text-sm font-medium text-destructive">
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {texto}
    </p>
  );
}

function Secao({ id, titulo, children, acao }: { id: string; titulo: string; children: React.ReactNode; acao?: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="font-heading text-base font-semibold">
          {titulo}
        </h2>
        {acao}
      </div>
      {children}
    </section>
  );
}

/** Multiseleção com "Todas/Todos" (= null) — praça, turno, modal. */
function GrupoSelecao({
  legenda,
  todos,
  opcoes,
  valor,
  onChange,
  erro,
  nota,
}: {
  legenda: string;
  todos: string;
  opcoes: string[];
  valor: string[] | null;
  onChange: (v: string[] | null) => void;
  erro?: string;
  nota?: React.ReactNode;
}) {
  const id = useId();
  // Itens já escolhidos que sumiram das opções (ex.: rascunho antigo) continuam visíveis.
  const itens = [...opcoes, ...(valor ?? []).filter((v) => !opcoes.includes(v))];
  return (
    <fieldset className="flex flex-col gap-1.5" aria-describedby={erro ? `${id}-erro` : undefined}>
      <legend className="mb-1 text-sm font-medium">{legenda}</legend>
      <div className="flex max-h-44 flex-wrap gap-x-4 gap-y-0 overflow-y-auto">
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-8">
          <Checkbox checked={valor === null} onCheckedChange={() => onChange(null)} />
          {todos}
        </label>
        {itens.map((o) => (
          <label key={o} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-8">
            <Checkbox checked={valor?.includes(o) ?? false} onCheckedChange={() => onChange(alternarSelecao(valor, o))} />
            {o}
          </label>
        ))}
      </div>
      {nota && <p className="text-xs text-muted-foreground">{nota}</p>}
      <Erro id={`${id}-erro`} texto={erro} />
    </fieldset>
  );
}

function PremioLinha({
  p,
  campanhaId,
  erros,
  idx,
  onChange,
  onRemover,
  onFoto,
}: {
  p: PremioForm;
  campanhaId: number | null;
  erros: ErrosFormulario;
  idx: number;
  onChange: (campos: Partial<PremioForm>) => void;
  onRemover: () => void;
  onFoto: (f: File | null) => void;
}) {
  const id = useId();
  const [valorTxt, setValorTxt] = useState(centavosParaReais(p.valorCentavos));
  const [fotoErro, setFotoErro] = useState<string | null>(null);
  const [nomeFoto, setNomeFoto] = useState<string | null>(null);
  const num = (v: string) => (v === '' ? Number.NaN : Number(v));
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[6rem_6rem_9rem_1fr]">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-de`} className="text-sm font-medium">Da posição</label>
          <Input id={`${id}-de`} type="number" inputMode="numeric" min={1} max={LIMITES.posicaoMax} className={CLASSE_INPUT}
            value={Number.isNaN(p.posicaoDe) ? '' : p.posicaoDe} aria-invalid={!!erros[`premio.${idx}.faixa`]}
            onChange={(e) => onChange({ posicaoDe: num(e.target.value) })} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-ate`} className="text-sm font-medium">Até a posição</label>
          <Input id={`${id}-ate`} type="number" inputMode="numeric" min={1} max={LIMITES.posicaoMax} className={CLASSE_INPUT}
            value={Number.isNaN(p.posicaoAte) ? '' : p.posicaoAte} aria-invalid={!!erros[`premio.${idx}.faixa`]}
            onChange={(e) => onChange({ posicaoAte: num(e.target.value) })} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-tipo`} className="text-sm font-medium">Tipo</label>
          <SelectFiltro id={`${id}-tipo`} ariaLabel="Tipo do prêmio" value={p.tipo}
            onChange={(v) => onChange({ tipo: v as TipoPremio })}
            opcoes={(Object.keys(TIPO_PREMIO_LABELS) as TipoPremio[]).map((t) => ({ value: t, label: TIPO_PREMIO_LABELS[t] }))} />
        </div>
        <div className="col-span-2 flex flex-col gap-1 sm:col-span-1">
          <label htmlFor={`${id}-desc`} className="text-sm font-medium">Descrição do prêmio</label>
          <Input id={`${id}-desc`} className={CLASSE_INPUT} maxLength={LIMITES.descricaoPremioMax} value={p.descricao}
            placeholder={p.tipo === 'dinheiro' ? 'Ex.: R$ 100 no repasse' : 'Ex.: Bag térmica Movee'}
            aria-invalid={!!erros[`premio.${idx}.descricao`]} onChange={(e) => onChange({ descricao: e.target.value })} />
        </div>
      </div>
      <Erro id={`${id}-e1`} texto={erros[`premio.${idx}.faixa`] ?? erros[`premio.${idx}.descricao`]} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-valor`} className="text-sm font-medium">
            {p.tipo === 'dinheiro' ? 'Valor por pessoa (R$)' : 'Valor estimado (R$, opcional)'}
          </label>
          <Input id={`${id}-valor`} inputMode="decimal" className={CLASSE_INPUT} value={valorTxt} placeholder="0,00"
            aria-invalid={!!erros[`premio.${idx}.valor`]}
            onChange={(e) => {
              setValorTxt(e.target.value);
              onChange({ valorCentavos: reaisParaCentavos(e.target.value) });
            }} />
          {p.tipo === 'dinheiro' && (
            <p className="text-xs text-muted-foreground">Pago pelo Lançamento externo, por planilha gerada depois do encerramento.</p>
          )}
          <Erro id={`${id}-e2`} texto={erros[`premio.${idx}.valor`]} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-foto`} className="flex items-center gap-1.5 text-sm font-medium">
            <ImageIcon className="size-4" aria-hidden="true" />
            Foto do prêmio (opcional)
          </label>
          {p.id !== null && p.temFoto && campanhaId !== null && !nomeFoto && (
            // eslint-disable-next-line @next/next/no-img-element -- foto servida pela própria API, com cookie de sessão
            <img src={urlFotoPremio(campanhaId, p.id)} alt={`Foto atual: ${p.descricao || 'prêmio'}`} className="h-16 w-16 rounded-md object-cover" />
          )}
          <input id={`${id}-foto`} type="file" accept="image/jpeg,image/png,image/webp"
            className="min-h-11 rounded-md border border-input bg-background px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm sm:min-h-9"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              const err = f ? erroFoto(f) : null;
              setFotoErro(err);
              setNomeFoto(f && !err ? f.name : null);
              onFoto(f && !err ? f : null);
              if (err) e.target.value = '';
            }} />
          <p className="text-xs text-muted-foreground">JPEG, PNG ou WebP, até 500 KB. Sem foto, aparece o ícone do tipo.</p>
          <Erro id={`${id}-e3`} texto={fotoErro ?? undefined} />
        </div>
      </div>
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={onRemover}>
          <Trash2 className="size-4" aria-hidden="true" />
          Remover faixa
        </Button>
      </div>
    </li>
  );
}

interface Props {
  /** null = nova campanha; número = rascunho existente. */
  campanhaId: number | null;
  inicial: FormularioCampanha;
}

export function CampanhaFormulario({ campanhaId, inicial }: Props) {
  const router = useRouter();
  const [form, setForm] = useState<FormularioCampanha>(inicial);
  const [id, setId] = useState<number | null>(campanhaId);
  const [opcoes, setOpcoes] = useState<OpcoesCampanha | null>(null);
  const [opcoesErro, setOpcoesErro] = useState<string | null>(null);
  const [cortesTxt, setCortesTxt] = useState<Record<IndicadorCampanha, string>>(() => ({
    aceitacao: fracaoParaPercentual(inicial.cortes.aceitacao),
    conclusao: fracaoParaPercentual(inicial.cortes.conclusao),
    tempo: fracaoParaPercentual(inicial.cortes.tempo),
    pedidos: inicial.cortes.pedidos === null ? '' : String(inicial.cortes.pedidos),
  }));
  // Extrato: o indicador "marcado" ainda sem mínimo digitado não existe no modelo (corte null).
  const [marcados, setMarcados] = useState<Record<IndicadorCampanha, boolean>>(() => ({
    aceitacao: inicial.cortes.aceitacao !== null,
    conclusao: inicial.cortes.conclusao !== null,
    tempo: inicial.cortes.tempo !== null,
    pedidos: inicial.cortes.pedidos !== null,
  }));
  const [categorias, setCategorias] = useState<CategoriaProducao[] | null>(null);
  const [categoriasErro, setCategoriasErro] = useState<string | null>(null);
  const [erros, setErros] = useState<ErrosFormulario>({});
  const [erroGeral, setErroGeral] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [lancarAberto, setLancarAberto] = useState(false);
  const fotos = useRef<Map<string, File>>(new Map());
  const baseId = useId();

  const set = useCallback((campos: Partial<FormularioCampanha>) => setForm((f) => ({ ...f, ...campos })), []);

  // Opções (e cobertura/alcance) dependem da seleção atual de praça/turno/modal.
  const chaveSelecao = JSON.stringify([form.pracas, form.turnos, form.modais]);
  useEffect(() => {
    let vivo = true;
    const t = setTimeout(() => {
      obterOpcoes({ pracas: form.pracas, turnos: form.turnos, modais: form.modais })
        .then((o) => {
          if (!vivo) return;
          setOpcoes(o);
          setOpcoesErro(null);
        })
        .catch((e) => {
          if (vivo) setOpcoesErro(e instanceof CampanhaApiError ? e.message : 'Não foi possível carregar as opções.');
        });
    }, 250);
    return () => {
      vivo = false;
      clearTimeout(t);
    };
    // chaveSelecao resume pracas/turnos/modais
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaveSelecao]);

  const extrato = form.tipo === 'extrato';

  // Categorias só importam (e só são pedidas) no extrato.
  useEffect(() => {
    if (!extrato || categorias !== null) return;
    let vivo = true;
    listarCategoriasCampanha()
      .then((c) => {
        if (vivo) setCategorias(c);
      })
      .catch((e) => {
        if (vivo) setCategoriasErro(e instanceof CampanhaApiError ? e.message : 'Não foi possível carregar as categorias.');
      });
    return () => {
      vivo = false;
    };
  }, [extrato, categorias]);

  const cobertura = opcoes?.coberturaPedidos ?? null;
  const pedidosOff = !extrato && opcoes !== null && pedidosBloqueado(cobertura);
  const soma = somaPesos(form.pesos);

  function trocarTipo(tipo: TipoCampanha) {
    if (tipo === form.tipo) return;
    // Os dois tipos não compartilham critério nem valor: recomeça os blocos que diferem.
    set({
      tipo,
      pesos: { aceitacao: 0, conclusao: 0, tempo: 0, pedidos: 0 },
      cortes: { aceitacao: null, conclusao: null, tempo: null, pedidos: null },
      categorias: [],
      minTurnosBase: tipo === 'extrato' ? 'validos' : 'trabalhados',
    });
    setCortesTxt({ aceitacao: '', conclusao: '', tempo: '', pedidos: '' });
    setMarcados({ aceitacao: false, conclusao: false, tempo: false, pedidos: false });
  }
  function alternarCriterio(i: IndicadorCampanha, ligado: boolean) {
    setMarcados((m) => ({ ...m, [i]: ligado }));
    if (!ligado) {
      set({ cortes: { ...form.cortes, [i]: null } });
      setCortesTxt((t) => ({ ...t, [i]: '' }));
    }
  }
  function setPeso(i: IndicadorCampanha, v: number) {
    set({ pesos: { ...form.pesos, [i]: v } });
  }
  function alternarIndicador(i: IndicadorCampanha, ligado: boolean) {
    if (ligado) setPeso(i, soma < 100 ? 100 - soma : 10);
    else {
      set({ pesos: { ...form.pesos, [i]: 0 }, cortes: { ...form.cortes, [i]: null } });
      setCortesTxt((t) => ({ ...t, [i]: '' }));
    }
  }
  function setCorte(i: IndicadorCampanha, txt: string) {
    setCortesTxt((t) => ({ ...t, [i]: txt }));
    const valor = i === 'pedidos' ? (txt.trim() === '' ? null : Number(txt)) : percentualParaFracao(txt);
    set({ cortes: { ...form.cortes, [i]: valor } });
  }
  function setPremio(chave: string, campos: Partial<PremioForm>) {
    set({ premios: form.premios.map((p) => (p.chave === chave ? { ...p, ...campos } : p)) });
  }
  function adicionarFaixa() {
    const prox = form.premios.reduce((m, p) => Math.max(m, Number.isNaN(p.posicaoAte) ? 0 : p.posicaoAte), 0) + 1;
    set({ premios: [...form.premios, premioVazio(prox)] });
  }

  /** Valida, grava (POST/PUT) e sobe as fotos novas. Devolve o id, ou null se algo falhou. */
  async function gravar(paraLancar: boolean): Promise<number | null> {
    const e = validarFormulario(form, { hoje: hojeSP(), coberturaPedidos: cobertura, paraLancar });
    setErros(e);
    setErroGeral(null);
    if (Object.keys(e).length > 0) {
      setErroGeral('Corrija os campos destacados antes de continuar.');
      return null;
    }
    setSalvando(true);
    try {
      const salvoId = id === null ? await criarCampanha(form) : await atualizarCampanha(id, form);
      setId(salvoId);
      if (fotos.current.size > 0) {
        // O POST/PUT só devolve o id: relê para casar cada foto com o prêmio pela posição inicial.
        const det = await obterCampanha(salvoId);
        for (const p of form.premios) {
          const arquivo = fotos.current.get(p.chave);
          const salvo = det.premios.find((x) => x.posicaoDe === p.posicaoDe);
          if (arquivo && salvo) {
            await enviarFotoPremio(salvoId, salvo.id, arquivo);
            fotos.current.delete(p.chave);
          }
        }
      }
      return salvoId;
    } catch (err) {
      setErroGeral(err instanceof CampanhaApiError ? err.message : 'Não foi possível salvar a campanha.');
      return null;
    } finally {
      setSalvando(false);
    }
  }

  async function salvarRascunho() {
    const salvoId = await gravar(false);
    if (salvoId !== null) {
      toast.success('Rascunho salvo.');
      router.push('/hub/dashboard/campanhas');
    }
  }

  async function revisar() {
    const salvoId = await gravar(true);
    if (salvoId !== null) setLancarAberto(true);
  }

  async function lancar(avisar: boolean) {
    if (id === null) return;
    if (avisar !== form.avisar) await atualizarCampanha(id, { ...form, avisar });
    await lancarCampanha(id);
    toast.success('Campanha lançada.');
    router.push(`/hub/dashboard/campanhas/${id}`);
  }

  const ind = (i: IndicadorCampanha) => ({ ligado: extrato ? marcados[i] : form.pesos[i] > 0, rotulo: ROTULO_INDICADOR_CAMPANHA[i] });
  const regra: Record<IndicadorCampanha, string> = {
    aceitacao: 'Aceitas ÷ ofertadas. 85% vira nota 85.',
    conclusao: 'Completadas ÷ aceitas. 97% vira nota 97.',
    tempo: 'Tempo online ÷ duração do turno.',
    pedidos: 'Relativo ao líder: quem fez mais vira nota 100.',
  };
  const regraTurno: Record<IndicadorCampanha, string> = {
    aceitacao: 'Aceitas ÷ ofertadas daquele turno.',
    conclusao: 'Completadas ÷ aceitas daquele turno.',
    tempo: 'Tempo online ÷ duração daquele turno.',
    pedidos: 'Pedidos do turno. Turno sem a leitura não vale (zero inventado nunca conta).',
  };
  const fechaEm = fechamentoExtrato(form.dataFim);
  const n = (base: number) => (extrato ? base + 1 : base);

  return (
    <>
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(ev) => {
        ev.preventDefault();
        void revisar();
      }}
    >
      <Secao id={`${baseId}-tipo`} titulo="Tipo de campanha">
        <div role="radiogroup" aria-labelledby={`${baseId}-tipo`} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(['nota', 'extrato'] as TipoCampanha[]).map((t) => (
            <label key={t} className={cn('flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3',
              form.tipo === t ? 'border-primary bg-primary/10' : 'hover:bg-muted/50')}>
              <input type="radio" name={`${baseId}-tipo`} className="mt-1 size-4 accent-primary" checked={form.tipo === t}
                onChange={() => trocarTipo(t)} />
              <span className="flex flex-col gap-0.5">
                <strong className="text-sm">{TIPO_CAMPANHA_LABELS[t]}</strong>
                <span className="text-xs text-muted-foreground">
                  {t === 'nota'
                    ? 'Média dos indicadores no período, com peso por indicador. Ganha a maior nota.'
                    : 'Turno que cumpre os critérios soma o valor do faturamento daquele turno. Ganha a maior soma.'}
                </span>
              </span>
            </label>
          ))}
        </div>
      </Secao>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Secao id={`${baseId}-id`} titulo="1. Identificação e período">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${baseId}-nome`} className="text-sm font-medium">Nome da campanha</label>
            <Input id={`${baseId}-nome`} className={CLASSE_INPUT} maxLength={LIMITES.nomeMax} value={form.nome}
              aria-invalid={!!erros.nome} onChange={(e) => set({ nome: e.target.value })} />
            <Erro id={`${baseId}-nome-e`} texto={erros.nome} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${baseId}-desc`} className="text-sm font-medium">Regras e descrição (o motorista vê este texto)</label>
            <textarea id={`${baseId}-desc`} rows={3} maxLength={LIMITES.descricaoMax} value={form.descricao}
              aria-invalid={!!erros.descricao} className={CLASSE_CAMPO} onChange={(e) => set({ descricao: e.target.value })} />
            <Erro id={`${baseId}-desc-e`} texto={erros.descricao} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor={`${baseId}-ini`} className="text-sm font-medium">Início</label>
              <Input id={`${baseId}-ini`} type="date" className={CLASSE_INPUT} value={form.dataInicio}
                aria-invalid={!!erros.dataInicio} onChange={(e) => set({ dataInicio: e.target.value })} />
              <Erro id={`${baseId}-ini-e`} texto={erros.dataInicio} />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={`${baseId}-fim`} className="text-sm font-medium">Fim</label>
              <Input id={`${baseId}-fim`} type="date" className={CLASSE_INPUT} value={form.dataFim}
                aria-invalid={!!erros.dataFim} onChange={(e) => set({ dataFim: e.target.value })} />
              <Erro id={`${baseId}-fim-e`} texto={erros.dataFim} />
            </div>
          </div>
          {extrato ? (
            <p className="text-xs text-muted-foreground">
              O faturamento chega com 1 a 2 dias de atraso. O resultado final fecha sozinho{' '}
              <strong>3 dias depois do fim</strong>{fechaEm ? ` (${fechaEm})` : ''}, quando ~97% do valor já entrou.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Os dados chegam com 1 dia de atraso (importação diária da EntreGô). O resultado final fecha sozinho quando a
              importação do último dia da campanha entrar.
            </p>
          )}
        </Secao>

        <Secao id={`${baseId}-pub`} titulo="2. Quem participa">
          {opcoesErro && <Erro id={`${baseId}-op-e`} texto={opcoesErro} />}
          <GrupoSelecao legenda="Praças" todos="Todas" opcoes={opcoes?.pracas ?? []} valor={form.pracas}
            onChange={(v) => set({ pracas: v })} erro={erros.pracas} />
          <GrupoSelecao legenda="Turnos (nomes como vêm na importação)" todos="Todos" opcoes={opcoes?.turnos ?? []}
            valor={form.turnos} onChange={(v) => set({ turnos: v })} erro={erros.turnos} />
          <GrupoSelecao legenda="Modal (do cadastro EntreGô)" todos="Todos" opcoes={opcoes?.modais ?? []}
            valor={form.modais} onChange={(v) => set({ modais: v })} erro={erros.modais}
            nota={form.modais !== null && opcoes && opcoes.alcance.semModal > 0
              ? `${opcoes.alcance.semModal} motoristas desse público ainda não têm modal no cadastro e ficam de fora.`
              : undefined} />
          {opcoes && (
            <p role="status" className="text-sm text-muted-foreground">
              {opcoes.alcance.rodaram} motoristas rodaram nesse público nos últimos 30 dias.
            </p>
          )}
          <div className="flex flex-col gap-1">
            <label htmlFor={`${baseId}-min`} className="text-sm font-medium">
              {extrato ? 'Mínimo de turnos para entrar no ranking' : 'Mínimo de turnos trabalhados para entrar no ranking'}
            </label>
            <Input id={`${baseId}-min`} type="number" inputMode="numeric" min={LIMITES.minTurnosMin} max={LIMITES.minTurnosMax}
              className={cn(CLASSE_INPUT, 'sm:w-32')} value={Number.isNaN(form.minTurnos) ? '' : form.minTurnos}
              aria-invalid={!!erros.minTurnos} onChange={(e) => set({ minTurnos: e.target.value === '' ? Number.NaN : Number(e.target.value) })} />
            {extrato ? (
              <fieldset className="flex flex-col gap-1">
                <legend className="sr-only">Base do mínimo de turnos</legend>
                <div className="flex flex-wrap gap-x-4">
                  {([['validos', 'turnos válidos'], ['trabalhados', 'turnos trabalhados']] as const).map(([v, r]) => (
                    <label key={v} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-8">
                      <input type="radio" name={`${baseId}-base`} className="size-4 accent-primary" checked={form.minTurnosBase === v}
                        onChange={() => set({ minTurnosBase: v })} />
                      {r}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">Válido = turno que cumpriu todos os critérios marcados abaixo.</p>
              </fieldset>
            ) : (
              <p className="text-xs text-muted-foreground">Impede que quem fez um turno só apareça com 100%.</p>
            )}
            <Erro id={`${baseId}-min-e`} texto={erros.minTurnos} />
          </div>
        </Secao>
      </div>

      <Secao
        id={`${baseId}-ind`}
        titulo={extrato ? '3. Critérios do turno (mínimo em cada turno)' : '3. Indicadores, pesos e corte mínimo'}
        acao={extrato ? undefined : (
          <span
            role="status"
            className={cn('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold',
              soma === 100 ? 'bg-success/10 text-success' : 'bg-warning/15 text-warning-strong')}
          >
            {soma === 100 ? <CheckCircle2 className="size-4" aria-hidden="true" /> : <AlertCircle className="size-4" aria-hidden="true" />}
            Soma dos pesos: {soma}%
          </span>
        )}
      >
        {extrato ? (
          <p className="text-sm text-muted-foreground">
            Os mesmos indicadores da Performance, conferidos <strong>turno a turno</strong>. O turno só vale se cumprir{' '}
            <strong>todos</strong> os marcados. Não há peso: o que ordena o ranking é o valor somado.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Cada indicador marcado vira uma nota de 0 a 100. A nota final é a média ponderada pelos pesos. Quem ficar abaixo
            do <strong>corte mínimo</strong> de qualquer indicador sai do ranking (e vê o quanto falta para voltar).
          </p>
        )}
        <ul className="flex flex-col gap-3">
          {INDICADORES_CAMPANHA.map((i) => {
            const { ligado, rotulo } = ind(i);
            const bloqueado = i === 'pedidos' && pedidosOff && !ligado;
            return (
              <li key={i} className={cn('grid grid-cols-1 items-start gap-3 rounded-lg border p-3',
                extrato ? 'sm:grid-cols-[14rem_11rem_1fr]' : 'sm:grid-cols-[14rem_7rem_11rem_1fr]')}>
                <label className={cn('flex min-h-11 items-center gap-2 text-sm font-medium', bloqueado ? 'cursor-not-allowed opacity-70' : 'cursor-pointer')}>
                  <Checkbox checked={ligado} disabled={bloqueado}
                    onCheckedChange={(v) => (extrato ? alternarCriterio(i, v === true) : alternarIndicador(i, v === true))} />
                  {rotulo}
                </label>
                {!extrato && (
                <div className="flex flex-col gap-1">
                  <label htmlFor={`${baseId}-peso-${i}`} className="text-xs font-medium text-muted-foreground">Peso (%) — {rotulo}</label>
                  <Input id={`${baseId}-peso-${i}`} type="number" inputMode="numeric" min={0} max={100} className={CLASSE_INPUT}
                    disabled={!ligado} value={Number.isNaN(form.pesos[i]) ? '' : form.pesos[i]}
                    aria-invalid={!!erros['pesos.' + i]}
                    onChange={(e) => setPeso(i, e.target.value === '' ? Number.NaN : Number(e.target.value))} />
                </div>
                )}
                <div className="flex flex-col gap-1">
                  <label htmlFor={`${baseId}-corte-${i}`} className="text-xs font-medium text-muted-foreground">
                    {extrato ? 'Mínimo no turno' : 'Corte mínimo'} ({i === 'pedidos' ? 'pedidos' : '%'}) — {rotulo}
                  </label>
                  <Input id={`${baseId}-corte-${i}`} inputMode="decimal" className={CLASSE_INPUT} disabled={!ligado}
                    placeholder={extrato ? 'mínimo' : 'sem corte'} value={cortesTxt[i]} aria-invalid={!!erros['corte.' + i]}
                    onChange={(e) => setCorte(i, e.target.value)} />
                </div>
                <p className="text-xs text-muted-foreground sm:pt-6">
                  {extrato ? regraTurno[i] : regra[i]}
                  {!extrato && i === 'pedidos' && (
                    <>
                      {' '}
                      {opcoes === null
                        ? 'Calculando a cobertura do dado neste público…'
                        : cobertura === null
                          ? 'Sem dado de pedidos neste público: indicador indisponível.'
                          : `Cobertura do dado neste público: ${Math.round(cobertura * 100)}%.`}
                      {bloqueado && cobertura !== null && ' Abaixo de 95%, este indicador fica desabilitado.'}
                    </>
                  )}
                </p>
                <div className="sm:col-span-4">
                  <Erro id={`${baseId}-ie-${i}`} texto={erros['pesos.' + i] ?? erros['corte.' + i]} />
                </div>
              </li>
            );
          })}
        </ul>
        <Erro id={`${baseId}-pesos-e`} texto={erros.pesos} />
        <Erro id={`${baseId}-cortes-e`} texto={erros.cortes} />
      </Secao>

      {extrato && (
        <Secao id={`${baseId}-cat`} titulo="4. Valor do turno: categorias do faturamento">
          <p className="text-sm text-muted-foreground">
            Soma dos créditos do Financeiro do motorista naquele dia (data de referência) e turno, nas categorias marcadas.
            Mesmo seletor das Configurações do adiantamento.
          </p>
          <SeletorCategorias
            titulo="Categorias do faturamento"
            textoVazio={categoriasErro ?? (categorias === null ? 'Carregando categorias…' : 'Nenhuma categoria com turno encontrada nos últimos 90 dias.')}
            disponiveis={categorias ?? []}
            selecionadas={form.categorias}
            onChange={(c) => set({ categorias: c })}
            aviso="Nenhuma categoria marcada: o valor do turno ficaria zerado."
          />
          <p className="text-xs text-muted-foreground">
            Só aparecem categorias que têm turno no faturamento. Gorjeta, por exemplo, vem sem turno e não pode ser atribuída a um.
          </p>
          <Erro id={`${baseId}-cat-e`} texto={erros.categorias} />
        </Secao>
      )}

      <Secao
        id={`${baseId}-pre`}
        titulo={`${n(4)}. Prêmios por faixa de posição`}
        acao={
          <Button type="button" variant="outline" size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={adicionarFaixa}
            disabled={form.premios.length >= LIMITES.premiosMax}>
            <Plus className="size-4" aria-hidden="true" />
            Adicionar faixa
          </Button>
        }
      >
        {form.premios.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma faixa ainda: adicione ao menos uma.</p>}
        <ul className="flex flex-col gap-3">
          {form.premios.map((p, idx) => (
            <PremioLinha key={p.chave} p={p} idx={idx} erros={erros} campanhaId={id}
              onChange={(c) => setPremio(p.chave, c)}
              onRemover={() => {
                fotos.current.delete(p.chave);
                set({ premios: form.premios.filter((x) => x.chave !== p.chave) });
              }}
              onFoto={(f) => (f ? fotos.current.set(p.chave, f) : fotos.current.delete(p.chave))} />
          ))}
        </ul>
        <Erro id={`${baseId}-pre-e`} texto={erros.premios} />
      </Secao>

      <Secao id={`${baseId}-vis`} titulo={`${n(5)}. Visibilidade no app`}>
        <CampanhaVisibilidade visivel={form.visivelApp} onChange={(v) => set({ visivelApp: v })} />
      </Secao>

      {erroGeral && (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {erroGeral}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-3">
        <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={salvando} onClick={() => void salvarRascunho()}>
          {salvando && <Loader2 className="mr-2 size-4 motion-safe:animate-spin" aria-hidden="true" />}
          Salvar rascunho
        </Button>
        {/* Sem as opções (cobertura de pedidos) a validação de lançar leria cobertura nula e
            recusaria "Pedidos" por engano — achado do E2E W4. Fail-closed enquanto carregam. */}
        <Button type="submit" className="min-h-11 sm:min-h-8" disabled={salvando || opcoes === null}>
          Revisar e lançar
        </Button>
      </div>

    </form>
    <CampanhaLancarDialog open={lancarAberto} onOpenChange={setLancarAberto} form={form}
      alcance={opcoes ? opcoes.alcance : null} onLancar={lancar} />
    </>
  );
}
