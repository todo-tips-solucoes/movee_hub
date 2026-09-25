// "Esqueci minha senha" do app do motorista — lógica pura, sem I/O.
//
// Até 2026-09-24 não existia recuperação nenhuma: o motorista que esquecesse a
// senha dependia de alguém do hub acionar o reset e informar a nova por fora.
// Este módulo é a parte que decide O QUE mostrar; o envio e o banco ficam na
// rota.

/** Quanto do e-mail aparece na resposta.
 *
 * Decisão do operador (2026-09-24): mostrar o e-mail FRAGMENTADO para onde a
 * recuperação foi enviada — quem tem mais de uma caixa precisa saber qual
 * checar. O custo aceito é que a resposta confirma a existência daquele
 * cadastro; por isso nada além do e-mail é revelado, e a máscara preserva só o
 * suficiente para reconhecer, nunca para reconstruir.
 *
 *   "fulano.silva@gmail.com" -> "fu***@gm***.com"
 *   "ab@x.com"               -> "a***@x***.com"
 */
function mascararEmail(emailBruto) {
  if (emailBruto === null || emailBruto === undefined) return null;
  const email = String(emailBruto).trim().toLowerCase();
  const arroba = email.lastIndexOf('@');
  if (arroba <= 0 || arroba === email.length - 1) return null;

  const usuario = email.slice(0, arroba);
  const dominio = email.slice(arroba + 1);
  // PRIMEIRO ponto, não o último: com o último, "b.com.br" viraria "b.***.br",
  // que confunde mais do que esconde. Com o primeiro vira "b***.com.br".
  const ponto = dominio.indexOf('.');
  if (ponto <= 0) return null;

  const servidor = dominio.slice(0, ponto);
  const tld = dominio.slice(ponto); // inclui o ponto

  // 2 caracteres quando dá, 1 quando o pedaço é curto: revelar metade de um
  // usuário de 3 letras não mascara nada.
  const visivel = (s) => (s.length >= 4 ? s.slice(0, 2) : s.slice(0, 1));
  return `${visivel(usuario)}***@${visivel(servidor)}***${tld}`;
}

/** Motivos pelos quais um pedido não gera envio. Viram trilha de auditoria —
 *  nunca chegam ao motorista, que recebe sempre a mesma resposta. */
const MOTIVOS_SEM_ENVIO = {
  CNPJ_NAO_ENCONTRADO: 'Nenhuma conta com este CNPJ.',
  SEM_EMAIL: 'A conta existe mas não tem e-mail cadastrado.',
  CONTA_INATIVA: 'A conta está desativada.',
};

/**
 * Decide o desfecho do pedido, a partir do que o banco devolveu.
 *
 * @param conta  linha de ContaMotorista, ou null se o CNPJ não existe
 * @returns {{enviar:boolean, emailMascarado:string|null, motivo:string|null}}
 */
function planejarRecuperacao(conta) {
  if (!conta) return { enviar: false, emailMascarado: null, motivo: 'CNPJ_NAO_ENCONTRADO' };
  if (conta.ativo === false) return { enviar: false, emailMascarado: null, motivo: 'CONTA_INATIVA' };
  const mascarado = mascararEmail(conta.email);
  if (!mascarado) return { enviar: false, emailMascarado: null, motivo: 'SEM_EMAIL' };
  return { enviar: true, emailMascarado: mascarado, motivo: null };
}

module.exports = { mascararEmail, planejarRecuperacao, MOTIVOS_SEM_ENVIO };
