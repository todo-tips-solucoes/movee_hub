# Quickstart & Cenários de Teste — App Motorista (PWA)

**Feature**: `app-motorista-nfse` | **Date**: 2026-06-04

Cenários de aceitação executáveis, um por fluxo crítico. Servem de roteiro de teste
manual e de base para os testes automatizados.

---

## Cenário 1 — Login do motorista (happy path) — US1

1. Seed: existe `Motorista` com `cnpj_prestador = 12345678000199`, senha conhecida,
   `ativo = true`.
2. Abrir o PWA → tela de Login.
3. Informar CNPJ prestador + senha → "Entrar".
4. **Expected**: backend emite cookies `accessToken`/`refreshToken` httpOnly; app
   redireciona ao painel do movimento; nenhum token visível em `localStorage`.

## Cenário 2 — Login inválido (error case) — US1

1. Informar CNPJ válido + senha errada → "Entrar".
2. **Expected**: HTTP 401; mensagem "Credenciais inválidas." em pt-BR; permanece na
   tela de login; resposta não revela qual campo falhou.

## Cenário 3 — Consulta do movimento aberto — US2

1. Seed: 1 `EnvioMassa` com `cnpj_prestador = 12345678000199`, `mov_fechado = false`,
   campos fiscais preenchidos.
2. Autenticado, abrir o painel.
3. **Expected**: exibe `valor`, `dt_inicial`, `dt_final`, `nome`, `cnpj_tomador`,
   `cnpj_prestador`, `tribnac` do movimento; carrega em < 5s (SC-001).

## Cenário 4 — Sem movimento aberto (empty state) — US2

1. Seed: motorista sem nenhum `EnvioMassa` com `mov_fechado = false`.
2. Abrir o painel.
3. **Expected**: mensagem de estado vazio ("Nenhum movimento em aberto"), sem erro.

## Cenário 5 — Upload + validação OK + bloqueio de reenvio — US3 (núcleo)

1. Autenticado, movimento aberto sem `nota_ok`.
2. Subir um XML que a validação aprova → "Validar".
3. **Expected**: backend chama `validade_nfse`, recebe `valid: true`, grava `nota_ok`
   no movimento; app mostra "Nota ok!"; botão de upload fica **bloqueado**.
4. Recarregar a tela.
5. **Expected**: upload continua bloqueado (estado lido de `nota_ok` — FR-010);
   reenvio negado com `409` se forçado via API (SC-003).

## Cenário 6 — Validação inválida (campos errados) — US3

1. Autenticado, movimento aberto sem `nota_ok`.
2. Subir um XML que a validação reprova (ex.: `valid_valor = false`) → "Validar".
3. **Expected**: app lista em pt-BR os campos reprovados (ex.: "Valor da nota não
   confere…") + instrução "Cancele esta nota e emita uma nova…"; `erro_validacao`
   gravado; upload **continua permitido** para nova tentativa.

## Cenário 7 — Arquivo não-XML rejeitado — US3 (error case)

1. Subir um `.pdf` ou texto qualquer → "Validar".
2. **Expected**: `400` "Arquivo inválido: envie um XML de NFS-e válido."; o serviço de
   validação **não** é chamado (FR-011).

## Cenário 8 — Serviço de validação indisponível — US3 (error case)

1. Simular timeout/erro 5xx do `validade_nfse`.
2. Subir XML válido → "Validar".
3. **Expected**: `502/503` "Serviço de validação indisponível. Tente novamente…";
   `nota_ok`/`erro_validacao` **inalterados**; reenvio permitido (FR-012).

## Cenário 9 — Atalho do portal + instalação PWA — US4/US5

1. Tocar no atalho do portal.
2. **Expected**: abre `https://www.nfse.gov.br` em nova aba.
3. No celular compatível, escolher "Instalar app".
4. **Expected**: ícone na tela inicial; abre em modo standalone (SC-005).

## Cenário 10 — Isolamento entre motoristas — US2/segurança

1. Motorista A autenticado tenta acessar dados; existe movimento do Motorista B
   (outro `cnpj_prestador`).
2. **Expected**: A nunca vê dados de B; toda query é filtrada por `cnpj_prestador` do
   token; sem autenticação, zero dados (SC-006).

---

## Cenário Roundtrip End-to-End (OBRIGATÓRIO — validação empírica do contrato)

> Exigido pela skill `plan` §5.3 — expõe drift de contrato (snake_case vs camelCase,
> e a divergência do `xml_input` documentada em research.md Decision 5). NÃO usar mock.

**R1 — Movimento aberto (shape real):**
1. Com backend e PostgREST reais, autenticar um motorista de teste.
2. `GET /api/motorista/movimento-aberto` (chamada real).
3. Capturar o JSON de resposta.
4. **Expected**: o shape bate com `contracts/motorista-api.md` — chaves em camelCase
   (`dtInicial`, `cnpjTomador`, `notaOk`…), valores vindos das colunas snake_case do
   PostgREST. Qualquer divergência de case é corrigida no mapper do backend, não no
   cliente.

**R2 — Validação NFS-e (contrato externo):**
1. Tomar um XML de NFS-e real de homologação.
2. Chamar `validade_nfse` exatamente como em `contracts/motorista-api.md`
   (`xml_input = JSON.stringify([{filename, data}])`, `validar_descricao_servico=false`,
   `nexus=false`, header `FASTAPI_VALIDATION_TOKEN`).
3. Capturar a resposta crua.
4. **Expected**: resposta é array `[{ valid, details:{...} }]` com as 7 flags. **Se a
   API rejeitar o formato `[{filename,data}]`**, registrar e cair para o formato usado
   pela rota `validate-xml-batch` existente — atualizando research.md Decision 5 e o
   contrato com a forma comprovada antes de fixar o parser.
