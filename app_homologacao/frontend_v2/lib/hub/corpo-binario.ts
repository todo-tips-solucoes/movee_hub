// Proxy `/api/[...path]`: content-types cujo corpo é BINÁRIO. `req.text()`
// decodifica UTF-8 e todo byte >= 0x80 inválido vira U+FFFD, corrompendo o
// arquivo antes do backend. Tabela mime → teto em bytes (checado ANTES de ler
// o corpo, pois o proxy bufferiza antes da autenticação do backend).
import { XLSX_MIME, XLSX_MAX_BYTES } from './retorno-xlsx';

/** Foto de prêmio de campanha: a rota do backend aceita até 600 KB. */
export const FOTO_MAX_BYTES = 600 * 1024;

export const CORPO_BINARIO_MAX_BYTES: Record<string, number> = {
  [XLSX_MIME]: XLSX_MAX_BYTES,
  'image/jpeg': FOTO_MAX_BYTES,
  'image/png': FOTO_MAX_BYTES,
  'image/webp': FOTO_MAX_BYTES,
};

/** Teto do mime (comparado por IGUALDADE, ignorando parâmetros) ou undefined se não é binário. */
export function tetoBinario(contentType: string): number | undefined {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CORPO_BINARIO_MAX_BYTES, mime) ? CORPO_BINARIO_MAX_BYTES[mime] : undefined;
}
