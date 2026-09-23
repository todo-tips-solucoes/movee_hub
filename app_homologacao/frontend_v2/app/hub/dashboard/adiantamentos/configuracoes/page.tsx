'use client';

// adiantamento-motorista — app/hub/dashboard/adiantamentos/configuracoes/page.tsx
// (tasks.md 7.4, H03-H05): formulário de todos os parâmetros de FR-021
// (janela de solicitação, cálculo, pagamento, remanescente semanal),
// histórico de versões (somente leitura) e tratamento explícito do conflito
// 409 VERSAO_DESATUALIZADA (FR-023, CHK013) — o formulário NUNCA perde o que
// foi digitado quando o conflito acontece.
//
// Visualização: `adiantamentos.consultar` (aba já gateada por 7.2.1).
// Edição/salvar: `adiantamentos.configurar` — sem essa permissão os campos
// são somente leitura (mesmo padrão `podeEditar` de
// `credencial-motorista-dialog.tsx`).
//
// Validações client-side espelham as CHECK constraints reais de
// `infra/hub/migrations/0066_adiantamento_tabelas.sql`
// ("AdiantamentoConfiguracao") — nunca inventadas: horário abertura < corte,
// percentual (0,100], taxa >= 0, previsão 1-120 chars, descrição Pix precisa
// conter literalmente "{nome}", categorias obrigatórias quando a fonte é
// financeiro_lancamento/financeiro_referencia.
//
// Ref: docs/specs/adiantamento-motorista/contracts/hub-api.md §Configurações;
// prototipo H03-H05.

import { useCallback, useEffect, useId, useState } from 'react';
import { AlertCircle, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { useHubAuth } from '@/contexts/hub-auth-context';
import {
  AdiantamentosApiError,
  obterConfiguracoes,
  listarCategoriasProducao,
  salvarConfiguracao,
  type CategoriaProducao,
  type Configuracao,
  type ConfiguracaoHistoricoItem,
} from '@/lib/hub/adiantamentos-api';
import { filtrarItensCategoria, montarItensCategoria, type ItemCategoria, restringirAoExtrato } from '@/lib/hub/adiantamento-categorias';
import { diaDoRepasse, diasAteRepasse } from '@/lib/hub/adiantamento-repasse';
import { LARGURA_DETALHE } from '@/lib/hub/larguras';
import { cn, formatDateBR } from '@/lib/utils';

// domingo..sábado (0..6) — mesma convenção de `dias_habilitados`
// (backend/lib/adiantamento-regras.js: `getUTCDay()`, NOMES_DIA).
const NOMES_DIA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

const FONTES_PRODUCAO: { valor: string; rotulo: string }[] = [
  { valor: 'financeiro_lancamento', rotulo: 'Financeiro por data de lançamento' },
  { valor: 'financeiro_referencia', rotulo: 'Financeiro por competência' },
  { valor: 'performance_taxas', rotulo: 'Performance (taxas aceitas)' },
];

// mesmo conjunto de `apuracao_data_base` (migrations/0066).
const BASES_DATA_REPASSE: { valor: string; rotulo: string }[] = [
  { valor: 'data_lancamento', rotulo: 'Data de lançamento' },
  { valor: 'data_referencia', rotulo: 'Data de referência' },
];

interface FormState {
  diasHabilitados: number[];
  horarioAbertura: string;
  horarioCorte: string;
  percentual: string;
  taxaFixa: string;
  fonteProducao: string;
  categoriasProducao: string[];
  previsaoPagamentoTexto: string;
  descricaoPixModelo: string;
  apuracaoDiaInicio: string;
  /** Dia da semana do repasse (0=domingo). O banco guarda o nº de dias após o fim
   *  — a conversão é na carga e no salvar (lib/hub/adiantamento-repasse). */
  apuracaoDiaRepasse: string;
  apuracaoDataBase: string;
  categoriasExtrato: string[];
  /** F3: subconjunto do extrato que compõe a base da nota. */
  categoriasNota: string[];
  descontoAdiantamentos: boolean;
  descontoDebitos: boolean;
  repasseVisivelApp: boolean;
  motivo: string;
}

function formDe(c: Configuracao | null): FormState {
  return {
    diasHabilitados: c?.diasHabilitados ?? [],
    horarioAbertura: c?.horarioAbertura?.slice(0, 5) ?? '',
    horarioCorte: c?.horarioCorte?.slice(0, 5) ?? '',
    percentual: c?.percentual !== null && c?.percentual !== undefined ? String(c.percentual) : '',
    taxaFixa: c?.taxaFixa ?? '',
    fonteProducao: c?.fonteProducao ?? '',
    categoriasProducao: c?.categoriasProducao ?? [],
    previsaoPagamentoTexto: c?.previsaoPagamentoTexto ?? '',
    descricaoPixModelo: c?.descricaoPixModelo ?? '',
    apuracaoDiaInicio: c?.apuracaoDiaInicio !== null && c?.apuracaoDiaInicio !== undefined ? String(c.apuracaoDiaInicio) : '',
    apuracaoDiaRepasse:
      c?.apuracaoDiaInicio != null && c?.apuracaoDiasAteRepasse != null
        ? String(diaDoRepasse(c.apuracaoDiaInicio, c.apuracaoDiasAteRepasse) ?? '')
        : '',
    apuracaoDataBase: c?.apuracaoDataBase ?? '',
    categoriasExtrato: c?.categoriasExtrato ?? [],
    categoriasNota: c?.categoriasNota ?? [],
    descontoAdiantamentos: c?.descontoAdiantamentos ?? true,
    descontoDebitos: c?.descontoDebitos ?? false,
    repasseVisivelApp: c?.repasseVisivelApp ?? false,
    motivo: '',
  };
}

/** Validações espelhando as CHECK constraints reais (nunca inventadas —
 * ver cabeçalho). Retorna a 1ª violação encontrada, ou `null` se ok. */
function primeiraViolacao(f: FormState): string | null {
  if (f.diasHabilitados.length === 0) return 'Selecione ao menos um dia habilitado.';
  if (!f.horarioAbertura || !f.horarioCorte) return 'Informe abertura e corte.';
  if (f.horarioAbertura >= f.horarioCorte) return 'O horário de abertura precisa ser antes do corte.';
  const pct = Number(f.percentual.replace(',', '.'));
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return 'Percentual precisa estar entre 0 (exclusive) e 100.';
  const taxa = Number(f.taxaFixa.replace(',', '.'));
  if (!Number.isFinite(taxa) || taxa < 0) return 'Taxa fixa não pode ser negativa.';
  if ((f.fonteProducao === 'financeiro_lancamento' || f.fonteProducao === 'financeiro_referencia') && f.categoriasProducao.length === 0) {
    return 'Selecione ao menos uma categoria de produção para essa fonte.';
  }
  if (f.previsaoPagamentoTexto.trim().length < 1 || f.previsaoPagamentoTexto.length > 120) {
    return 'A previsão de pagamento precisa ter entre 1 e 120 caracteres.';
  }
  if (!f.descricaoPixModelo.includes('{nome}')) return 'O modelo da descrição Pix precisa conter "{nome}".';
  if (f.apuracaoDiaRepasse !== '' && f.apuracaoDiaInicio === '') return 'Defina o início da janela para calcular o dia do repasse.';
  return null;
}

function useConfiguracaoAdiantamento() {
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [vigente, setVigente] = useState<Configuracao | null>(null);
  const [historico, setHistorico] = useState<ConfiguracaoHistoricoItem[]>([]);
  const [form, setForm] = useState<FormState>(formDe(null));
  const [categoriasDisponiveis, setCategoriasDisponiveis] = useState<CategoriaProducao[]>([]);
  const [salvando, setSalvando] = useState(false);
  const [erroSalvar, setErroSalvar] = useState<string | null>(null);
  const [conflito, setConflito] = useState(false);

  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await obterConfiguracoes();
      setVigente(r.vigente);
      setHistorico(r.historico);
      setForm(formDe(r.vigente));
    } catch (e) {
      setErro(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível carregar as configurações.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    buscar();
  }, [buscar]);

  // Sem depender da fonte: o EXTRATO (repasse semanal) usa a mesma lista de
  // categorias do faturamento, e existe mesmo com a fonte da produção vazia.
  useEffect(() => {
    let cancelado = false;
    listarCategoriasProducao(form.fonteProducao || undefined)
      .then((r) => {
        if (!cancelado) setCategoriasDisponiveis(r.itens);
      })
      .catch(() => {
        if (!cancelado) setCategoriasDisponiveis([]);
      });
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.fonteProducao]);

  const salvar = useCallback(async () => {
    const violacao = primeiraViolacao(form);
    if (violacao) {
      setErroSalvar(violacao);
      setConflito(false);
      return;
    }
    setSalvando(true);
    setErroSalvar(null);
    setConflito(false);
    try {
      const nova = await salvarConfiguracao({
        versaoEsperada: vigente?.versao ?? 0,
        diasHabilitados: form.diasHabilitados,
        horarioAbertura: form.horarioAbertura,
        horarioCorte: form.horarioCorte,
        percentual: Number(form.percentual.replace(',', '.')),
        taxaFixa: form.taxaFixa.replace(',', '.'),
        fonteProducao: form.fonteProducao || undefined,
        categoriasProducao: form.categoriasProducao.length ? form.categoriasProducao : undefined,
        previsaoPagamentoTexto: form.previsaoPagamentoTexto,
        descricaoPixModelo: form.descricaoPixModelo,
        apuracaoDiaInicio: form.apuracaoDiaInicio !== '' ? Number(form.apuracaoDiaInicio) : undefined,
        // undefined = mantém o valor atual (o RPC faz COALESCE) — um prazo salvo fora
        // do padrão semanal não é reescrito sem alguém escolher o dia.
        apuracaoDiasAteRepasse:
          form.apuracaoDiaRepasse !== '' && form.apuracaoDiaInicio !== ''
            ? diasAteRepasse(Number(form.apuracaoDiaInicio), Number(form.apuracaoDiaRepasse))
            : undefined,
        apuracaoDataBase: form.apuracaoDataBase || undefined,
        categoriasExtrato: form.categoriasExtrato.length ? form.categoriasExtrato : undefined,
        categoriasNota: form.categoriasNota.length ? form.categoriasNota : undefined,
        descontoAdiantamentos: form.descontoAdiantamentos,
        descontoDebitos: form.descontoDebitos,
        repasseVisivelApp: form.repasseVisivelApp,
        motivo: form.motivo.trim() || undefined,
      });
      setVigente(nova);
      setForm(formDe(nova));
      const r = await obterConfiguracoes();
      setHistorico(r.historico);
    } catch (e) {
      if (e instanceof AdiantamentosApiError && e.codigo === 'VERSAO_DESATUALIZADA') {
        // FR-023/7.4.3 — NUNCA reseta `form`: o que foi digitado permanece
        // intacto para o financeiro decidir (recarregar ou reenviar por cima).
        setConflito(true);
        setErroSalvar(e.message);
      } else {
        setErroSalvar(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível salvar a configuração.');
      }
    } finally {
      setSalvando(false);
    }
  }, [form, vigente]);

  return {
    carregando, erro, vigente, historico, form, setForm, categoriasDisponiveis,
    salvando, erroSalvar, conflito, buscar, salvar,
  };
}

function Chip({ ativo, onClick, disabled, children }: { ativo: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={ativo}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'min-h-9 rounded-full border px-3 py-1 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
        ativo ? 'border-primary bg-primary/10 text-primary' : 'border-input text-muted-foreground hover:bg-muted'
      )}
    >
      {children}
    </button>
  );
}

function toggleItem<T>(lista: T[], item: T): T[] {
  return lista.includes(item) ? lista.filter((x) => x !== item) : [...lista, item];
}

const numero = new Intl.NumberFormat('pt-BR');

// "Janela de segunda a domingo · repasse na quarta, 3 dias após o fim" — a frase
// que confirma a conversão para quem configura.
function resumoRepasse(f: FormState, vigente: Configuracao | null): string | null {
  const diaSemana = (d: number) => NOMES_DIA[d].toLowerCase();
  const artigo = (d: number) => (d === 0 || d === 6 ? 'no' : 'na');
  if (f.apuracaoDiaInicio !== '' && f.apuracaoDiaRepasse !== '') {
    const inicio = Number(f.apuracaoDiaInicio);
    const dia = Number(f.apuracaoDiaRepasse);
    const n = diasAteRepasse(inicio, dia);
    return `Janela de ${diaSemana(inicio)} a ${diaSemana((inicio + 6) % 7)} · repasse ${artigo(dia)} ${diaSemana(dia)}`
      + `${n === 7 ? ' seguinte' : ''}, ${n} ${n === 1 ? 'dia' : 'dias'} após o fim.`;
  }
  const atual = vigente?.apuracaoDiasAteRepasse;
  if (f.apuracaoDiaRepasse === '' && atual != null && vigente?.apuracaoDiaInicio != null && diaDoRepasse(vigente.apuracaoDiaInicio, atual) === null) {
    return `Configuração atual: ${atual} dias após o fim da janela. Escolha o dia do repasse para padronizar — sem escolher, o prazo atual é mantido.`;
  }
  return null;
}

function detalheCategoria(i: ItemCategoria): string {
  if (i.ausente === 'sem_lancamentos') return 'sem lançamentos em 90 dias';
  if (i.ausente === 'dentro_de_familia') return `já incluída em ${i.rotuloFamilia}`;
  const qtd = numero.format(i.lancamentos);
  if (i.ausente === 'fora_da_familia') return `${qtd} · faz parte de ${i.rotuloFamilia}`;
  if (i.familia) return `${i.membros} ${i.membros === 1 ? 'campanha' : 'campanhas'} · ${qtd}`;
  return i.semMotoristaIdentificado ? `${qtd} · parte sem motorista` : qtd;
}

// Só aparecem categorias com ao menos um lançamento COM motorista (0087), e
// as famílias (Promoção, Missões) vêm dobradas num item só — marcar a família
// inclui também as campanhas que surgirem depois.
function SeletorCategorias({ titulo, textoVazio, disponiveis, selecionadas, onChange, aviso }: {
  titulo: string;
  textoVazio: string;
  disponiveis: CategoriaProducao[];
  selecionadas: string[];
  onChange: (categorias: string[]) => void;
  /** Mostrado quando nada está selecionado — o silêncio do repasse zerado
   *  custou meses sem ninguém perceber (F1, briefing repasse-nota-producao). */
  aviso?: string;
}) {
  const [busca, setBusca] = useState('');
  const itens = montarItensCategoria(disponiveis, selecionadas);
  const visiveis = filtrarItensCategoria(itens, busca);
  const familias = itens.filter((i) => i.familia && !i.ausente).map((i) => i.rotulo);
  const marcarVisiveis = (marcado: boolean) => {
    const chaves = visiveis.map((i) => i.chave);
    onChange(marcado ? [...new Set([...selecionadas, ...chaves])] : selecionadas.filter((s) => !chaves.includes(s)));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-sm font-medium">{titulo}</span>
        {itens.length > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">{selecionadas.length} de {itens.length} selecionadas</span>
        )}
      </div>
      {itens.length === 0 ? (
        <p className="text-xs text-muted-foreground">{textoVazio}</p>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              type="search"
              aria-label="Buscar categoria"
              placeholder="Buscar categoria"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              className="sm:max-w-xs"
            />
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={visiveis.length === 0} onClick={() => marcarVisiveis(true)}>
                Marcar visíveis
              </Button>
              <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={visiveis.length === 0} onClick={() => marcarVisiveis(false)}>
                Desmarcar visíveis
              </Button>
            </div>
          </div>
          {visiveis.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nenhuma categoria encontrada para “{busca.trim()}”.</p>
          ) : (
            <div role="group" aria-label={titulo} className="flex flex-wrap gap-1.5">
              {visiveis.map((i) => (
                <Chip key={i.chave} ativo={selecionadas.includes(i.chave)} onClick={() => onChange(toggleItem(selecionadas, i.chave))}>
                  {i.rotulo}
                  <span className="ml-1.5 text-xs font-normal opacity-75 tabular-nums">{detalheCategoria(i)}</span>
                </Chip>
              ))}
            </div>
          )}
          {aviso && selecionadas.length === 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-500">{aviso}</p>
          )}
          {familias.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {familias.join(' e ')} {familias.length === 1 ? 'inclui' : 'incluem'} também as campanhas que surgirem depois.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default function ConfiguracoesAdiantamentoPage() {
  const { permissoes } = useHubAuth();
  const podeConfigurar = permissoes.includes('adiantamentos.configurar');
  const c = useConfiguracaoAdiantamento();
  const inputId = useId();

  return (
    <div className={`mx-auto flex w-full ${LARGURA_DETALHE} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
      <h1 className="text-lg font-semibold">Configurações de adiantamento</h1>
      <p className="text-sm text-muted-foreground">
        Regras vigentes do adiantamento. Salvar cria uma nova versão; solicitações já feitas não mudam (FR-022).
      </p>

      {c.carregando ? (
        <ListSkeleton label="Carregando configurações..." linhas={4} />
      ) : c.erro ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center">
          <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{c.erro}</p>
          <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => c.buscar()}>
            Tentar novamente
          </Button>
        </div>
      ) : (
        <>
          {!c.vigente && (
            <p role="status" className="rounded-md bg-warning/10 px-3 py-2 text-sm font-medium text-warning-strong">
              Ainda não há configuração vigente — preencha e salve para liberar solicitações (FR-025).
            </p>
          )}
          {c.vigente && (
            <p className="text-xs text-muted-foreground">
              Versão {c.vigente.versao} · vigente desde {formatDateBR(c.vigente.vigenteDesde)}
            </p>
          )}

          <fieldset disabled={!podeConfigurar || c.salvando} className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle as="h2" className="text-base">Quando o motorista pode pedir</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 px-4">
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">Dias habilitados</span>
                  <div className="flex flex-wrap gap-1.5">
                    {NOMES_DIA.map((nome, dia) => (
                      <Chip
                        key={dia}
                        ativo={c.form.diasHabilitados.includes(dia)}
                        onClick={() => c.setForm((f) => ({ ...f, diasHabilitados: toggleItem(f.diasHabilitados, dia) }))}
                      >
                        {nome}
                      </Chip>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <label htmlFor={`${inputId}-abertura`} className="text-sm font-medium">Abertura</label>
                    <Input
                      id={`${inputId}-abertura`}
                      type="time"
                      value={c.form.horarioAbertura}
                      onChange={(e) => c.setForm((f) => ({ ...f, horarioAbertura: e.target.value }))}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label htmlFor={`${inputId}-corte`} className="text-sm font-medium">Horário de corte</label>
                    <Input
                      id={`${inputId}-corte`}
                      type="time"
                      value={c.form.horarioCorte}
                      onChange={(e) => c.setForm((f) => ({ ...f, horarioCorte: e.target.value }))}
                    />
                    <span className="text-xs text-muted-foreground">Abertura inclusiva, corte exclusivo.</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle as="h2" className="text-base">Cálculo</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 px-4">
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">Fonte da produção de ontem</span>
                  <div className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap">
                    {FONTES_PRODUCAO.map((opt) => (
                      <label key={opt.valor} className="flex cursor-pointer items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                        <input
                          type="radio"
                          name={`${inputId}-fonte`}
                          checked={c.form.fonteProducao === opt.valor}
                          onChange={() => c.setForm((f) => ({ ...f, fonteProducao: opt.valor, categoriasProducao: [] }))}
                        />
                        {opt.rotulo}
                      </label>
                    ))}
                  </div>
                </div>
                <SeletorCategorias
                  titulo="Categorias que entram na produção"
                  textoVazio="Escolha uma fonte para ver as categorias encontradas nos últimos 90 dias."
                  disponiveis={c.form.fonteProducao ? c.categoriasDisponiveis : []}
                  selecionadas={c.form.categoriasProducao}
                  onChange={(categoriasProducao) => c.setForm((f) => ({ ...f, categoriasProducao }))}
                />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <label htmlFor={`${inputId}-pct`} className="text-sm font-medium">Percentual</label>
                    <Input
                      id={`${inputId}-pct`}
                      inputMode="decimal"
                      value={c.form.percentual}
                      onChange={(e) => c.setForm((f) => ({ ...f, percentual: e.target.value }))}
                      placeholder="60"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label htmlFor={`${inputId}-taxa`} className="text-sm font-medium">Taxa fixa por solicitação</label>
                    <Input
                      id={`${inputId}-taxa`}
                      inputMode="decimal"
                      value={c.form.taxaFixa}
                      onChange={(e) => c.setForm((f) => ({ ...f, taxaFixa: e.target.value }))}
                      placeholder="0.35"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle as="h2" className="text-base">Pagamento</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 px-4">
                <div className="flex flex-col gap-1">
                  <label htmlFor={`${inputId}-previsao`} className="text-sm font-medium">Previsão de pagamento</label>
                  <Input
                    id={`${inputId}-previsao`}
                    maxLength={120}
                    value={c.form.previsaoPagamentoTexto}
                    onChange={(e) => c.setForm((f) => ({ ...f, previsaoPagamentoTexto: e.target.value }))}
                    placeholder="entre 17h e 18h de hoje"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor={`${inputId}-pix`} className="text-sm font-medium">Modelo da Descrição Pix</label>
                  <Input
                    id={`${inputId}-pix`}
                    className="font-mono"
                    value={c.form.descricaoPixModelo}
                    onChange={(e) => c.setForm((f) => ({ ...f, descricaoPixModelo: e.target.value }))}
                    placeholder="Antecipação {nome}"
                  />
                  <span className="text-xs text-muted-foreground">Precisa conter o marcador literal &quot;{'{nome}'}&quot;.</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle as="h2" className="text-base">Repasse semanal</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 px-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <label htmlFor={`${inputId}-dia-inicio`} className="text-sm font-medium">Início da janela (7 dias)</label>
                    <select
                      id={`${inputId}-dia-inicio`}
                      value={c.form.apuracaoDiaInicio}
                      onChange={(e) => c.setForm((f) => ({ ...f, apuracaoDiaInicio: e.target.value }))}
                      className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                    >
                      <option value="">A definir</option>
                      {NOMES_DIA.map((nome, dia) => (
                        <option key={dia} value={dia}>{nome}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label htmlFor={`${inputId}-dia-repasse`} className="text-sm font-medium">Dia do repasse</label>
                    <select
                      id={`${inputId}-dia-repasse`}
                      value={c.form.apuracaoDiaRepasse}
                      onChange={(e) => c.setForm((f) => ({ ...f, apuracaoDiaRepasse: e.target.value }))}
                      className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                    >
                      <option value="">A definir</option>
                      {NOMES_DIA.map((nome, dia) => (
                        <option key={dia} value={dia}>{nome}</option>
                      ))}
                    </select>
                  </div>
                </div>
                {resumoRepasse(c.form, c.vigente) && (
                  <p className="text-xs text-muted-foreground">{resumoRepasse(c.form, c.vigente)}</p>
                )}
                <div className="flex flex-col gap-1">
                  <label htmlFor={`${inputId}-base`} className="text-sm font-medium">Data dos lançamentos</label>
                  <select
                    id={`${inputId}-base`}
                    value={c.form.apuracaoDataBase}
                    onChange={(e) => c.setForm((f) => ({ ...f, apuracaoDataBase: e.target.value }))}
                    className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 sm:w-64"
                  >
                    <option value="">A definir</option>
                    {BASES_DATA_REPASSE.map((opt) => (
                      <option key={opt.valor} value={opt.valor}>{opt.rotulo}</option>
                    ))}
                  </select>
                </div>
                <SeletorCategorias
                  titulo="Categorias que entram no repasse (extrato)"
                  textoVazio="Nenhuma categoria encontrada nos últimos 90 dias."
                  disponiveis={c.categoriasDisponiveis}
                  selecionadas={c.form.categoriasExtrato}
                  onChange={(categoriasExtrato) => c.setForm((f) => ({ ...f, categoriasExtrato }))}
                  aviso="Sem nenhuma categoria marcada, o repasse de todas as semanas fica zerado."
                />
                <SeletorCategorias
                  titulo="Dessas, quais entram na nota"
                  textoVazio="Marque primeiro as categorias do repasse, acima."
                  disponiveis={restringirAoExtrato(c.categoriasDisponiveis, c.form.categoriasExtrato)}
                  selecionadas={c.form.categoriasNota}
                  onChange={(categoriasNota) => c.setForm((f) => ({ ...f, categoriasNota }))}
                  aviso="Enquanto nada estiver marcado, o app do motorista mostra só o total, sem separar o que entra na nota."
                />
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">Descontos considerados</span>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={c.form.descontoAdiantamentos}
                      onChange={(e) => c.setForm((f) => ({ ...f, descontoAdiantamentos: e.target.checked }))}
                      className="size-4 rounded border-input"
                    />
                    Adiantamentos pagos (valor bruto)
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={c.form.descontoDebitos}
                      onChange={(e) => c.setForm((f) => ({ ...f, descontoDebitos: e.target.checked }))}
                      className="size-4 rounded border-input"
                    />
                    Débitos da EntreGô
                  </label>
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={c.form.repasseVisivelApp}
                    onChange={(e) => c.setForm((f) => ({ ...f, repasseVisivelApp: e.target.checked }))}
                    className="size-4 rounded border-input"
                  />
                  Mostrar a previsão do repasse no app do motorista
                </label>
              </CardContent>
            </Card>

            {podeConfigurar && (
              <Card>
                <CardContent className="flex flex-col gap-3 px-4 pt-4">
                  <div className="flex flex-col gap-1">
                    <label htmlFor={`${inputId}-motivo`} className="text-sm font-medium">Motivo da alteração (opcional)</label>
                    <Input
                      id={`${inputId}-motivo`}
                      maxLength={500}
                      value={c.form.motivo}
                      onChange={(e) => c.setForm((f) => ({ ...f, motivo: e.target.value }))}
                      placeholder="Ex.: Segunda liberada pela diretoria"
                    />
                  </div>

                  {c.erroSalvar && (
                    <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
                      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      <span>
                        {c.erroSalvar}
                        {c.conflito && ' Os dados que você digitou continuam aqui — recarregue para ver a versão mais recente antes de tentar de novo.'}
                      </span>
                    </p>
                  )}

                  <div className="flex justify-end gap-2">
                    {c.conflito && (
                      <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => c.buscar()}>
                        Recarregar
                      </Button>
                    )}
                    <Button size="sm" className="min-h-11 gap-1.5 sm:min-h-8" disabled={c.salvando} onClick={() => c.salvar()}>
                      {c.salvando ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <Save className="size-4" aria-hidden="true" />}
                      Salvar versão {(c.vigente?.versao ?? 0) + 1}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </fieldset>

          <Card>
            <CardHeader>
              <CardTitle as="h2" className="text-base">Histórico de versões</CardTitle>
            </CardHeader>
            <CardContent className="px-4">
              {c.historico.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhuma versão registrada ainda.</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm">
                  {c.historico.map((item) => (
                    <li key={item.versao} className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2 last:border-0 last:pb-0">
                      <span className="font-mono font-semibold">v{item.versao}</span>
                      <span className="text-muted-foreground">{formatDateBR(item.vigenteDesde)}</span>
                      <span>{typeof item.criadoPor === 'object' && item.criadoPor ? item.criadoPor.nome : '—'}</span>
                      <span className="text-muted-foreground">{item.motivo ?? '—'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
