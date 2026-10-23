'use client';

// lancamento-externo — aviso de FR-049 (valores pagos por fora que NÃO serão
// descontados porque a flag `desconto_adiantamentos` está desligada). Aparece nos
// DOIS momentos em que alguém decide sobre o dinheiro da semana: na aba Repasse
// (acima da tabela) e na confirmação do fechamento. Não bloqueia e não revela nada
// identificável. Falha na consulta NÃO é engolida (CHK008/FR-049): aparece como alerta.

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { obterResumoLancamentosExternos, type ResumoLancamentosExternos } from '@/lib/hub/lancamento-externo';
import { formatBRL } from '@/lib/utils';

// `versao`: quem importa incrementa para o aviso reconsultar — sem isso o aviso da prévia fica
// velho até recarregar a página (o do diálogo de fechamento remonta e não sofre disso).
export function useResumoLancamentoExterno(periodo: string, versao = 0) {
  const [resumo, setResumo] = useState<ResumoLancamentosExternos | null>(null);
  const [erro, setErro] = useState(false);
  useEffect(() => {
    if (!periodo) return undefined;
    let vivo = true;
    obterResumoLancamentosExternos(periodo)
      .then((r) => { if (vivo) { setResumo(r); setErro(false); } })
      .catch(() => { if (vivo) { setResumo(null); setErro(true); } });
    return () => { vivo = false; };
  }, [periodo, versao]);
  // Sem período (diálogo fechado) o resultado da abertura anterior NÃO pode vazar para a próxima.
  return { resumo: periodo ? resumo : null, erro: periodo ? erro : false };
}

export type EstadoResumoLancamentoExterno = ReturnType<typeof useResumoLancamentoExterno>;

/** `estado`: quem já consultou o resumo (o diálogo de fechamento, que precisa dele para a confirmação) o repassa e
 * evita uma segunda requisição idêntica. */
export function AvisoLancamentoExterno({ periodo, versao = 0, estado }: { periodo: string; versao?: number; estado?: EstadoResumoLancamentoExterno }) {
  const proprio = useResumoLancamentoExterno(estado ? '' : periodo, versao);
  const { resumo, erro } = estado ?? proprio;
  if (erro) {
    return (
      <p role="alert" className="rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-strong">
        Não foi possível verificar se há valores pagos por fora nesta semana. Confira antes de fechar.
      </p>
    );
  }
  if (!resumo) return null;
  const naoDescontado = resumo.qtdDeducao > 0 && !resumo.flagDescontoLigada;
  const qtdNeg = resumo.qtdNegativo ?? 0;
  if (!naoDescontado && qtdNeg <= 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {naoDescontado && (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-strong">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            Há {resumo.qtdDeducao} {resumo.qtdDeducao === 1 ? 'valor pago' : 'valores pagos'} por fora ({formatBRL(resumo.totalDeducao)}) que
            NÃO {resumo.qtdDeducao === 1 ? 'será descontado' : 'serão descontados'} deste repasse: o desconto de adiantamentos está desligado na configuração.
          </span>
        </p>
      )}
      {/* Independe da flag: é justamente quando ela é ligada com a semana aberta (ou entra um débito depois do import)
          que a conferência feita na importação deixa de valer. */}
      {qtdNeg > 0 && (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            {qtdNeg} {qtdNeg === 1 ? 'motorista com pago por fora fica' : 'motoristas com pago por fora ficam'} com remanescente NEGATIVO
            nesta semana ({formatBRL(resumo.totalNegativo ?? 0)} no total): esse valor não será pago nem passará para a próxima semana.
            Em &quot;Ver pagos por fora&quot; dá para excluir o lançamento antes de fechar.
          </span>
        </p>
      )}
    </div>
  );
}
