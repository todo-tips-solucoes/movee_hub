/**
 * Tradução dos campos reprovados na validação da nota (EnvioMassa.erro_validacao)
 * para mensagens pt-BR. Fonte única: validar-nota, notas-pendentes/:id/validar e
 * GET /motorista/notas-pendentes usam este módulo.
 *
 * Formato real em produção: "valid_cnpj, valid_descricao_servico, valid_trib_nac"
 * (códigos separados por vírgula, com ou sem espaço).
 */
'use strict';

// Mapeamento campo → mensagem pt-BR (data-model.md §ResultadoValidacao / FR-009)
const FIELD_MESSAGES = {
  valid_cnpj_prestador: 'CNPJ do prestador (você) está incorreto na nota.',
  valid_cnpj: 'CNPJ do tomador está incorreto na nota.',
  valid_descricao_servico: 'Descrição do serviço está incorreta.',
  valid_valor: 'Valor da nota não confere com o valor do movimento.',
  valid_trib_nac: 'Tributação nacional (TribNac) está incorreta.',
  valid_trib_mun: 'Tributação municipal está incorreta.',
  valid_dCompet: 'Data de competência (dCompet) está incorreta.',
};

const MENSAGEM_PADRAO = 'Campo inválido na nota.';

/** "valid_cnpj, valid_valor" -> [{ campo, mensagem }]. Vazio/nulo -> []. Código desconhecido -> mensagem padrão. */
function camposInvalidosDe(erroValidacao) {
  return String(erroValidacao || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((campo) => ({ campo, mensagem: FIELD_MESSAGES[campo] || MENSAGEM_PADRAO }));
}

module.exports = { FIELD_MESSAGES, camposInvalidosDe };
