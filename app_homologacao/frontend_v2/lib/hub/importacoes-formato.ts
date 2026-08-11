// impeccable rodada 13 (h10=2) — o formato do arquivo de importação, dito na
// tela em vez de descoberto por tentativa e erro.
//
// O backend valida o cabeçalho por NOME **e ORDEM** exatos
// (`validarHeader` em `backend/lib/hub-import-normalizer.js`): cabeçalho fora
// do esperado é falha ESTRUTURAL — a importação inteira vira `failed` e
// nenhuma linha é gravada. Ou seja, quem monta o arquivo precisa da ordem, não
// só da lista de colunas; sem isso, acertar por tentativa é impraticável com
// 20 colunas.
//
// Estas listas são uma CÓPIA das do backend, e a cópia é deliberada: um
// endpoint novo só para servir uma constante estática custaria um deploy de
// backend a cada ajuste de copy. O que impede a deriva é
// `importacoes-formato.test.ts`, que importa o módulo real do backend e falha
// se um único nome ou posição divergir.

import type { TipoImportacao } from './importacoes-dto';

/** Separador de campos do CSV — o backend não faz sniffing de dialeto. */
export const SEPARADOR_CSV = ';';

export const COLUNAS_IMPORTACAO: Record<TipoImportacao, readonly string[]> = {
  faturamento: [
    'data_do_lancamento_financeiro',
    'data_do_periodo_de_referencia',
    'data_do_repasse',
    'periodo',
    'praca',
    'subpraca',
    'origem',
    'id_da_pessoa_entregadora',
    'recebedor',
    'tipo',
    'valor',
    'descricao',
    'atingido',
    'percentual_de_tempo_disponivel',
    'percentual_de_aceitacao',
    'percentual_de_conclusao',
    'criterio_tempo_disponivel',
    'criterio_rotas_aceitas',
    'criterio_rotas_concluidas',
    'margem_fee_porcentagem',
  ],
  performance: [
    'data_do_periodo',
    'periodo',
    'duracao_do_periodo',
    'numero_minimo_de_entregadores_regulares_na_escala',
    'tag',
    'id_da_pessoa_entregadora',
    'pessoa_entregadora',
    'praca',
    'sub_praca',
    'origem',
    'tempo_disponivel_escalado',
    'tempo_disponivel_absoluto',
    'numero_de_corridas_ofertadas',
    'numero_de_corridas_aceitas',
    'numero_de_corridas_rejeitadas',
    'numero_de_corridas_completadas',
    'numero_de_corridas_canceladas_pela_pessoa_entregadora',
    'numero_de_pedidos_aceitos_e_concluidos',
    'soma_das_taxas_das_corridas_aceitas',
  ],
};

/** Conteúdo do modelo: só a linha de cabeçalho, que é o que se erra. */
export function csvModelo(tipo: TipoImportacao): string {
  return `${COLUNAS_IMPORTACAO[tipo].join(SEPARADOR_CSV)}\n`;
}

export function nomeArquivoModelo(tipo: TipoImportacao): string {
  return `modelo-${tipo}.csv`;
}
