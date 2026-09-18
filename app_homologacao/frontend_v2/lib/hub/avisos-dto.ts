// hub-avisos (push-motorista, FASE 7 — tasks.md 7.1.2) — tipos + parse/
// validação de shape para o contrato `/api/v1/avisos*`.
//
// Mesmo papel de lib/hub/importacoes-dto.ts: o backend
// (routes/hub-avisos.js) já responde em camelCase — aqui só espelhamos os
// tipos do contrato em TS e validamos defensivamente o SHAPE da resposta
// (nunca confiar cegamente que a rede devolveu exatamente o prometido).
//
// Ref: docs/specs/envioMassa_homologacao/contracts/hub-avisos.md.

export type StatusAviso = 'na_fila' | 'em_andamento' | 'concluido';
export type ModoDestinatarios = 'toda_base' | 'individual' | 'empresa';

export const MODOS_DESTINATARIOS: ModoDestinatarios[] = ['toda_base', 'individual', 'empresa'];

export const STATUS_AVISO_LABELS: Record<StatusAviso, string> = {
  na_fila: 'Na fila',
  em_andamento: 'Em andamento',
  concluido: 'Concluído',
};

// FASE 7 (tasks.md 7.2/7.4) — rótulo do modo de destinatários, compartilhado
// entre a lista (`/hub/dashboard/avisos`), o detalhe (`/avisos/[id]`) e o
// diálogo "Novo aviso" (evita 3 cópias divergentes do mesmo texto).
export const MODO_DESTINATARIOS_LABELS: Record<ModoDestinatarios, string> = {
  toda_base: 'Toda a base',
  individual: 'Motoristas específicos',
  empresa: 'Empresa / filial',
};

// ────────────────────────────────────────────────────────────────────────────
// helpers de shape (mesmo molde de importacoes-dto.ts)
// ────────────────────────────────────────────────────────────────────────────

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isNumber(v: unknown): v is number {
  return typeof v === 'number';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}
function numeroOuZero(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

// ────────────────────────────────────────────────────────────────────────────
// GET /avisos — lista paginada
// ────────────────────────────────────────────────────────────────────────────

export interface AvisoContagensLista {
  visados: number;
  pendentes: number;
  aceitos: number;
  falhas: number;
  mortas: number;
}

export interface AvisoListItem {
  id: number;
  titulo: string;
  status: StatusAviso;
  modoDestinatarios: ModoDestinatarios;
  criadoEm: string;
  contagens: AvisoContagensLista;
}

export interface AvisoListResponse {
  itens: AvisoListItem[];
  total: number;
  page: number;
  pageSize: number;
}

function parseContagensLista(raw: unknown): AvisoContagensLista {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    visados: numeroOuZero(r.visados),
    pendentes: numeroOuZero(r.pendentes),
    aceitos: numeroOuZero(r.aceitos),
    falhas: numeroOuZero(r.falhas),
    mortas: numeroOuZero(r.mortas),
  };
}

export function parseAvisoListItem(raw: unknown): AvisoListItem {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Item de aviso inválido: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!isNumber(r.id) || !isString(r.titulo) || !isString(r.status)) {
    throw new TypeError('Item de aviso inválido: id/titulo/status ausentes');
  }
  return {
    id: r.id,
    titulo: r.titulo,
    status: r.status as StatusAviso,
    modoDestinatarios: (isString(r.modoDestinatarios) ? r.modoDestinatarios : 'toda_base') as ModoDestinatarios,
    criadoEm: isString(r.criadoEm) ? r.criadoEm : '',
    contagens: parseContagensLista(r.contagens),
  };
}

export function parseAvisoListResponse(raw: unknown): AvisoListResponse {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de lista de avisos inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.itens)) {
    throw new TypeError('Resposta de lista de avisos inválida: itens não é array');
  }
  return {
    itens: r.itens.map(parseAvisoListItem),
    total: numeroOuZero(r.total),
    page: typeof r.page === 'number' ? r.page : 1,
    pageSize: typeof r.pageSize === 'number' ? r.pageSize : r.itens.length,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /avisos/:id — detalhe
// ────────────────────────────────────────────────────────────────────────────

export interface AvisoContagensDetalhe extends AvisoContagensLista {
  processando: number;
}

export interface EmpresaDestino {
  id: number;
  nome: string | null;
}

/** `{}` (toda a base) | `{empresas}` (modo empresa) | `{qtdMotoristas}` (individual). */
export type AvisoDestinatarios =
  | Record<string, never>
  | { empresas: EmpresaDestino[] }
  | { qtdMotoristas: number };

export interface AvisoDetalhe {
  id: number;
  titulo: string;
  corpo: string;
  status: StatusAviso;
  modoDestinatarios: ModoDestinatarios;
  destinatarios: AvisoDestinatarios;
  criadoEm: string;
  iniciadoEm: string | null;
  concluidoEm: string | null;
  contagens: AvisoContagensDetalhe;
}

function parseEmpresaDestino(raw: unknown): EmpresaDestino {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { id: numeroOuZero(r.id), nome: isStringOrNull(r.nome) ? r.nome : null };
}

function parseDestinatarios(raw: unknown): AvisoDestinatarios {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (Array.isArray(r.empresas)) return { empresas: r.empresas.map(parseEmpresaDestino) };
  if (typeof r.qtdMotoristas === 'number') return { qtdMotoristas: r.qtdMotoristas };
  return {};
}

function parseContagensDetalhe(raw: unknown): AvisoContagensDetalhe {
  return { ...parseContagensLista(raw), processando: numeroOuZero((raw as Record<string, unknown>)?.processando) };
}

// FASE 7 task 7.4.3 (SC-006): com `concluido`, aceitos+falhas+mortas MUST
// bater com visados (contracts/hub-avisos.md §GET /avisos/:id). Não lança —
// é sinal de qualidade de exibição, não um contrato rígido do parser (uma
// divergência aqui é bug do BACKEND, não motivo para a tela quebrar) — só
// avisa em dev via console.warn para o achado não passar despercebido.
export function contagensBatem(detalhe: {
  status: StatusAviso;
  contagens: Pick<AvisoContagensDetalhe, 'visados' | 'aceitos' | 'falhas' | 'mortas'>;
}): boolean {
  if (detalhe.status !== 'concluido') return true;
  const { visados, aceitos, falhas, mortas } = detalhe.contagens;
  return aceitos + falhas + mortas === visados;
}

export function parseAvisoDetalhe(raw: unknown): AvisoDetalhe {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Detalhe de aviso inválido: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!isNumber(r.id) || !isString(r.titulo) || !isString(r.status)) {
    throw new TypeError('Detalhe de aviso inválido: id/titulo/status ausentes');
  }
  const resultado: AvisoDetalhe = {
    id: r.id,
    titulo: r.titulo,
    corpo: isString(r.corpo) ? r.corpo : '',
    status: r.status as StatusAviso,
    modoDestinatarios: (isString(r.modoDestinatarios) ? r.modoDestinatarios : 'toda_base') as ModoDestinatarios,
    destinatarios: parseDestinatarios(r.destinatarios),
    criadoEm: isString(r.criadoEm) ? r.criadoEm : '',
    iniciadoEm: isStringOrNull(r.iniciadoEm) ? r.iniciadoEm : null,
    concluidoEm: isStringOrNull(r.concluidoEm) ? r.concluidoEm : null,
    contagens: parseContagensDetalhe(r.contagens),
  };
  if (process.env.NODE_ENV !== 'production' && !contagensBatem(resultado)) {
    const { visados, aceitos, falhas, mortas } = resultado.contagens;
    console.warn(
      `AvisoDetalhe #${resultado.id}: aceitos+falhas+mortas (${aceitos + falhas + mortas}) != visados (${visados}) com status concluido`
    );
  }
  return resultado;
}

// ────────────────────────────────────────────────────────────────────────────
// GET /avisos/alcance
// ────────────────────────────────────────────────────────────────────────────

// D-15 (FASE 5, 5.3.1): `motoristas` passou a ser o público TOTAL do
// histórico (inclui quem não tem push); `comPush` é o antigo `motoristas`
// (CNPJs distintos com PushInscricao). `inscricoes` não muda de sentido.
export interface AvisoAlcance {
  motoristas: number;
  comPush: number;
  inscricoes: number;
}

export function parseAvisoAlcance(raw: unknown): AvisoAlcance {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    motoristas: numeroOuZero(r.motoristas),
    comPush: numeroOuZero(r.comPush),
    inscricoes: numeroOuZero(r.inscricoes),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// POST /avisos
// ────────────────────────────────────────────────────────────────────────────

export interface AvisoCriado {
  id: number;
  status: StatusAviso;
  visados: number;
}

export function parseAvisoCriado(raw: unknown): AvisoCriado {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de criação de aviso inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!isNumber(r.id) || !isString(r.status)) {
    throw new TypeError('Resposta de criação de aviso inválida: id/status ausentes');
  }
  return { id: r.id, status: r.status as StatusAviso, visados: numeroOuZero(r.visados) };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /avisos/destinatarios/{empresas,motoristas}
// ────────────────────────────────────────────────────────────────────────────

export interface MotoristaDestino {
  id: number;
  nome: string;
}

export function parseEmpresasDestinoResponse(raw: unknown): { empresas: EmpresaDestino[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { empresas: Array.isArray(r.empresas) ? r.empresas.map(parseEmpresaDestino) : [] };
}

export function parseMotoristasDestinoResponse(raw: unknown): { motoristas: MotoristaDestino[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const motoristas = Array.isArray(r.motoristas)
    ? r.motoristas.map((m) => {
        const mr = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
        return { id: numeroOuZero(mr.id), nome: isString(mr.nome) ? mr.nome : '' };
      })
    : [];
  return { motoristas };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /avisos/cobertura
// ────────────────────────────────────────────────────────────────────────────

export interface AvisosCobertura {
  ativos: { android: number; ios: number; desktopOutros: number };
  impedidos: { iosSemInstalacao: number; bloqueadas: number; semSuporte: number };
  naoAtivadas: number;
}

export function parseAvisosCobertura(raw: unknown): AvisosCobertura {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ativos = (r.ativos && typeof r.ativos === 'object' ? r.ativos : {}) as Record<string, unknown>;
  const impedidos = (r.impedidos && typeof r.impedidos === 'object' ? r.impedidos : {}) as Record<string, unknown>;
  return {
    ativos: {
      android: numeroOuZero(ativos.android),
      ios: numeroOuZero(ativos.ios),
      desktopOutros: numeroOuZero(ativos.desktopOutros),
    },
    impedidos: {
      iosSemInstalacao: numeroOuZero(impedidos.iosSemInstalacao),
      bloqueadas: numeroOuZero(impedidos.bloqueadas),
      semSuporte: numeroOuZero(impedidos.semSuporte),
    },
    naoAtivadas: numeroOuZero(r.naoAtivadas),
  };
}
