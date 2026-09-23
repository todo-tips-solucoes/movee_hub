// Moldes das mensagens do movimento gerado pelo hub (F4, briefing
// repasse-nota-producao §F4).
//
// Mesma disciplina de `renderizarDescricaoPix` (lib/adiantamento-transfeera-xlsx.js):
// whitelist de placeholders e recusa explícita de qualquer outro. O texto é
// editável por um operador do hub e vai para a `EnvioMassa`, de onde é
// disparado por WhatsApp ao motorista — interpolar campo arbitrário seria
// vazar dado não previsto. A recusa acontece no SALVAR, não só na geração:
// descobrir molde inválido só na hora de gerar as notas da semana seria tarde.

const REGEX_PLACEHOLDER = /\{([^}]*)\}/g;

/** O que o molde pode citar. Tudo que a geração já tem em mãos por motorista. */
const PLACEHOLDERS_PERMITIDOS = new Set([
  'nome', 'valor', 'gorjeta', 'total', 'periodo_inicio', 'periodo_fim',
]);

/** `1234.5` -> `"1.234,50"` — o motorista lê em português, não em JSON.
 *  Ausente é ZERO, não vazio: estes campos são dinheiro somado, e "sua gorjeta
 *  foi " no meio da frase é pior que "sua gorjeta foi 0,00". Só texto que não
 *  é número mesmo (NaN) vira vazio. */
function moeda(valor) {
  const n = valor === null || valor === undefined || valor === '' ? 0 : Number(valor);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** `"2026-09-21"` -> `"21/09/2026"`. */
function dataBR(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/**
 * Lista os placeholders não permitidos de um molde. Vazio = molde válido.
 * Separado de `renderizarMensagem` porque o PUT da configuração precisa
 * recusar ANTES de gravar, e aí não há motorista nenhum para interpolar.
 */
function placeholdersInvalidos(modelo) {
  const achados = [];
  for (const [, chave] of String(modelo ?? '').matchAll(REGEX_PLACEHOLDER)) {
    if (!PLACEHOLDERS_PERMITIDOS.has(chave)) achados.push(chave);
  }
  return achados;
}

/**
 * Renderiza o molde para um motorista. Lança se houver placeholder fora da
 * whitelist — o mesmo erro que o salvar já teria barrado, mantido aqui porque
 * um molde antigo pode ter sido gravado antes desta validação existir.
 */
function renderizarMensagem(modelo, { nome, valor, gorjeta, total, periodoInicio, periodoFim }) {
  return String(modelo ?? '').replace(REGEX_PLACEHOLDER, (match, chave) => {
    if (!PLACEHOLDERS_PERMITIDOS.has(chave)) {
      throw new Error(`mensagem_modelo: placeholder nao permitido "{${chave}}"`);
    }
    switch (chave) {
      case 'nome': return String(nome ?? '');
      case 'valor': return moeda(valor);
      case 'gorjeta': return moeda(gorjeta);
      case 'total': return moeda(total);
      case 'periodo_inicio': return dataBR(periodoInicio);
      default: return dataBR(periodoFim);
    }
  });
}

module.exports = { renderizarMensagem, placeholdersInvalidos, PLACEHOLDERS_PERMITIDOS };
