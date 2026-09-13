# API Checklist: Notificações push no app do motorista

**Purpose**: validar a qualidade dos contratos `hub-avisos.md` e `motorista-push.md` —
consistência entre os dois, cobertura de erro, idempotência, formato de payload e
rastreabilidade contra os FRs da spec.
**Created**: 2026-09-11
**Feature**: [spec.md](../spec.md), [contracts/hub-avisos.md](../contracts/hub-avisos.md),
[contracts/motorista-push.md](../contracts/motorista-push.md)

## Consistência entre contratos

- [x] CHK001 - O formato de erro (`{erro: CODIGO, motivo?}`) e a exceção herdada (401 do
  `authenticateMotorista`/middleware existente com `{error: texto}`) estão documentados
  nos dois contratos sem contradição entre eles? [Consistência, Contracts hub-avisos.md
  §Convenções, motorista-push.md§Convenções] {auto}
- [x] CHK002 - Os dois contratos usam consistentemente camelCase no payload de API e
  reservam snake_case só para a camada DB/PostgREST, sem vazamento entre camadas?
  [Consistência, Plan §Convenções de Borda] {auto}
- [x] CHK003 - O limite de tamanho do payload final do push (1.024 bytes UTF-8) é
  verificado tanto no request de criação do aviso (`CONTEUDO_EXCEDE_LIMITE`) quanto no
  contrato do payload entregue ao serviço de push, com o mesmo número nos dois lugares?
  [Consistência, Contracts hub-avisos.md POST /avisos, motorista-push.md§Payload] {auto}
- [x] CHK004 - Os dois contratos listam explicitamente quais campos de injeção de
  identidade são ignorados (`id_empresa`, `criado_por`, `cnpj`, `escopo`,
  `cnpjPrestador`, `motoristaId`) em cada superfície, sem lacuna entre hub e app
  motorista? [Completude/Segurança, Contracts hub-avisos.md§Convenções, motorista-
  push.md§Convenções] {auto}
- [x] CHK005 - `GET /api/v1/avisos/:id` e `GET /motorista/avisos/:id` respondem com o
  MESMO padrão de não-enumeração (um único código para "inexistente", "expurgado" e
  "fora do escopo"), evitando que o erro revele qual dos três casos ocorreu?
  [Consistência/Segurança, Contracts hub-avisos.md GET /:id, motorista-push.md GET
  /avisos/:id] {auto}

## Completude e cobertura de erro

- [x] CHK006 - `POST /api/v1/avisos` cobre em sua tabela de erros todos os MUST da spec
  relevantes a esse endpoint (FR-015 escopo, FR-016 zero inscrições, FR-017/FR-021
  tamanho/conteúdo, FR-025 chave ausente, FR-027 limite de taxa)? [Cobertura, Spec
  §FR-015/16/17/21/25/27, Contracts hub-avisos.md POST /avisos] {auto}
- [x] CHK007 - Toda rota de mutação (`PUT`/`POST`) documenta explicitamente se é
  idempotente e qual o efeito de uma repetição (inscrição, revogação, disparo por
  `chaveIdempotencia`)? [Completude, Contracts motorista-push.md PUT /inscricao, POST
  /inscricao/revogar, hub-avisos.md POST /avisos Response 200] {auto}
- [x] CHK008 - O contrato define o comportamento do service worker para payload de push
  inválido (formato/campos fora do esperado), não deixando o caso como não tratado?
  [Completude/Edge Case, Contracts motorista-push.md§Service worker] {auto}
- [x] CHK009 - A allowlist de hosts do serviço de push (research Decision 10) tem seu
  comportamento de erro (`ENDPOINT_NAO_PERMITIDO`) e o campo validado (`endpoint`
  hostname) definidos no contrato de forma rastreável, não apenas citada como
  referência solta à pesquisa? [Rastreabilidade, Contracts motorista-push.md PUT
  /inscricao] {auto}

## Clareza e ambiguidade

- [ ] CHK010 - O envelope de paginação de `GET /api/v1/avisos` (`total`, `page`,
  `pageSize`) remete a "alinhar ao envelope de listagem de `GET /api/v1/motoristas` na
  implementação" em vez de fixar o formato explícito no contrato. [Ambiguity, Contracts
  hub-avisos.md GET /avisos] — resolver o formato exato antes da implementação ou
  aceitar o risco de drift com `GET /api/v1/motoristas`. {auto}
- [ ] CHK011 - O contrato não define o comportamento da UI (desabilitar botão, exibir
  estado de carregamento) durante a janela entre o clique em "disparar" e a resposta —
  a idempotência por `chaveIdempotencia` cobre a correção do servidor, mas não o
  comportamento visual ao clique duplo. [Gap, Contracts hub-avisos.md POST /avisos,
  §Telas FV2] {auto}

## Consistência com a spec

- [x] CHK012 - As rotas de leitura (`GET /avisos`, `/avisos/:id`, `/cobertura`) e as de
  ação (`/alcance`, `/destinatarios/*`) usam permissões diferentes dentro do mesmo
  módulo (`avisos.consultar` vs `avisos.enviar`) — isso é compatível com o FR-014
  ("ver o resultado e a cobertura exige acesso ao mesmo módulo"), já que o gate de
  módulo (`requireModuloAtivo('avisos')`) é uniforme e a permissão é um refinamento
  interno? [Consistência, Spec §FR-014, Contracts hub-avisos.md§Convenções] {auto}

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou marcador `[Gap]`).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto.
- **Resolução**: 10 `{auto}` resolvidos (`[x]`), 2 `[Gap]` abertos (CHK010, CHK011),
  0 `{humano}`.
