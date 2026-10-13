/**
 * Lógica pura da tela de Ajuda (app/(app)/ajuda/page.tsx) — fica fora do
 * componente para ser testável com `node --test` (o app não tem jsdom).
 * O texto vive em lib/ajuda-conteudo.json; aqui só há regras de exibição.
 */

export type TipoAviso = 'importante' | 'atencao' | 'dica';

/** Rótulo textual do aviso: o tipo não pode depender só de cor. */
export const ROTULO_AVISO: Record<TipoAviso, string> = {
  importante: 'Importante',
  atencao: 'Atenção',
  dica: 'Dica',
};

/** Imagens ficam em public/ajuda/img/ e são servidas em /ajuda/img/<arquivo>. */
export function imagemSrc(arquivo: string): string {
  return `/ajuda/img/${encodeURIComponent(arquivo)}`;
}

/**
 * Imagem que falhou: o erro pode ocorrer antes da hidratação (onError nunca
 * dispara), então o componente também confere o estado do elemento no mount.
 * `complete` com largura natural 0 = carregou "vazia", ou seja, 404.
 */
export function imagemQuebrada(img: { complete: boolean; naturalWidth: number }): boolean {
  return img.complete && img.naturalWidth === 0;
}

/**
 * Seção a abrir por deep link (`/ajuda#conta`). Só devolve ids que existem:
 * hash arbitrário nunca vira seletor nem abre nada.
 */
export function secaoDoHash(hash: string, ids: readonly string[]): string | null {
  const id = hash.replace(/^#/, '');
  return ids.includes(id) ? id : null;
}
