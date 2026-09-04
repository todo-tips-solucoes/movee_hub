# Quickstart: Hub Motorista 360

## Scenario 1: Vínculo automático — cadastro novo no app do motorista (US1, happy path)

1. No legado (`Motorista`), existe pré-cadastro com `cnpj_prestador` e
   `senha IS NULL`, e no hub existe um `Entregador` sem `motorista_id` cujo
   `nome` normalizado é quase-idêntico ao `nome` que o motorista vai
   informar em `/register`.
2. Motorista completa `POST /motorista/register` (`cnpjPrestador, nome,
   senha`) no app do motorista.
3. **Expected**: resposta 201 inalterada; `Motorista.senha` ativada
   (comportamento já existente); em seguida, `ContaMotorista` criado/achado
   por `cnpj_prestador`, `hub_motoristas_candidatos_por_conta` retorna
   exatamente 1 candidato com `similaridade >= 0.9`, `Entregador.motorista_id`
   passa a apontar para essa conta — sem qualquer ação do gestor. O card
   "Conta de acesso vinculada" na tela de detalhe do hub passa a mostrar a
   credencial.

## Scenario 2: Vínculo automático — ambíguo, não vincula sozinho (Acceptance Scenario 3)

1. Mesma situação do Cenário 1, mas 2 `Entregador` do grupo Movee têm nomes
   igualmente similares (`similaridade >= 0.9` para ambos), ou nenhum
   candidato passa de 0.9.
2. Motorista completa `/register`.
3. **Expected**: `ContaMotorista` é criado/achado normalmente (credencial do
   app motorista funciona), mas **nenhum** `Entregador.motorista_id` é
   setado automaticamente. O gestor continua vendo "Nenhuma conta de acesso
   vinculada" + botão `Vincular` (fluxo manual já existente, com sugestões
   a 0.3 de piso) — nunca um vínculo errado silencioso.

## Scenario 3: Backfill retroativo (FR-012, US1) — caso relatado

1. Rodar o script de backfill (uma vez, aplicado pelo operador) num
   ambiente com **o motorista do caso relatado** já cadastrado no legado
   com `senha` preenchida (credencial ativa) e sem vínculo no hub — o caso
   exato do briefing (motorista ativo, com histórico de faturamento e de
   turnos, cujos cards "Conta de acesso vinculada" e "Credencial de acesso"
   estão vazios). O nome e o identificador não são registrados aqui por
   serem dado pessoal; quem for executar tem o print em
   `arquivos_complementares/hub-motorista-360-evidencias/`.
2. **Expected**: relatório final lista este motorista em `totalVinculados`
   (se houver candidato >= 0.9) ou `totalAmbiguos` (se não houver — nesse
   caso o gestor resolve manualmente, o backfill nunca piora o estado
   atual). Reexecutar o script depois é um no-op para este motorista
   (idempotente).

## Scenario 4: RBAC de campo — perfil `leitura` não vê dados sensíveis (FR-013)

1. Um `Entregador` já enriquecido via EntreGô (`dados_entrego_json`
   preenchido) e com CNPJ vinculado.
2. Usuário do papel `leitura` chama `GET /motoristas/:id`.
3. **Expected**: 200 com `cnpjPrestador`, `documentos` (RG/CNH),
   `informacoesEntrega`, `dadosPessoaisBasicos` (nome/nascimento/telefone)
   presentes; `dadosPessoais` (CPF, nome da mãe, nome do pai, e-mail) e
   `contatoEmergencia` **ausentes do JSON** (não `null` — chave omitida).
4. Mesma chamada por `admin_entidade`: **Expected**: 200 com TODOS os
   campos presentes, incluindo `dadosPessoais`/`contatoEmergencia`.

## Scenario 5: Busca sob demanda sem identificador EntreGô (Error Case, US2 cenário 3)

1. `Entregador` sem `id_externo` associado (não populado pelo pipeline de
   importação).
2. Gestor aciona `POST /motoristas/:id/entrego-enriquecimento`.
3. **Expected**: 409 `SEM_IDENTIFICADOR_ENTREGO` — mensagem clara, sem
   criar pedido pendente.

## Scenario 6: Falha na EntreGô não descarta enriquecimento anterior (FR-007)

1. `Entregador` já tem `dados_entrego_json` de uma busca anterior
   bem-sucedida.
2. Gestor aciona nova busca; o worker de `infra/robo-entrego/` encontra
   sessão expirada ou `ErroAntibotSuspeito` (classificado `ehFalhaDefinitiva`).
3. **Expected**: `PATCH .../entrego-enriquecimento` com `sucesso: false` —
   `dados_entrego_json` e `dados_entrego_enriquecidos_em` **inalterados**
   (continuam mostrando o dado da busca anterior); só
   `dados_entrego_solicitado_em` é limpo. A tela do hub continua exibindo
   os dados antigos, sem erro na UI.

## Scenario 7: Roundtrip End-to-End — `GET /motoristas/:id` real vs. contrato

1. Subir o backend localmente (`cd app_homologacao/backend && npm start`)
   contra um PostgREST do hub disponível (ambiente `hub-homolog` isolado,
   nunca produção — `infra/hub/RUNBOOK.md`).
2. Autenticar como `admin_entidade` de teste (`qa.importacoes@moveelog.local`,
   ver memória "acesso teste hub-homolog") e chamar
   `curl -s -b cookies.txt http://localhost:3000/motoristas/<id>`.
3. Comparar o payload real contra `contracts/hub-motoristas-detalhe.md`:
   - `cnpjPrestador`, `entregoEnriquecimento.*`, `vinculoCredencialAutomatico`
     presentes com os tipos declarados (camelCase — `cnpjPrestador`, não
     `cnpj_prestador`; o backend já faz esse mapeamento snake_case→camelCase
     em outros DTOs do mesmo arquivo, ex.: `hub-motoristas-dto.js` — MUST
     seguir a mesma convenção, nunca vazar nome de coluna do banco).
   - Repetir autenticado como `leitura`: confirmar que `dadosPessoais`/
     `contatoEmergencia` estão de fato AUSENTES do JSON (`jq 'has("dadosPessoais")'` → `false`), não apenas `null`.
4. Frontend (`app/hub/dashboard/motoristas/[id]/page.tsx`) consome o mesmo
   payload — conferir que o parse (Zod ou equivalente já usado na página)
   não rejeita os campos novos.
5. **Expected**: zero divergência de nome/tipo/case entre payload real,
   contrato e frontend.
