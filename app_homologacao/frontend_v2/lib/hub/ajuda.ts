/**
 * Lógica pura da Central de Ajuda (app/hub/dashboard/ajuda/page.tsx) — fica
 * fora do componente para ser testável sem DOM. O texto vive em
 * lib/hub/ajuda-conteudo.json; aqui só há tipos, regras de exibição e busca.
 * Irmã de frontend_motorista/lib/ajuda.ts.
 */

import conteudoJson from './ajuda-conteudo.json';

export type TipoAviso = 'importante' | 'atencao' | 'dica';

/** Rótulo textual do aviso: o tipo não pode depender só de cor. */
export const ROTULO_AVISO: Record<TipoAviso, string> = {
  importante: 'Importante',
  atencao: 'Atenção',
  dica: 'Dica',
};

export type Bloco =
  | { bloco: 'texto'; texto: string; destaque?: boolean }
  | { bloco: 'subtitulo'; texto: string }
  | { bloco: 'lista'; itens: string[] }
  | { bloco: 'passos'; itens: string[] }
  | { bloco: 'tabela'; cabecalho: string[]; linhas: string[][] }
  | { bloco: 'aviso'; tipo: TipoAviso; titulo?: string; texto?: string; itens?: string[] }
  | { bloco: 'trilha'; passos: { titulo: string; quem: string; texto: string }[] };

export type Secao = { id: string; titulo: string; grupo: string; blocos: Bloco[] };
export type Conteudo = { subtitulo: string; atualizadoEm: string; secoes: Secao[] };

/**
 * Campos que a tela sabe renderizar, por tipo de bloco. Tipo ou campo novo no
 * JSON sem entrar aqui falha no teste — evita conteúdo invisível em silêncio.
 */
export const CAMPOS_POR_BLOCO: Record<Bloco['bloco'], readonly string[]> = {
  texto: ['bloco', 'texto', 'destaque'],
  subtitulo: ['bloco', 'texto'],
  lista: ['bloco', 'itens'],
  passos: ['bloco', 'itens'],
  tabela: ['bloco', 'cabecalho', 'linhas'],
  aviso: ['bloco', 'tipo', 'titulo', 'texto', 'itens'],
  trilha: ['bloco', 'passos'],
};

export const conteudo = conteudoJson as Conteudo;

/** Fatia de texto de um parágrafo: texto corrido ou marcação inline. */
export type Trecho =
  | { t: 'txt'; v: string }
  | { t: 'forte' | 'enfase' | 'codigo'; v: string }
  | { t: 'link'; v: string; id: string };

const INLINE = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(#([^)]+)\)/g;

/**
 * Marcação inline mínima do JSON: **negrito**, *ênfase*, `código` e
 * [texto](#secao). O resto é texto — nada vira HTML.
 */
export function partirInline(texto: string): Trecho[] {
  const out: Trecho[] = [];
  let fim = 0;
  for (const m of texto.matchAll(INLINE)) {
    if (m.index > fim) out.push({ t: 'txt', v: texto.slice(fim, m.index) });
    if (m[1] !== undefined) out.push({ t: 'forte', v: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'enfase', v: m[2] });
    else if (m[3] !== undefined) out.push({ t: 'codigo', v: m[3] });
    else out.push({ t: 'link', v: m[4], id: m[5] });
    fim = m.index + m[0].length;
  }
  if (fim < texto.length) out.push({ t: 'txt', v: texto.slice(fim) });
  return out;
}

/** Texto sem marcação inline (para busca). */
export const semMarcas = (texto: string): string =>
  partirInline(texto).map((t) => t.v).join('');

/** Todas as strings de um bloco, de qualquer formato (busca não esquece campo novo). */
function textos(valor: unknown, chave?: string): string[] {
  if (chave === 'bloco' || chave === 'tipo') return [];
  if (typeof valor === 'string') return [semMarcas(valor)];
  if (Array.isArray(valor)) return valor.flatMap((v) => textos(v));
  if (valor && typeof valor === 'object') {
    return Object.entries(valor).flatMap(([k, v]) => textos(v, k));
  }
  return [];
}

/** Minúsculas e sem acento: "previa" acha "Prévia". */
export const normalizar = (s: string): string =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function textoDaSecao(s: Secao): string {
  return normalizar([s.titulo, ...s.blocos.flatMap((b) => textos(b))].join('\n'));
}

/** Seções que contêm TODAS as palavras da busca. Busca vazia = todas. */
export function filtrarSecoes(secoes: readonly Secao[], busca: string): Secao[] {
  const termos = normalizar(busca).split(/\s+/).filter(Boolean);
  if (termos.length === 0) return [...secoes];
  return secoes.filter((s) => {
    const alvo = textoDaSecao(s);
    return termos.every((t) => alvo.includes(t));
  });
}

/** Índice agrupado, na ordem em que os grupos aparecem; o número é a posição no manual. */
export function indice(secoes: readonly Secao[], todas: readonly Secao[] = secoes) {
  const grupos: { grupo: string; itens: { id: string; titulo: string; numero: number }[] }[] = [];
  for (const s of secoes) {
    let g = grupos.find((x) => x.grupo === s.grupo);
    if (!g) grupos.push((g = { grupo: s.grupo, itens: [] }));
    g.itens.push({ id: s.id, titulo: s.titulo, numero: todas.findIndex((x) => x.id === s.id) + 1 });
  }
  return grupos;
}
