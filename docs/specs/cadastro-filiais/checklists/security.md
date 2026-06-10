# Security Checklist: Cadastro de Filiais

**Purpose**: Valida a qualidade dos requisitos de segurança — autenticação, autorização, proteção de dados, invariante multi-tenant e validação de input.
**Created**: 2026-06-09
**Feature**: [spec.md](../spec.md) | [contrato](../contracts/grupo-empresas-api.md)

## Autenticação e Autorização

- [x] CHK001 - O requisito de autenticação para o endpoint POST /grupo/empresas está especificado? [Completude, Contrato §POST /grupo/empresas] {auto}
  > Contrato: `authenticateToken` + `requireGrupoPai` (403 se `is_grupo_pai !== true`). Middleware duplo especificado.

- [x] CHK002 - O comportamento de `requireGrupoPai` está definido com o código de resposta correto? [Completude, Spec §FR-007] {auto}
  > FR-007: "tentativas de outros perfis resultam em resposta 403." Contrato confirma: 403 `{ "error": "Apenas o administrador do grupo pode executar esta operação." }`.

- [x] CHK003 - O requisito de que `id_grupo` do body seja ignorado está especificado com clareza suficiente para implementação? [Clareza, Spec §FR-002 + SC-004] {auto}
  > FR-002: "o identificador do grupo é sempre extraído do token de autenticação, nunca do corpo ou da query da requisição." SC-004: "Nenhuma requisição de cadastro de filial aceita ou processa o `id_grupo` vindo do corpo." Contrato §Invariante crítico: "qualquer `id_grupo`, `id_empresa` ou `id` recebido no body é **ignorado**." Três camadas de especificação convergentes.

- [x] CHK004 - A especificação cobre o cenário onde a requisição inclui `id_empresa` ou `id` genérico no body? [Cobertura de Edge Cases, Contrato §Invariante crítico] {auto}
  > Contrato lista explicitamente: "`id_grupo`, `id_empresa` ou `id`" — cobertura ampla de aliases.

- [x] CHK005 - O escopo do token JWT usado para derivar o grupo está especificado (campo do token que carrega `id_empresa` do admin)? [Clareza, Contrato §resolveOrCreateGrupo] {auto}
  > Contrato: "Input: `user` (`req.user` com `empresaId`)." Campo `empresaId` do `req.user` (populado pelo `authenticateToken`) é o identificador. Suficientemente especificado para implementação.

- [ ] CHK006 - Há requisito explícito sobre o que acontece se o token do admin tiver `is_grupo_pai = true` mas o campo `empresaId` estiver ausente ou nulo? [Cobertura de Edge Cases] {humano}
  > Cenário de token malformado/incompleto não está coberto na spec nem no contrato. `resolveOrCreateGrupo` falharia com erro não tratado. Decisão: retornar 400/401/500 com mensagem específica ou deixar para tratamento genérico do servidor?

## Proteção de Dados

- [x] CHK007 - O requisito de hash de senha com bcrypt está especificado com custo/fator? [Clareza, Spec §FR-005 + Contrato §Fluxo interno] {auto}
  > FR-005: "armazenar a senha da filial com hash seguro (bcrypt)." Contrato passo 7: `pass: bcrypt.hash(senha, 10)`. Fator de custo 10 especificado.

- [x] CHK008 - O requisito de exclusão do `pass` do response está especificado? [Completude, Contrato §POST /grupo/empresas] {auto}
  > Contrato: "`pass` (hash) **nunca** aparece no response." Explícito.

- [x] CHK009 - O canal de transmissão das credenciais (HTTPS/cookies httpOnly) está especificado? [Completude, Contrato §Proxy] {auto}
  > Contrato §Proxy: "Cookies httpOnly repassados." HTTPS é mandatório pela constitution (inferido; não declarado explicitamente na spec desta feature, mas herdado do projeto).

- [ ] CHK010 - Há requisito explícito proibindo o log de senhas ou dados sensíveis do body da requisição? [Completude, Requisitos de Observabilidade] {humano}
  > Spec e contrato não mencionam política de logging. Para um endpoint que recebe `senha` em plaintext no body, é importante especificar que o middleware de log não deve registrar o campo `senha`. Decisão: adicionar requisito explícito de log-scrubbing ou confiar no padrão do framework?

## Validação de Input e Injeção

- [x] CHK011 - O requisito de validação do formato do CNPJ está especificado com critério verificável? [Clareza, Spec §FR-003 + Contrato §Validações] {auto}
  > FR-003: "exatamente 14 dígitos numéricos." Contrato: `cnpj != 14 dígitos numéricos → 400`. Critério objetivo e testável.

- [x] CHK012 - O tratamento de CNPJ com máscara/pontuação (ex: `12.345.678/0001-90`) está especificado? [Cobertura de Edge Cases, Spec §Edge Cases] {auto}
  > Spec §Edge Cases: "O sistema valida apenas os 14 dígitos numéricos; a UI pode aceitar ou limpar a máscara antes de enviar." Comportamento definido.

- [x] CHK013 - Os critérios de força de senha estão especificados com limites verificáveis? [Clareza, Contrato §Validações] {auto}
  > Contrato: "< 6, sem maiúscula, sem dígito" — três critérios enumerados, objetivamente testáveis.

- [ ] CHK014 - Há requisito de sanitização de campos de texto livre (nome_empresa, endereço, observação) contra XSS/injeção? [Completude, Requisitos de Segurança de Input] {humano}
  > Spec e contrato não mencionam sanitização de campos de texto livre. Campos como `observacao` e `endereco` são exibidos no frontend; sem sanitização, há vetor de XSS stored. Decisão: adicionar requisito de escape de output no frontend ou sanitização de input no backend?

## Isolamento Multi-Tenant

- [x] CHK015 - O invariante de isolamento multi-tenant está referenciado na spec com a seção correta da constitution? [Completude, Spec §US-003 + SC-004] {auto}
  > US-003: "Protege o invariante de isolamento multi-tenant (constitution §II v1.1.0)." SC-004 confirma. Rastreabilidade até a constitution presente.

- [x] CHK016 - O requisito cobre o cenário onde um admin tenta cadastrar filial vinculada a um grupo diferente do seu? [Cobertura, Spec §US-003 SC-2] {auto}
  > SC-004 e FR-002 são categóricos: `id_grupo` do body é ignorado; o vínculo vem **sempre** do token. Um admin não pode injetar `id_grupo` de outro grupo — o invariante é estrutural, não apenas validação.

- [x] CHK017 - O limite de 100 filiais é verificado **após** a resolução do grupo (evitando bypass via criação de grupo novo)? [Consistência, Contrato §Fluxo interno] {auto}
  > Fluxo interno: passo 5 (`resolveOrCreateGrupo`) vem antes do passo 6 (checar limite 100). A verificação do limite usa o `id_grupo` resolvido, não um parâmetro externo.

## Resposta em Caso de Erro de Segurança

- [x] CHK018 - A mensagem de erro 403 não revela informação sobre a estrutura interna (ex: nome do middleware)? [Clareza/Segurança, Contrato §Validações] {auto}
  > Mensagem: "Apenas o administrador do grupo pode executar esta operação." — mensagem de negócio, não técnica. Sem leakage de internals.

## Notes

- Items `{auto}` resolvidos com citação de evidência
- CHK006, CHK010, CHK014 são gaps de cobertura para decisão humana (token malformado, log-scrubbing, sanitização XSS)
- Nenhum gap bloqueante no fluxo principal; os 3 gaps abertos são de hardening/observabilidade
