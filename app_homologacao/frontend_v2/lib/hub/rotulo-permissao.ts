// impeccable rodada 10 (A7 da crítica medida) — a matriz papel×permissão
// exibia o código cru ao usuário: `usuarios.gerenciar`, `motoristas.credencial`.
// Quem concede acesso precisa ler o que a permissão FAZ; quem dá suporte e quem
// lê auditoria é que precisa do código — por isso ele continua na tela, como
// legenda, e não some.
//
// São 34 permissões e apenas 12 verbos. O rótulo se deriva de verbo + módulo,
// e o nome legível do módulo já vem do `GET /me` — nenhuma tabela de 34 linhas
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
  // `consultar` fica fora do mapa de propósito: é o único que depende do
  // contexto do módulo. Ver `rotuloPermissao`.
};

/**
 * Permissões que concedem mais do que o nome sugere, ou cuja ação não tem
 * volta. `gerenciar` engloba o módulo inteiro; `enviar` dispara mensagem para
 * motorista real; `excluir` não desfaz; `credencial` dá acesso ao app motorista
 * a quem a receber. Merecem destaque na tela de concessão.
 */
const ALTO_IMPACTO = new Set(['gerenciar', 'enviar', 'excluir', 'credencial']);

/** `motoristas.exportar` → `{ modulo: 'motoristas', verbo: 'exportar' }`. */
export function partesDoCodigo(codigo: string): { modulo: string; verbo: string } {
  const i = codigo.indexOf('.');
  if (i < 0) return { modulo: codigo, verbo: '' };
  return { modulo: codigo.slice(0, i), verbo: codigo.slice(i + 1) };
}

export function ehAltoImpacto(codigo: string): boolean {
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
