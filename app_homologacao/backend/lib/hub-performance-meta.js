// impeccable r24 parte 2 — lógica pura das metas de performance.
//
// Aqui mora a única coisa desta feature que é fácil de errar em silêncio: a
// UNIDADE. A API de performance não usa uma escala só
// (contracts/performance-api.md, research.md Decision 7):
//
//   taxaAceitacao / taxaConclusao  -> FRAÇÃO 0..1     ("0.8333")
//   tempoDisponivelPct / Medio     -> PERCENTUAL 0..100 ("87.42")
//
// As metas são gravadas SEMPRE como fração 0..1 (migration 0048, com CHECK).
// Comparar o `tempo_disponivel` sem dividir por 100 faria 87,42 parecer
// 8742% e reprovaria — ou aprovaria — a operação inteira sem ninguém notar.
//
// ⚠️ ONDE A COMPARAÇÃO ACONTECE: no FRONTEND
// (`lib/hub/performance-metas-api.ts#leiturasDoRegistro`), porque é a tela que
// casa meta com linha. Este arquivo tinha uma segunda implementação da mesma
// regra (`avaliarRegistro`/`normalizarLeitura`/`razaoInteira`) que NINGUÉM
// chamava — revisão adversarial de 2026-08-16 mostrou que a rota importava só
// `validarMeta`. Duas implementações da mesma regra, uma delas morta e com 13
// testes dando sensação de cobertura, é pior que uma só: a deriva passa em
// todos os testes. As funções mortas foram removidas.

const INDICADORES = Object.freeze(['aceitacao', 'conclusao', 'tempo_disponivel']);

/** Teto de `praca`/`periodo`. Sem ele, cada PUT despeja até o limite do
 *  `express.json()` numa tabela de auditoria imutável e retida 12 meses — e a
 *  unique aceita infinitas combinações novas. 120 caracteres cobre com folga o
 *  que as planilhas de origem produzem ("SAO PAULO", "ALMOCO 11H30-15H29"). */
const TAMANHO_MAX_TEXTO = 120;

/**
 * Forma canônica de `praca`/`periodo`.
 *
 * Existe porque a unique da migration 0048 é BYTE-EXATA e a chave de
 * casamento normalizava caixa — divergência reproduzida contra o ambiente
 * real: `"SAO PAULO"` e `"Sao Paulo"` viravam DUAS linhas no banco e UMA
 * chave na tela, com a última vencendo em silêncio. O admin via duas metas
 * listadas e só uma sendo aplicada, sem nada dizer qual.
 *
 * Guardando a forma canônica, as duas coisas voltam a concordar: a unique
 * passa a barrar o duplicado, e a chave casa sempre.
 *
 * `NFC` antes de tudo: a mesma letra acentuada tem duas representações de
 * bytes (planilha exportada em macOS costuma vir NFD), visualmente idênticas
 * e diferentes para `===`. Sem isto, uma meta é gravada, aparece na lista e
 * NUNCA marca nada — indistinguível de "sem meta", que é estado legítimo.
 *
 * Maiúsculas porque é a forma do dado de origem (as planilhas trazem
 * "SAO PAULO", "ALMOCO 11H30-15H29") — canonizar para ela mantém o que a
 * pessoa lê igual ao que a importação produz.
 */
function canonizarTexto(bruto) {
  if (typeof bruto !== 'string') return '';
  return bruto.normalize('NFC').replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * Valida uma meta vinda do cliente. Devolve `{ ok: true, meta }` ou
 * `{ ok: false, erro }` — nunca lança, porque a rota traduz o erro em 400 com
 * mensagem de negócio (distinguir negócio de infra é regra do projeto).
 */
function validarMeta(bruto) {
  if (!bruto || typeof bruto !== 'object') return { ok: false, erro: 'META_INVALIDA' };

  const praca = canonizarTexto(bruto.praca);
  const periodo = canonizarTexto(bruto.periodo);
  const indicador = typeof bruto.indicador === 'string' ? bruto.indicador : '';

  if (!praca) return { ok: false, erro: 'PRACA_OBRIGATORIA' };
  if (!periodo) return { ok: false, erro: 'PERIODO_OBRIGATORIO' };
  if (praca.length > TAMANHO_MAX_TEXTO) return { ok: false, erro: 'PRACA_MUITO_LONGA' };
  if (periodo.length > TAMANHO_MAX_TEXTO) return { ok: false, erro: 'PERIODO_MUITO_LONGO' };
  if (!INDICADORES.includes(indicador)) return { ok: false, erro: 'INDICADOR_INVALIDO' };

  const valor = typeof bruto.valor === 'string' ? Number.parseFloat(bruto.valor) : bruto.valor;
  if (!Number.isFinite(valor)) return { ok: false, erro: 'VALOR_INVALIDO' };
  // A fronteira que impede o erro por fator 100 chegar ao banco. O CHECK da
  // 0048 é a última linha de defesa; esta é a que produz mensagem legível.
  if (valor < 0 || valor > 1) return { ok: false, erro: 'VALOR_FORA_DA_FAIXA' };

  return { ok: true, meta: { praca, periodo, indicador, valor } };
}

/**
 * Chave do cruzamento — a MESMA canonização usada na gravação, para que a
 * unique do banco e o casamento na tela nunca discordem.
 *
 * Acento continua distinguindo (praças podem se distinguir por ele); o que
 * deixou de distinguir é caixa, espaço interno e forma Unicode.
 */
function chaveMeta(praca, periodo, indicador) {
  // `JSON.stringify` de um array em vez de juntar com `|`: o separador estava
  // dentro do alfabeto possível do dado. `praca="SP|NOITE"` com `periodo="X"`
  // produzia a MESMA chave que `praca="SP"` com `periodo="NOITE|X"` — colisão
  // improvável, mas silenciosa, e o texto vem de planilha livre.
  return JSON.stringify([canonizarTexto(praca), canonizarTexto(periodo), indicador]);
}

module.exports = { INDICADORES, TAMANHO_MAX_TEXTO, canonizarTexto, validarMeta, chaveMeta };
