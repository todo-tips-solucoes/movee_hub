// impeccable rodada 18 (h4=2) — a largura de cada tela do hub, com regra.
//
// A crítica registrou "5 larguras de container" como se fossem arbitrárias.
// Medindo as 13 páginas, o retrato é outro: já existia um padrão de fato
// — 6 listas em `96rem`, 3 detalhes em `3xl` — e três telas fora dele
// (`usuarios` em `4xl`, `usuarios/papeis` em `5xl`, o dashboard em `5xl`).
// O defeito não era a variedade, era a variedade SEM CRITÉRIO: nada dizia
// qual usar, então cada tela nova escolhia por conta.
//
// Estas constantes são esse critério, e `larguras.test.ts` o transforma em
// gate: uma página do hub que invente a própria largura quebra o teste.
//
// O dashboard fica de fora deliberadamente (ver LARGURA_HOME).

/** Telas de trabalho: tabela ou lista que se beneficia de largura total. */
export const LARGURA_LISTA = 'max-w-[96rem]';

/** Detalhe de UM registro — texto e formulário, onde linha longa cansa. */
export const LARGURA_DETALHE = 'max-w-3xl';

/** Formulário pessoal curto (perfil): estreito de propósito. */
export const LARGURA_FORM = 'max-w-lg';

/**
 * A home é grade de cards, não tabela: esticada a 96rem os cards viram faixas.
 * Mantida em `5xl` — e nomeada aqui para ser uma decisão, não um resíduo.
 */
export const LARGURA_HOME = 'max-w-5xl';

export const LARGURAS_PERMITIDAS = [
  LARGURA_LISTA,
  LARGURA_DETALHE,
  LARGURA_FORM,
  LARGURA_HOME,
] as const;
