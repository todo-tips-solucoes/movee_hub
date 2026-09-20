// impeccable rodada 10 (A7 da crítica medida) — a matriz papel×permissão
// exibia o código cru ao usuário: `usuarios.gerenciar`, `motoristas.credencial`.
// Quem concede acesso precisa ler o que a permissão FAZ; quem dá suporte e quem
// lê auditoria é que precisa do código — por isso ele continua na tela, como
// legenda, e não some.
//
// São 49 permissões e poucos verbos. O rótulo se deriva de verbo + módulo,
// e o nome legível do módulo já vem do `GET /me` — nenhuma tabela de 49 linhas
// para sair de sincronia, mesma escolha do `TituloDaRota`.

/** Verbo (sufixo do código) → o que o usuário pode fazer. */
const VERBOS: Record<string, string> = {
  listar: 'Ver a lista',
  criar: 'Cadastrar',
  editar: 'Editar',
  excluir: 'Excluir',
  exportar: 'Exportar (CSV)',
  importar: 'Importar planilha',
  aprovar: 'Aprovar antes do disparo',
  enviar: 'Disparar mensagens',
  gerenciar: 'Administrar tudo do módulo',
  credencial: 'Emitir credencial do app',
  validar: 'Validar arquivos XML',
  // impeccable r24 parte 2 (migration 0048). Sem esta linha a permissão nova
  // aparece como CÓDIGO CRU na matriz de papéis — foi o `impeccable-rodada10`
  // que pegou, e é o gate funcionando: permissão nova sem rótulo é regressão
  // de produto, não detalhe de tradução.
  metas_gerenciar: 'Definir metas por praça e turno',
  // hub-motorista-360 (migration 0059). Mesmo caso do `metas_gerenciar` acima:
  // permissão nova entrou sem rótulo e apareceu como CÓDIGO CRU na matriz —
  // pego pelo `impeccable-rodada10` em 2026-09-20. Cobre a leitura de
  // `dadosPessoais`, `documentos.rg`, `documentos.cnh` e `contatoEmergencia`
  // (lib/hub-motoristas-dto.js).
  dados_sensiveis: 'Ver documentos e dados pessoais',
  // `consultar` fica fora do mapa de propósito: é o único que depende do
  // contexto do módulo. Ver `rotuloPermissao`.
};

/**
 * Permissões que concedem mais do que o nome sugere, ou cuja ação não tem
 * volta. `gerenciar` engloba o módulo inteiro; `enviar` dispara mensagem para
 * motorista real; `excluir` não desfaz; `credencial` dá acesso ao app motorista
 * a quem a receber; `dados_sensiveis` expõe documento de identidade e dado
 * pessoal (mesmo critério que pôs `adiantamentos.exportar` aqui — expor PII
 * pesa como expor dado bancário, e a migration 0059 já a trata como restrita,
 * concedida só a papel admin). Merecem destaque na tela de concessão.
 */
const ALTO_IMPACTO = new Set(['gerenciar', 'enviar', 'excluir', 'credencial', 'dados_sensiveis']);

/**
 * adiantamento-motorista (FASE 7, tasks.md 7.2.3) — rótulo por CÓDIGO
 * COMPLETO, consultado ANTES do mapa de verbos (hub-api.md §Permissões por
 * rota): dois verbos já mapeados mentiriam aqui (`exportar` = "Exportar
 * (CSV)", `gerenciar` = "Administrar tudo do módulo" — nem uma nem outra
 * descreve o que essas duas permissões fazem neste módulo); os demais
 * verbos (`contas_consultar`, `contas_revisar`, `configurar`,
 * `pagamentos_consultar`, `lote_criar`, `reprocessar`,
 * `pagamento_confirmar`) são exclusivos de `adiantamentos`, sem tradução
 * genérica possível. `consultar` fica de fora — cai no mesmo ramo
 * ambíguo-por-módulo dos demais módulos (o módulo não tem `listar`, então
 * vira "Acessar o módulo").
 */
const POR_CODIGO: Record<string, string> = {
  'adiantamentos.gerenciar': 'Rejeitar, recalcular e encerrar adiantamentos',
  'adiantamentos.configurar': 'Alterar regras do adiantamento',
  'adiantamentos.contas_consultar': 'Ver contas bancárias (mascaradas)',
  'adiantamentos.contas_revisar': 'Ver completas e aprovar contas bancárias',
  'adiantamentos.pagamentos_consultar': 'Ver pagamentos, lotes e repasse',
  'adiantamentos.lote_criar': 'Criar lote de pagamento',
  'adiantamentos.exportar': 'Baixar arquivo da Transfeera',
  'adiantamentos.reprocessar': 'Reprocessar falhas e cancelar lotes',
  'adiantamentos.pagamento_confirmar': 'Confirmar pagamentos e fechar apuração',
  // hub-motorista-360 FASE 5 — permissões da CONTA DE SERVIÇO do robô EntreGô
  // (`robo_entrego_servico`, script 003-permissoes-enriquecimento-robo-entrego.sql).
  // Precisam de override por CÓDIGO porque o código tem DOIS pontos: o
  // `partesDoCodigo` corta no primeiro, e o "verbo" vira `enriquecimento.consultar`
  // — que nenhum mapa de verbo traduz. Sem isto aparecem em código cru na matriz,
  // e o `impeccable-rodada10` NÃO pega (o regex dele exige um ponto só).
  'motoristas.enriquecimento.consultar': 'Ler a fila de enriquecimento (robô)',
  'motoristas.enriquecimento.atualizar': 'Gravar resultado do enriquecimento (robô)',
};

/** Idem, para alto impacto — só os códigos cujo VERBO ainda não está em
 * `ALTO_IMPACTO` (o de `adiantamentos.gerenciar` já está, pelo verbo
 * `gerenciar`). `adiantamentos.exportar` PRECISA de override por código: o
 * verbo `exportar` não é alto impacto em nenhum outro módulo
 * (`faturamento.exportar` etc.), mas baixar o arquivo da Transfeera expõe
 * dado bancário completo do lote inteiro. */
const ALTO_IMPACTO_POR_CODIGO = new Set([
  'adiantamentos.configurar',
  'adiantamentos.contas_revisar',
  'adiantamentos.lote_criar',
  'adiantamentos.exportar',
  'adiantamentos.reprocessar',
  'adiantamentos.pagamento_confirmar',
]);

/** `motoristas.exportar` → `{ modulo: 'motoristas', verbo: 'exportar' }`. */
export function partesDoCodigo(codigo: string): { modulo: string; verbo: string } {
  const i = codigo.indexOf('.');
  if (i < 0) return { modulo: codigo, verbo: '' };
  return { modulo: codigo.slice(0, i), verbo: codigo.slice(i + 1) };
}

export function ehAltoImpacto(codigo: string): boolean {
  if (ALTO_IMPACTO_POR_CODIGO.has(codigo)) return true;
  return ALTO_IMPACTO.has(partesDoCodigo(codigo).verbo);
}

/**
 * Rótulo legível da permissão.
 *
 * `moduloTemListar` resolve a ambiguidade real do `consultar`, que aparece em 8
 * módulos significando duas coisas: onde existe `listar` ao lado (motoristas,
 * usuários, faturamento, performance) ele é "abrir um item"; onde não existe
 * (painel, auditoria, importações, envio em massa) ele é "entrar no módulo".
 * Um rótulo único mentiria em metade dos casos — e o dado que desempata está na
 * própria lista de permissões, não numa lista manual.
 *
 * Verbo desconhecido devolve o código cru: permissão nova aparece feia, nunca
 * invisível nem com rótulo errado (mesmo fail-safe de `resolveModuleIcon`).
 */
export function rotuloPermissao(codigo: string, moduloTemListar: boolean): string {
  if (POR_CODIGO[codigo]) return POR_CODIGO[codigo];
  const { verbo } = partesDoCodigo(codigo);
  if (verbo === 'consultar') return moduloTemListar ? 'Ver detalhes' : 'Acessar o módulo';
  return VERBOS[verbo] ?? codigo;
}

/** Os módulos (por código) que têm `listar` — insumo do `rotuloPermissao`. */
export function modulosComListar(codigos: string[]): Set<string> {
  const s = new Set<string>();
  for (const c of codigos) {
    const { modulo, verbo } = partesDoCodigo(c);
    if (verbo === 'listar') s.add(modulo);
  }
  return s;
}
