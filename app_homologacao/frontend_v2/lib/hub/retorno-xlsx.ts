// Constantes do retorno da Transfeera em XLSX, compartilhadas por TRÊS camadas
// que precisam concordar (e que nenhuma cobre pelas outras): o proxy
// `app/api/[...path]/route.ts` (corpo binário + teto), `adiantamentos-api.ts`
// (header do POST) e o dialog (teto no cliente, antes do upload). Só constantes:
// importável do servidor e do cliente sem puxar nenhum código de fetch.

/** Mime OOXML de planilha — o ÚNICO content-type que a rota de retorno aceita. */
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Teto de transporte (= `express.raw({ limit: '10mb' })` do backend). */
export const XLSX_MAX_BYTES = 10 * 1024 * 1024;
