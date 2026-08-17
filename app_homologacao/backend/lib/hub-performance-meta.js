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
 * Sentinela de "qualquer praça / qualquer turno" — a META PADRÃO da entidade.
 *
 * O operador definiu (2026-08-17) três patamares GLOBAIS (tempo online ≥90%,
 * aceitas ≥90%, completadas ≥95%) e o cruzamento praça × turno como exceção.
 * Guardar o padrão como uma linha com `praca='*'` e `periodo='*'` evita colunas
 * anuláveis: no PG13 a unique trata NULLs como distintos, então duas linhas
 * "padrão" caberiam na mesma tabela sem a unique reclamar — exatamente o tipo
 * de duplicata silenciosa que a 0049 acabou de eliminar.
 *
 * `*` é canônico por construção (`canonizarTexto('*') === '*'`) e não colide
 * com praça real: nenhuma planilha de origem produz uma praça chamada `*`.
 */
const META_PADRAO = '*';

/** Indicadores cuja LEITURA vem em 0..100 e precisa virar fração. */
const INDICADORES_EM_PERCENTUAL = Object.freeze(['tempo_disponivel']);

/**
 * Converte o valor que a API reporta para a MESMA unidade das metas (fração).
 * `tempo_disponivel` vem em 0..100; os demais já são fração.
 */
function normalizarLeitura(valorApi, indicador) {
  if (valorApi === null || valorApi === undefined || valorApi === '') return null;
  const num = typeof valorApi === 'string' ? Number.parseFloat(valorApi) : valorApi;
  if (!Number.isFinite(num)) return null;
  return INDICADORES_EM_PERCENTUAL.includes(indicador) ? num / 100 : num;
}

/** Razão entre contadores inteiros; sem denominador não há razão (nunca 0). */
function razaoInteira(parte, todo) {
  if (parte === null || parte === undefined || todo === null || todo === undefined) return null;
  if (!(todo > 0)) return null;
  return parte / todo;
}

/**
 * Avalia uma linha de turno contra as metas — agora COM CHAMADOR: o export CSV
 * (`GET /performance?format=csv`).
 *
 * Estas três funções existiram mortas na primeira entrega desta feature, e a
 * revisão adversarial apontou com razão: eram uma segunda implementação da
 * regra que só rodava no frontend, com testes verdes protegendo código que
 * ninguém executava. Foram removidas — e voltam agora porque o CSV precisa do
 * julgamento DO LADO DO SERVIDOR: o arquivo é o que vai para a conversa com o
 * parceiro, e ele não passa pela tela.
 *
 * A duplicação com `lib/hub/performance-metas-api.ts#leiturasDoRegistro` é
 * inerente enquanto a tela avaliar no cliente e o CSV no servidor. As duas
 * versões têm teste, e o invariante é este: MESMA unidade (fração), meta
 * específica do cruzamento antes do padrão `*`, sem leitura não há julgamento.
 *
 * @param {object} registro - linha crua do PostgREST (snake_case)
 * @param {Map<string, number>} metasPorChave
 * @returns {{indicador: string, valor: number, meta: number, abaixo: boolean}[]}
 */
function avaliarRegistro(registro, metasPorChave) {
  const leituras = [
    ['aceitacao', razaoInteira(registro.corridas_aceitas, registro.corridas_ofertadas)],
    ['conclusao', razaoInteira(registro.corridas_completadas, registro.corridas_aceitas)],
    ['tempo_disponivel', normalizarLeitura(registro.tempo_disponivel_pct, 'tempo_disponivel')],
  ];

  const resultado = [];
  for (const [indicador, valor] of leituras) {
    if (valor === null) continue;
    const meta = metaAplicavel(metasPorChave, registro.praca, registro.periodo, indicador);
    if (meta === undefined) continue;
    resultado.push({ indicador, valor, meta, abaixo: valor < meta });
  }
  return resultado;
}

/**
 * Meta que vale para um cruzamento: a específica vence; não havendo, o padrão
 * `*`/`*` da entidade. Espelha `metaAplicavel` do frontend.
 */
function metaAplicavel(metasPorChave, praca, periodo, indicador) {
  const especifica = metasPorChave.get(chaveMeta(praca ?? '', periodo ?? '', indicador));
  if (especifica !== undefined) return especifica;
  return metasPorChave.get(chaveMeta(META_PADRAO, META_PADRAO, indicador));
}

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

module.exports = {
  INDICADORES,
  TAMANHO_MAX_TEXTO,
  META_PADRAO,
  canonizarTexto,
  validarMeta,
  chaveMeta,
  metaAplicavel,
  avaliarRegistro,
  normalizarLeitura,
  razaoInteira,
};
