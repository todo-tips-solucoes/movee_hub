// Troca de CNPJ do motorista — frente motorista-cadastro-hub (F3).
//
// Ponto único: o painel legado (PATCH /update-envio-massa/:id) e o hub
// (PATCH /motoristas/:id/credencial/cnpj) chamam a MESMA RPC
// `hub_motorista_trocar_cnpj` (migration 0124), que valida, pré-checa conflito e
// migra ContaMotorista/Motorista/EnvioMassa numa transação. Nada de lógica de
// troca fora do banco; aqui só fica a tradução do erro da RPC.
//
// `request` é injetado (hubPostgrestRequest com claims no hub, postgrestRequest
// no legado) — as duas assinaturas são (endpoint, método, corpo).
'use strict';

const onlyDigits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const isCnpj14 = (digits) => /^\d{14}$/.test(digits);

/** Corpo do PATCH do hub: allowlist estrita `{cnpjPrestador}` com 14 dígitos. */
function validarTrocaCnpjBody(corpoCru) {
  const corpo = corpoCru && typeof corpoCru === 'object' ? corpoCru : {};
  if (typeof corpo.cnpjPrestador !== 'string') return { ok: false, erro: 'cnpj_invalido' };
  const cnpj = onlyDigits(corpo.cnpjPrestador);
  if (!isCnpj14(cnpj)) return { ok: false, erro: 'cnpj_invalido' };
  return { ok: true, cnpjPrestador: cnpj };
}

function lerCorpoDoErro(err) {
  try { return JSON.parse(err && err.body); } catch { return {}; }
}

/**
 * Chama a RPC e classifica o desfecho.
 * @returns {Promise<{ok:true,resultado:object}|{conflito:true}|{invalido:true}|{foraDoGrupo:true}|{naoEncontrado:true}|{error:Error}>}
 */
async function trocarCnpjMotorista(request, { cnpjAntigo, cnpjNovo, idEmpresa }) {
  try {
    const resultado = await request('rpc/hub_motorista_trocar_cnpj', 'POST', {
      p_cnpj_antigo: cnpjAntigo, p_cnpj_novo: cnpjNovo, p_id_empresa: idEmpresa,
    });
    return { ok: true, resultado: resultado || {} };
  } catch (err) {
    const corpo = lerCorpoDoErro(err);
    // 23505 também vem do gatilho G2/G4 (colisão de UNIQUE que o pré-check não viu): fail-closed = conflito
    if (corpo.message === 'CNPJ_CONFLITO' || corpo.code === '23505') return { conflito: true };
    if (corpo.message === 'CNPJ_INVALIDO') return { invalido: true };
    if (corpo.message === 'EMPRESA_FORA_DO_GRUPO') return { foraDoGrupo: true };
    if (corpo.message === 'CNPJ_NAO_ENCONTRADO') return { naoEncontrado: true };
    return { error: err };
  }
}

/**
 * Trecho "mudou o CNPJ" do PATCH /update-envio-massa/:id (painel legado e tela do hub).
 * Devolve `{ok:true}` (segue o fluxo) ou `{status, body}` (responder e parar).
 * Empresa do grupo Movee -> RPC; fora do grupo -> só os movimentos (FR-013), sem tocar Motorista.
 */
async function trocarCnpjDoMovimento({ id, idEmp, cnpjRaw, request, mesmoGrupoQue }) {
  const cnpjNovo = onlyDigits(cnpjRaw);
  if (!isCnpj14(cnpjNovo)) {
    return { status: 400, body: { error: 'CNPJ inválido — deve conter 14 dígitos.' } };
  }

  // ownership atômico anti-IDOR: o movimento tem de ser desta empresa
  const movimentos = await request(`EnvioMassa?id=eq.${id}&id_empresa=eq.${idEmp}&select=cnpj_prestador`);
  if (!Array.isArray(movimentos) || movimentos.length === 0) {
    return { status: 404, body: { error: 'Movimento não encontrado.' } };
  }
  const cnpjAntigo = onlyDigits(movimentos[0].cnpj_prestador);
  if (cnpjNovo === cnpjAntigo) return { ok: true };

  if (!(await mesmoGrupoQue(idEmp, 6, {}))) {
    await request(
      `EnvioMassa?id_empresa=eq.${idEmp}&cnpj_prestador=eq.${encodeURIComponent(cnpjAntigo)}`,
      'PATCH', { cnpj_prestador: cnpjNovo }
    );
    return { ok: true };
  }

  const r = await trocarCnpjMotorista(request, { cnpjAntigo, cnpjNovo, idEmpresa: idEmp });
  if (r.ok) return { ok: true };
  if (r.conflito) return { status: 409, body: { error: 'CNPJ já cadastrado para outro motorista.' } };
  if (r.invalido) return { status: 400, body: { error: 'CNPJ inválido — deve conter 14 dígitos.' } };
  if (r.naoEncontrado) return { status: 404, body: { error: 'Movimento não encontrado.' } };
  if (r.foraDoGrupo) return { status: 403, body: { error: 'empresa fora do escopo' } };
  console.error('[PATCH /update-envio-massa] falha na troca de CNPJ (nada foi migrado):', r.error && r.error.message ? r.error.message : String(r.error));
  return { status: 500, body: { error: 'Não foi possível trocar o CNPJ. Nada foi alterado.' } };
}

module.exports = { onlyDigits, isCnpj14, validarTrocaCnpjBody, trocarCnpjMotorista, trocarCnpjDoMovimento };
