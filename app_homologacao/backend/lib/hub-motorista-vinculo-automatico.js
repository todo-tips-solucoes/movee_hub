/**
 * hub-motorista-vinculo-automatico.js — FASE 3 (hub-motorista-360, tasks.md
 * 3.1/3.2): vínculo automático de credencial (FR-009..FR-012, contracts/
 * vinculo-automatico.md). Único lugar onde a lógica dos "passos 1-5" mora —
 * reusada por DOIS callers: o hook pós-registro (`routes/motorista.js`
 * `POST /register`) e o script de backfill retroativo
 * (`scripts/backfill-vinculo-motorista.js`, FR-012). Nunca duplicada.
 *
 * Passo 1-2 (localizar/criar `ContaMotorista` por `cnpj_prestador`) espelha
 * o padrão já existente em `routes/hub-motoristas.js` (find-or-create de
 * `POST /:id/credencial`). Passo 4 (achar `Entregador` por similaridade de
 * nome) chama a RPC `hub_motoristas_candidatos_por_conta` (migration 0058)
 * — `Entregador` não tem CNPJ, o casamento NUNCA é por CNPJ nesse passo.
 *
 * Escopo (`claims.escopo`) para as chamadas que tocam `Entregador` (RLS,
 * migration 0015): o grupo Movee INTEIRO (`EmpresaGrupoMovee`, migration
 * 0022), nunca uma comparação direta de `id_empresa` — o `Entregador`
 * candidato pode estar em QUALQUER empresa do grupo (CLAUDE.md: usar
 * `mesmoGrupoQue`/critério de grupo, nunca `id_empresa === 6` estrito; o
 * equivalente do lado do hub é o JOIN/allowlist `EmpresaGrupoMovee`, já
 * usado por `hub_motoristas_candidatos_por_conta` e por
 * `entidadeEhElegivel` em `routes/hub-motoristas.js`).
 *
 * `deps` (2º parâmetro, opcional) é injeção de dependência PARA TESTE —
 * mesmo espírito do `init({ postgrestRequest, ... })` de
 * `routes/motorista.js` — nunca usado pelos 2 callers reais (hook e
 * backfill), que sempre chamam com o default (`hubPostgrestRequest`/
 * `registrarAuditoria` reais). Permite testar toda a orquestração
 * (idempotência, escopo, decisão, auditoria) com `node --test` sem
 * PostgREST/DB real — mesmo padrão de mock em memória de
 * `tests/motorista-integration.test.js`.
 *
 * `falha não bloqueia o cadastro` (contracts/vinculo-automatico.md): esta
 * função só rejeita a Promise em falha de I/O real (rede, PostgREST fora do
 * ar, RLS negando por má configuração) — o caller (rota `/register`) MUST
 * envolver a chamada em try/catch isolado, sem alterar a resposta já
 * existente. Condições de NEGÓCIO esperadas (grupo vazio, sem candidato,
 * ambíguo, já vinculado) nunca lançam — retornam `status` descritivo.
 *
 * Ref: docs/specs/hub-motorista-360/contracts/vinculo-automatico.md,
 * data-model.md §Function hub_motoristas_candidatos_por_conta, spec.md
 * FR-009..FR-012.
 */

'use strict';

const { hubPostgrestRequest } = require('./hub-postgrest');
const { registrarAuditoria } = require('./hub-auditoria');

// Limiar de "correspondência confiável" do vínculo AUTOMÁTICO (FR-009) —
// mais estrito que o piso 0.3 usado só para SUGERIR candidatos a um humano
// (RPC hub_motoristas_candidatos_por_conta, migration 0058). Os dois
// números nunca devem ser confundidos (ver cabeçalho da migration 0058).
const LIMIAR_VINCULO_AUTOMATICO = 0.9;

// Deadline da operação INTEIRA (não por chamada) — tasks.md 3.1.9, subtarefa
// EMERGENTE dec-060 (2026-09-04): o try/catch da 3.1.4 protege contra
// exceção, não contra hang. Sem timeout, um PostgREST no ar porém lento
// trava o `POST /motorista/register` indefinidamente. Estouro = mesmo
// desfecho de qualquer falha de negócio: não vincula, caller responde 201.
const DEADLINE_VINCULO_AUTOMATICO_MS = 5000;

/**
 * Regra de decisão do vínculo automático (FR-009, Acceptance Scenario 3 —
 * "não vincula silenciosamente a um motorista errado"): vincula SOMENTE
 * quando há exatamente 1 candidato com `similaridade >= 0.9`. PURA — sem
 * I/O, testável isoladamente (tasks.md 3.1.6 happy path / 3.1.7 ambíguo).
 * @param {Array<{entregadorId:number, nome:string, idEmpresa:number, similaridade:number}>} candidatos
 * @returns {{entregadorId:number, nome:string, idEmpresa:number, similaridade:number}|null}
 */
function escolherCandidatoConfiavel(candidatos) {
  const confiaveis = (candidatos || []).filter((c) => c.similaridade >= LIMIAR_VINCULO_AUTOMATICO);
  return confiaveis.length === 1 ? confiaveis[0] : null;
}

/** Mapeia 1 linha (snake_case) de `hub_motoristas_candidatos_por_conta` (migration 0058). */
function mapCandidatoRpc(row) {
  return {
    entregadorId: row.entregador_id,
    nome: row.nome,
    idEmpresa: row.id_empresa,
    similaridade: row.similaridade,
  };
}

/**
 * Vínculo automático de credencial (FR-009..FR-011). Ver cabeçalho do
 * arquivo para o contrato completo (quando lança vs. quando retorna status
 * descritivo).
 * @param {{cnpjPrestador:string, nome:string}} params - `cnpjPrestador` já
 *   normalizado (só dígitos). `nome` só é usado se a `ContaMotorista`
 *   precisar ser CRIADA — nunca sobrescreve o nome de uma conta já existente
 *   (mesmo padrão conservador de `POST /:id/credencial`).
 * @param {{hubPostgrestRequest?:Function, registrarAuditoria?:Function}} [deps]
 *   - injeção de dependência para teste (ver cabeçalho do arquivo).
 * @returns {Promise<{status:string, contaMotoristaId?:number, entregadorId?:number, similaridade?:number}>}
 *   `status` ∈ `vinculado | ja_vinculado | ambiguo | sem_candidato | sem_grupo_elegivel`
 */
async function vincularAutomaticamente({ cnpjPrestador, nome }, deps = {}) {
  const postgrest = deps.hubPostgrestRequest || hubPostgrestRequest;
  const auditar = deps.registrarAuditoria || registrarAuditoria;
  // Deadline único para as 6 chamadas HTTP abaixo (tasks.md 3.1.9) — a
  // OPERAÇÃO inteira tem 5s, não cada chamada individualmente.
  const signal = AbortSignal.timeout(DEADLINE_VINCULO_AUTOMATICO_MS);

  // 1-2. localizar/criar ContaMotorista por cnpj_prestador (migration 0021
  // — sem RLS, GRANT direto a `authenticated`; claims vazias bastam).
  const existentes = await postgrest(
    `ContaMotorista?cnpj_prestador=eq.${encodeURIComponent(cnpjPrestador)}&select=id`,
    'GET', null, {}, { signal }
  );
  let contaMotoristaId = existentes && existentes[0] && existentes[0].id;
  if (!contaMotoristaId) {
    const criados = await postgrest(
      'ContaMotorista', 'POST',
      { cnpj_prestador: cnpjPrestador, nome: String(nome || '').trim(), ativo: true },
      {}, { signal }
    );
    contaMotoristaId = criados && criados[0] && criados[0].id;
  }
  if (!contaMotoristaId) {
    return { status: 'erro_conta' };
  }

  // Escopo = grupo Movee inteiro (allowlist sem RLS, migration 0022) — ver
  // cabeçalho do arquivo. Sem isto, a RLS de "Entregador" (migration 0015)
  // barra qualquer leitura/escrita adiante, mesmo com o JOIN da RPC.
  const grupoMovee = await postgrest('EmpresaGrupoMovee?select=id_empresa', 'GET', null, {}, { signal });
  const idsMovee = (grupoMovee || []).map((r) => r.id_empresa);
  if (idsMovee.length === 0) {
    return { status: 'sem_grupo_elegivel', contaMotoristaId };
  }
  const claimsEscopo = { escopo: idsMovee };

  // 3. Idempotência (FR-011): já existe Entregador apontando para ESTA
  // conta? Não faz nada (nem chama a RPC).
  const jaVinculados = await postgrest(
    `Entregador?motorista_id=eq.${contaMotoristaId}&select=id`,
    'GET', null, claimsEscopo, { signal }
  );
  if (jaVinculados && jaVinculados.length > 0) {
    return { status: 'ja_vinculado', contaMotoristaId, entregadorId: jaVinculados[0].id };
  }

  // 4. Candidatos por similaridade de NOME (RPC 0058) — nunca por CNPJ
  // (Entregador não tem essa coluna).
  const linhasRpc = await postgrest(
    'rpc/hub_motoristas_candidatos_por_conta',
    'POST', { p_conta_motorista_id: contaMotoristaId }, claimsEscopo, { signal }
  );
  const candidato = escolherCandidatoConfiavel((linhasRpc || []).map(mapCandidatoRpc));
  if (!candidato) {
    const acimaDoLimiar = (linhasRpc || []).filter((r) => r.similaridade >= LIMIAR_VINCULO_AUTOMATICO).length;
    return { status: acimaDoLimiar === 0 ? 'sem_candidato' : 'ambiguo', contaMotoristaId };
  }

  // 5. Vincular + auditar (FR-009). Auditoria SEM usuarioId humano — ação
  // do sistema (contracts/vinculo-automatico.md §Auditoria).
  await postgrest(
    `Entregador?id=eq.${candidato.entregadorId}&id_empresa=eq.${candidato.idEmpresa}`,
    'PATCH', { motorista_id: contaMotoristaId }, claimsEscopo,
    { returnMinimal: true, signal }
  );
  await auditar({
    idEmpresa: candidato.idEmpresa,
    acao: 'motorista.vinculado_automaticamente',
    recurso: 'Entregador',
    recursoId: candidato.entregadorId,
    detalhes: { contaMotoristaId, similaridade: candidato.similaridade },
    claims: { empresaAtiva: candidato.idEmpresa, escopo: idsMovee },
  });

  return {
    status: 'vinculado',
    contaMotoristaId,
    entregadorId: candidato.entregadorId,
    similaridade: candidato.similaridade,
  };
}

module.exports = {
  LIMIAR_VINCULO_AUTOMATICO,
  DEADLINE_VINCULO_AUTOMATICO_MS,
  escolherCandidatoConfiavel,
  vincularAutomaticamente,
};
