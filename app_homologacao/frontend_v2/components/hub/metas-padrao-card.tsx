'use client';

// impeccable r24 — metas PADRÃO da entidade, configuráveis onde o operador
// pediu: dentro de "Meu perfil" (o modal aberto pelo menu da conta), que é
// onde ele espera achar configuração.
//
// ⚠️ ISTO NÃO É DADO PESSOAL, e a tela diz isso em voz alta. O card vive num
// modal chamado "Meu perfil", mas o que se edita aqui vale para a ENTIDADE
// INTEIRA — todos os colegas veem o efeito na tela de Performance. Misturar as
// duas coisas sem aviso seria deixar alguém mexer no contrato da empresa
// achando que ajusta a própria conta. Daí o separador, o título próprio e a
// frase de escopo.
//
// Só aparece para quem tem `performance.metas_gerenciar`; sem a permissão, o
// card inteiro some (não há o que ler aqui que a tela de Performance já não
// mostre).
//
// Os três patamares informados pelo operador (2026-08-17) — tempo online ≥90%,
// aceitas ≥90%, completadas ≥95% — vêm PRÉ-PREENCHIDOS como sugestão, e nada
// passa a valer sem alguém salvar: a tela não decide o contrato de ninguém.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Loader2, Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { useHubAuth } from '@/contexts/hub-auth-context';
import {
  INDICADORES_META,
  META_PADRAO,
  METAS_SUGERIDAS,
  MetasApiError,
  chaveMeta,
  fracaoParaPercentual,
  listarMetas,
  percentualParaFracao,
  salvarMeta,
  suspeitaDeUnidade,
  validarPercentual,
  type IndicadorMeta,
} from '@/lib/hub/performance-metas-api';

type Campos = Record<IndicadorMeta, string>;

const VAZIO: Campos = { aceitacao: '', conclusao: '', tempo_disponivel: '' };

export function MetasPadraoCard() {
  const { permissoes } = useHubAuth();
  // `Array.isArray` e não `permissoes.includes(...)` direto: este card foi
  // enxertado no `PerfilCard`, que é o miolo do modal "Meu perfil" — uma
  // superfície central. Um contexto sem `permissoes` (mock de teste, sessão a
  // meio caminho, /me ainda não resolvido) derrubava o modal INTEIRO com
  // "Cannot read properties of undefined". Ausência de permissão é ausência de
  // card, nunca uma tela quebrada.
  const podeGerenciar = Array.isArray(permissoes) && permissoes.includes('performance.metas_gerenciar');

  const [campos, setCampos] = useState<Campos>(VAZIO);
  // Guarda o que veio do servidor para saber o que MUDOU: sem isso, salvar
  // reenviaria os três indicadores a cada clique, gerando três eventos de
  // auditoria para uma alteração só.
  const [salvos, setSalvos] = useState<Campos>(VAZIO);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const metas = await listarMetas();
      const porChave = new Map(metas.map((m) => [chaveMeta(m.praca, m.periodo, m.indicador), m.valor]));
      const lidos: Campos = { ...VAZIO };
      for (const ind of INDICADORES_META) {
        const v = porChave.get(chaveMeta(META_PADRAO, META_PADRAO, ind.id));
        // Sem meta salva, o campo vem com a SUGESTÃO — mas `salvos` fica
        // vazio, para a tela saber que ainda não há nada valendo.
        lidos[ind.id] =
          v !== undefined ? String(fracaoParaPercentual(v)) : String(METAS_SUGERIDAS[ind.id]);
      }
      setCampos(lidos);
      setSalvos(
        metas.length
          ? INDICADORES_META.reduce((acc, ind) => {
              const v = porChave.get(chaveMeta(META_PADRAO, META_PADRAO, ind.id));
              acc[ind.id] = v !== undefined ? String(fracaoParaPercentual(v)) : '';
              return acc;
            }, { ...VAZIO })
          : VAZIO
      );
    } catch (e) {
      setErro(e instanceof MetasApiError ? e.message : 'Não foi possível carregar as metas.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    if (podeGerenciar) carregar();
    else setCarregando(false);
  }, [podeGerenciar, carregar]);

  const salvar = useCallback(async () => {
    for (const ind of INDICADORES_META) {
      const problema = validarPercentual(campos[ind.id]);
      if (problema) {
        setErro(`${ind.rotulo}: ${problema}`);
        document.getElementById(`meta-padrao-${ind.id}`)?.focus();
        return;
      }
    }
    setErro(null);
    setSalvando(true);
    try {
      const mudados = INDICADORES_META.filter((ind) => campos[ind.id] !== salvos[ind.id]);
      for (const ind of mudados) {
        const numero = Number(campos[ind.id].trim().replace(',', '.'));
        const suspeita = suspeitaDeUnidade(numero);
        if (suspeita) {
          setErro(`${ind.rotulo}: ${suspeita}`);
          setSalvando(false);
          document.getElementById(`meta-padrao-${ind.id}`)?.focus();
          return;
        }
        await salvarMeta({
          praca: META_PADRAO,
          periodo: META_PADRAO,
          indicador: ind.id,
          valor: percentualParaFracao(numero),
        });
      }
      toast.success(
        mudados.length === 0
          ? 'Nenhuma meta mudou.'
          : `${mudados.length} meta${mudados.length === 1 ? '' : 's'} salva${mudados.length === 1 ? '' : 's'}.`
      );
      await carregar();
    } catch (e) {
      setErro(e instanceof MetasApiError ? e.message : 'Não foi possível salvar as metas.');
    } finally {
      setSalvando(false);
    }
  }, [campos, salvos, carregar]);

  if (!podeGerenciar) return null;

  const nenhumaSalva = INDICADORES_META.every((ind) => !salvos[ind.id]);

  return (
    <>
      <Separator />
      <section aria-labelledby="metas-padrao-titulo" className="flex flex-col gap-3">
        <div>
          <h3 id="metas-padrao-titulo" className="flex items-center gap-1.5 text-sm font-medium">
            <Target className="size-4" aria-hidden="true" />
            Metas de performance
          </h3>
          {/* A frase de escopo é o que impede alguém de achar que está
              ajustando a própria conta num modal chamado "Meu perfil". */}
          <p className="mt-1 text-xs text-muted-foreground">
            Valem para <strong className="font-medium text-foreground">toda a entidade</strong>, não
            só para você. Cada turno da tela de Performance é comparado a estes patamares.
          </p>
        </div>

        {carregando ? (
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Carregando metas...
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {INDICADORES_META.map((ind) => (
                <div key={ind.id} className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor={`meta-padrao-${ind.id}`} className="text-sm">
                    {ind.rotulo}
                    <span className="block text-xs text-muted-foreground">{ind.ajuda}</span>
                  </label>
                  <div className="flex items-center gap-1">
                    <Input
                      id={`meta-padrao-${ind.id}`}
                      value={campos[ind.id]}
                      onChange={(e) => setCampos((c) => ({ ...c, [ind.id]: e.target.value }))}
                      inputMode="decimal"
                      aria-describedby={`meta-padrao-${ind.id}-unidade`}
                      className="h-11 w-20 text-right sm:h-9"
                    />
                    {/* O sufixo evita o erro de unidade na origem: com "%" à
                        vista, digitar 0,9 para dizer 90% fica visivelmente
                        errado antes de qualquer validação. */}
                    <span id={`meta-padrao-${ind.id}-unidade`} className="text-sm text-muted-foreground">
                      %
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {erro && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {erro}
              </p>
            )}

            {nenhumaSalva && !erro && (
              <p className="text-xs text-warning-strong">
                Ainda não há meta valendo — nenhum turno é avaliado até você salvar.
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link
                href="/hub/dashboard/performance/metas"
                className="text-xs text-primary underline-offset-2 hover:underline"
              >
                Metas por praça e turno
              </Link>
              <Button size="sm" className="min-h-11 sm:min-h-8" onClick={salvar} disabled={salvando}>
                {salvando ? 'Salvando...' : 'Salvar metas'}
              </Button>
            </div>
          </>
        )}
      </section>
    </>
  );
}
