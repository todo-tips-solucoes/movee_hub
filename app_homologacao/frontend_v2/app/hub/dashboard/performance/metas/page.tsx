'use client';

// impeccable r24 parte 2 — tela de metas de performance (praça × turno).
//
// Decisão do operador (2026-08-16): o patamar é contratual, varia por praça E
// turno, e quem define é o admin da entidade.
//
// POR QUE NÃO É UMA MATRIZ. O cruzamento praça × turno × 3 indicadores é uma
// grade que cresce por multiplicação, e a tela de papéis deste mesmo produto já
// mostrou onde isso vai dar: 34 permissões × 4 papéis = 132 caixas, 148
// controles numa rota só, o outlier de densidade do hub há quatro rodadas.
// Aqui a maioria dos cruzamentos NÃO tem meta — e "sem meta" é um estado
// legítimo, não um vazio a preencher. Então a tela lista o que existe e
// oferece um formulário para acrescentar, em vez de pedir que alguém percorra
// uma grade de células vazias.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { AlertCircle, ArrowLeft, Plus, Target, Trash2 } from 'lucide-react';
import { LARGURA_LISTA } from '@/lib/hub/larguras';
import { PageHeader } from '@/components/hub/page-header';
import { EmptyState } from '@/components/hub/empty-state';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { SelectFiltro } from '@/components/hub/select-filtro';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { listarPerformance } from '@/lib/hub/performance-api';
import {
  INDICADORES_META,
  MetasApiError,
  fracaoParaPercentual,
  listarMetas,
  percentualParaFracao,
  removerMeta,
  salvarMeta,
  suspeitaDeUnidade,
  validarPercentual,
  type IndicadorMeta,
  type MetaPerformance,
} from '@/lib/hub/performance-metas-api';

const ROTULO_INDICADOR = new Map(INDICADORES_META.map((i) => [i.id, i.rotulo]));

function formatPct(fracao: number): string {
  return `${fracaoParaPercentual(fracao).toLocaleString('pt-BR')}%`;
}

export default function MetasPerformancePage() {
  const { permissoes } = useHubAuth();
  const podeGerenciar = permissoes.includes('performance.metas_gerenciar');

  const [metas, setMetas] = useState<MetaPerformance[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  // Sugestões de praça/turno vindas dos registros já importados. Ceiling
  // declarado: só a primeira página (100 linhas) — o filtro de igualdade da
  // meta é por texto, e digitar uma praça que não existe cria uma meta que
  // nunca se aplica a nada. `<datalist>` é sugestão, não restrição: uma praça
  // nova (que ainda não teve turno importado) continua podendo ser digitada.
  const [pracas, setPracas] = useState<string[]>([]);
  const [turnos, setTurnos] = useState<string[]>([]);

  const [praca, setPraca] = useState('');
  const [periodo, setPeriodo] = useState('');
  const [indicador, setIndicador] = useState<IndicadorMeta>('aceitacao');
  const [valorPct, setValorPct] = useState('');
  // Erro COM o campo a que pertence: antes havia um `erroCampo` só, e o
  // `aria-invalid`/`aria-describedby` ficavam sempre no input de porcentagem —
  // então "Informe a praça." fazia o leitor de tela anunciar o campo ERRADO
  // como inválido, e um "Erro no servidor" aparecia como erro de validação da
  // porcentagem. Achado adversarial de acessibilidade.
  const [erroCampo, setErroCampo] = useState<{ campo: 'praca' | 'periodo' | 'valor'; msg: string } | null>(null);
  const [erroForm, setErroForm] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const lista = await listarMetas();
      setMetas(lista);
    } catch (e) {
      setErro(e instanceof MetasApiError ? e.message : 'Não foi possível carregar as metas.');
      setMetas([]);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    buscar();
  }, [buscar]);

  useEffect(() => {
    let ativo = true;
    listarPerformance({ pageSize: 100 })
      .then((r) => {
        if (!ativo) return;
        const distintos = (campo: 'praca' | 'periodo') =>
          Array.from(
            new Set(r.items.map((i) => i[campo]).filter((v): v is string => !!v))
          ).sort((a, b) => a.localeCompare(b, 'pt-BR'));
        setPracas(distintos('praca'));
        setTurnos(distintos('periodo'));
      })
      // Sugestão indisponível não quebra a tela: os campos seguem livres.
      .catch(() => {});
    return () => {
      ativo = false;
    };
  }, []);

  const submeter = useCallback(async () => {
    // Na ORDEM VISUAL dos campos: validar o valor primeiro fazia um formulário
    // vazio responder "Informe a meta." e jogar o foco no último campo.
    if (!praca.trim()) {
      setErroCampo({ campo: 'praca', msg: 'Informe a praça.' });
      document.getElementById('meta-praca')?.focus();
      return;
    }
    if (!periodo.trim()) {
      setErroCampo({ campo: 'periodo', msg: 'Informe o turno.' });
      document.getElementById('meta-periodo')?.focus();
      return;
    }
    const problema = validarPercentual(valorPct);
    if (problema) {
      setErroCampo({ campo: 'valor', msg: problema });
      document.getElementById('meta-valor')?.focus();
      return;
    }
    setErroCampo(null);
    setErroForm(null);
    setSalvando(true);
    try {
      const numero = Number(valorPct.trim().replace(',', '.'));
      // Aviso, não bloqueio: 0,9 querendo dizer 90% vira meta de 0,9% e deixa
      // tudo verde para sempre — a falha silenciosa simétrica à que o produto
      // combate no outro extremo. Quem confirmar, segue.
      setAviso(suspeitaDeUnidade(numero));
      await salvarMeta({
        praca: praca.trim(),
        periodo: periodo.trim(),
        indicador,
        valor: percentualParaFracao(numero),
      });
      // Definir de novo o mesmo cruzamento é atualização, não duplicata — a
      // rota faz upsert. A mensagem diz qual dos dois aconteceu.
      const jaExistia = metas.some(
        (m) =>
          m.praca.trim().toLowerCase() === praca.trim().toLowerCase() &&
          m.periodo.trim().toLowerCase() === periodo.trim().toLowerCase() &&
          m.indicador === indicador
      );
      toast.success(jaExistia ? 'Meta atualizada.' : 'Meta definida.');
      setValorPct('');
      await buscar();
    } catch (e) {
      // Erro vindo da API é do FORMULÁRIO, não de um campo: pendurá-lo no
      // input de porcentagem faria "Erro no servidor" parecer erro de digitação.
      setErroForm(e instanceof MetasApiError ? e.message : 'Não foi possível salvar a meta.');
    } finally {
      setSalvando(false);
    }
  }, [praca, periodo, indicador, valorPct, metas, buscar]);

  const remover = useCallback(
    async (meta: MetaPerformance) => {
      try {
        await removerMeta(meta.id);
        // Desfazer pelo MESMO caminho de criação (upsert) — idioma que o hub
        // já usa em papéis e usuários. Sem AlertDialog: retirar uma meta é
        // reversível em um clique, e o produto reserva a confirmação para o
        // que tira acesso de gente ou não volta atrás.
        toast.success('Meta removida.', {
          action: {
            label: 'Desfazer',
            onClick: () => {
              void salvarMeta({
                praca: meta.praca,
                periodo: meta.periodo,
                indicador: meta.indicador,
                valor: meta.valor,
              })
                .then(() => buscar())
                .catch(() => toast.error('Não foi possível desfazer.'));
            },
          },
        });
        await buscar();
      } catch (e) {
        toast.error(e instanceof MetasApiError ? e.message : 'Não foi possível remover a meta.');
      }
    },
    [buscar]
  );

  // A lista não pagina, e 10 praças × 7 turnos × 3 indicadores = 210 linhas é
  // plausível. Sem busca, conferir uma meta antes de uma reunião vira rolagem
  // manual. O campo só aparece quando há o que procurar.
  const [busca, setBusca] = useState('');
  const filtradas = useMemo(() => {
    const alvo = busca.trim().toLowerCase();
    if (!alvo) return metas;
    return metas.filter(
      (m) =>
        m.praca.toLowerCase().includes(alvo) ||
        m.periodo.toLowerCase().includes(alvo) ||
        (ROTULO_INDICADOR.get(m.indicador) ?? '').toLowerCase().includes(alvo)
    );
  }, [metas, busca]);

  const agrupadas = useMemo(() => {
    const mapa = new Map<string, MetaPerformance[]>();
    for (const m of filtradas) {
      const chave = `${m.praca} · ${m.periodo}`;
      const lista = mapa.get(chave);
      if (lista) lista.push(m);
      else mapa.set(chave, [m]);
    }
    return Array.from(mapa.entries());
  }, [filtradas]);

  return (
    <div className={`mx-auto flex w-full ${LARGURA_LISTA} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
      {/* `buttonVariants` e não `<Button asChild>`: o Button deste repo é Base
          UI, não Radix, e não tem `asChild` (achado da r22). */}
      <Link
        href="/hub/dashboard/performance"
        className={buttonVariants({
          variant: 'ghost',
          size: 'sm',
          className: 'w-fit min-h-11 gap-1.5 sm:min-h-8',
        })}
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Voltar para Performance
      </Link>

      <PageHeader
        titulo="Metas de performance"
        subtitulo="Patamar contratual por praça e turno. Cada turno da tela de Performance é comparado à meta do seu cruzamento — abaixo, na meta ou acima."
      />

      {!podeGerenciar && (
        <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning-strong">
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          {/* Afirma a PERMISSÃO, não o papel: o gate é
              `performance.metas_gerenciar`, e a matriz de papéis pode conceder
              essa permissão a outro papel a qualquer momento — a frase
              anterior passaria a ser falsa sem ninguém tocar nesta tela. */}
          <p>Modo somente leitura — você não tem permissão para alterar metas.</p>
        </div>
      )}

      {podeGerenciar && (
        <form
          className="flex flex-col gap-3 rounded-lg bg-card p-3 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void submeter();
          }}
        >
          <div className="grid grid-cols-1 gap-3 xs:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="meta-praca" className="text-xs text-muted-foreground">
                Praça
              </label>
              <Input
                id="meta-praca"
                value={praca}
                onChange={(e) => setPraca(e.target.value)}
                list="metas-pracas"
                placeholder="Ex.: SAO PAULO"
                aria-invalid={erroCampo?.campo === 'praca'}
                aria-describedby={erroCampo?.campo === 'praca' ? 'meta-erro' : undefined}
                className="h-11 sm:h-9"
              />
              <datalist id="metas-pracas">
                {pracas.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="meta-periodo" className="text-xs text-muted-foreground">
                Turno
              </label>
              <Input
                id="meta-periodo"
                value={periodo}
                onChange={(e) => setPeriodo(e.target.value)}
                list="metas-turnos"
                placeholder="Ex.: ALMOCO 11H30-15H29"
                aria-invalid={erroCampo?.campo === 'periodo'}
                aria-describedby={erroCampo?.campo === 'periodo' ? 'meta-erro' : undefined}
                className="h-11 sm:h-9"
              />
              <datalist id="metas-turnos">
                {turnos.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="meta-indicador" className="text-xs text-muted-foreground">
                Indicador
              </label>
              <SelectFiltro
                id="meta-indicador"
                ariaLabel="Indicador"
                value={indicador}
                onChange={(v) => setIndicador(v as IndicadorMeta)}
                opcoes={INDICADORES_META.map((i) => ({ value: i.id, label: i.rotulo }))}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="meta-valor" className="text-xs text-muted-foreground">
                Meta (%)
              </label>
              <Input
                id="meta-valor"
                value={valorPct}
                onChange={(e) => setValorPct(e.target.value)}
                inputMode="decimal"
                placeholder="Ex.: 90"
                aria-invalid={erroCampo?.campo === 'valor'}
                aria-describedby={erroCampo?.campo === 'valor' ? 'meta-erro' : 'meta-ajuda'}
                className="h-11 sm:h-9"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            {erroCampo || erroForm ? (
              <p id="meta-erro" role="alert" className="text-xs font-medium text-destructive">
                {erroCampo?.msg ?? erroForm}
              </p>
            ) : aviso ? (
              <p role="status" className="text-xs font-medium text-warning-strong">
                {aviso}
              </p>
            ) : (
              <p id="meta-ajuda" className="text-xs text-muted-foreground">
                Em porcentagem: <strong className="font-medium text-foreground">90</strong> significa
                90%. Definir de novo a mesma praça, turno e indicador atualiza a meta existente.
              </p>
            )}
            <Button type="submit" size="sm" className="min-h-11 gap-1.5 sm:min-h-8" disabled={salvando}>
              <Plus className="size-4" aria-hidden="true" />
              {salvando ? 'Salvando...' : 'Definir meta'}
            </Button>
          </div>
        </form>
      )}

      {carregando ? (
        <ListSkeleton label="Carregando metas..." linhas={4} />
      ) : erro ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center"
        >
          <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{erro}</p>
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={buscar}>
            Tentar novamente
          </Button>
        </div>
      ) : metas.length === 0 ? (
        <EmptyState
          icone={Target}
          titulo="Nenhuma meta definida"
          dica={
            podeGerenciar
              ? 'Sem meta, a tela de Performance mostra os números sem julgamento. Defina a primeira acima.'
              : 'Sem meta, a tela de Performance mostra os números sem julgamento.'
          }
        />
      ) : (
        <>
        {metas.length > 12 && (
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="metas-busca" className="text-xs text-muted-foreground">
              Buscar
            </label>
            <Input
              id="metas-busca"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Praça, turno ou indicador"
              className="h-11 w-full max-w-xs sm:h-9"
            />
            <span className="text-xs text-muted-foreground">
              {filtradas.length} de {metas.length}
            </span>
          </div>
        )}
        {filtradas.length === 0 ? (
          <EmptyState
            icone={Target}
            titulo="Nenhuma meta corresponde à busca"
            dica={`Nenhuma das ${metas.length} metas cadastradas casa com "${busca.trim()}".`}
          />
        ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Praça e turno</TableHead>
                <TableHead>Indicador</TableHead>
                <TableHead className="text-right">Meta</TableHead>
                {podeGerenciar && (
                  <TableHead className="w-px">
                    <span className="sr-only">Ações</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {agrupadas.map(([cruzamento, doCruzamento]) =>
                doCruzamento.map((m, i) => (
                  <TableRow key={m.id}>
                    {/* O cruzamento aparece uma vez por grupo: repetir "SAO
                        PAULO · ALMOCO" em três linhas seguidas faz o olho
                        procurar diferença onde não há. */}
                    <TableCell className="max-w-[220px] truncate text-sm" title={cruzamento}>
                      {i === 0 ? cruzamento : <span className="sr-only">{cruzamento}</span>}
                    </TableCell>
                    <TableCell className="text-sm">
                      {ROTULO_INDICADOR.get(m.indicador) ?? m.indicador}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatPct(m.valor)}
                    </TableCell>
                    {podeGerenciar && (
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="min-h-11 gap-1.5 text-destructive sm:min-h-8"
                          onClick={() => void remover(m)}
                          aria-label={`Remover meta de ${ROTULO_INDICADOR.get(m.indicador) ?? m.indicador} em ${cruzamento}`}
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                          Remover
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        )}
        </>
      )}
    </div>
  );
}
