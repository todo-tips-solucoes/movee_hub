# Quickstart: Motorista canônico do hub — cenários de validação

Cenários que validam a implementação end-to-end, por workstream. Ambiente:
hub-homolog (`https://localhost:8443/hub/login`, cert self-signed; QA
`qa.importacoes@moveelog.local` / `Teste@Hub2026`, empresa_id 9001). Executar após
rebuild sob rito anti-starvation.

## Scenario 1 (WS-A, happy path): Painel Geral navega sem 404

1. Autenticar no hub.
2. Clicar em "Painel Geral" na barra lateral.
3. **Expected**: chega em `/hub/dashboard` (200, home), item "Painel Geral" marcado
   ativo (FR-001/FR-002/SC-001).
4. Na home, clicar no card/atalho "Painel Geral".
5. **Expected**: permanece em `/hub/dashboard`, sem erro (FR-001).
6. Clicar em qualquer outro módulo do nav.
7. **Expected**: rota inalterada em relação a hoje (nenhuma regressão).

## Scenario 2 (WS-A, perfil em modal): Meu perfil sem navegar

1. Abrir o menu de conta (avatar) → "Meu perfil".
2. **Expected**: modal sobreposto exibe nome + e-mail; a página atual não muda
   (FR-003/SC-002).
3. Acionar "Trocar senha".
4. **Expected**: confirmação de sucesso (ou mensagem de erro clara) — FR-004.
5. Fechar o modal.
6. **Expected**: permanece na página em que estava (FR-003).
7. Acessar `/hub/dashboard/perfil` diretamente pela URL.
8. **Expected**: continua 200, mesmas informações (FR-005).

## Scenario 3 (WS-B, busca por nome): combobox de entregador

1. Abrir Faturamento; digitar 2 letras no filtro de entregador.
2. **Expected**: nenhuma busca é disparada; indica que faltam caracteres (FR-006).
3. Digitar 3+ letras do nome de um entregador da empresa.
4. **Expected**: sugestões da própria empresa aparecem em < 3 s (SC-003, FR-007,
   máx. 20).
5. Selecionar um entregador.
6. **Expected**: tabela + cards passam a refletir só esse entregador; o filtro exibe
   o **nome** (não o id numérico) — FR-006.
7. Acionar "limpar".
8. **Expected**: filtro removido, volta a mostrar todos (FR-008).
9. Com um entregador selecionado, tentar marcar "sem entregador vinculado".
10. **Expected**: combinação continua bloqueada (FR-009).
11. Repetir 1-8 na tela de Performance.
12. **Expected**: comportamento idêntico (FR-006).

## Scenario 4 (WS-B, error case): degradação em falha de busca

1. Simular 5xx no endpoint `GET /faturamento/entregadores`.
2. **Expected**: o campo degrada para o input numérico atual; a tela não quebra
   (FR-010, D-B1).
3. Busca por nome sem resultado.
4. **Expected**: estado vazio claro, sem tratar como erro (edge case).

## Scenario 5 (WS-C, cadastro com uuid): criar motorista canônico

1. Com permissão `motoristas.editar`, criar motorista com nome + uuid da planilha.
2. **Expected**: aparece na listagem com o uuid visível/copiável (FR-012/FR-016).
3. Tentar criar outro com o **mesmo** uuid.
4. **Expected**: 409, mensagem "uuid já em uso nesta empresa" (FR-013).
5. Tentar criar com uuid em formato inválido.
6. **Expected**: 422/400 explicando o formato (FR-013).
7. Tentar criar sem informar uuid.
8. **Expected**: recusado — uuid é sempre obrigatório (FR-012/D-C6).
9. Editar nome/situação; consultar a auditoria.
10. **Expected**: alteração refletida; registro de quem/quando (FR-015/FR-021).

## Scenario 6 (WS-C, credencial): conceder e gerir acesso

1. Com permissão `motoristas.credencial`, criar credencial para um motorista sem
   credencial.
2. **Expected**: motorista passa a entrar no app motorista (homolog) com ela (FR-017).
3. Redefinir a senha.
4. **Expected**: senha anterior deixa de funcionar imediatamente (FR-019).
5. Desativar a credencial.
6. **Expected**: acesso ao app negado até reativar (FR-018).
7. Com um usuário **sem** `motoristas.credencial`, tentar criar/reset/desativar.
8. **Expected**: negado (FR-020).
9. Inativar o **motorista** (situação) e confirmar a credencial.
10. **Expected**: credencial **não** é desativada automaticamente — independência
    (FR-015, clarify Q3).

## Scenario 7 (WS-C, atividades read-only por uuid): histórico correlacionado

1. Motorista com credencial ativa registra uma atividade pelo app motorista (homolog)
   — a atividade grava `entregador_uuid`.
2. Abrir o detalhe desse motorista no hub → seção "Atividades".
3. **Expected**: a atividade aparece correlacionada pelo uuid, ordenada da mais
   recente para a mais antiga, **sem** ação de edição (FR-022/FR-022A/SC-006).
4. Abrir detalhe de um motorista sem atividades.
5. **Expected**: estado vazio claro, sem erro (edge case).
6. Importar planilha com um uuid ainda não cadastrado.
7. **Expected**: atividade registrada normalmente, sem correlação, sem bloquear a
   importação nem sinalizar erro (clarify Q4).

## Scenario 8 (Roundtrip End-to-End — obrigatório borda backend↔frontend)

Valida que o payload REAL do backend casa com `contracts/api-motorista-canonico.md` e
com o tipo consumido pelo front. **Sem mock** — backend real do hub-homolog.

1. Subir o backend do hub-homolog.
2. `curl` autenticado (cookie `accessToken`) em
   `GET /api/v1/faturamento/entregadores?busca=<3letras>`.
3. **Expected**: `{ items: [{ id, nome }] }`, ≤ 20 itens, todos da empresa do usuário.
4. `curl` `POST /api/v1/motoristas` com `{ nome, idExterno }` válido.
5. **Expected**: 201 com `idExterno` ecoado; repetir com o mesmo uuid → 409.
6. `curl` `GET /api/v1/motoristas/:id`.
7. **Expected**: inclui `idExterno` (uuid) e `atividades: []` (ou itens desc);
   o shape casa com o consumido por `motoristas/page.tsx`.

## Scenario 9 (produção inalterada — FR-023/SC-007)

1. Confirmar que nenhuma env nova (`ENVIO_*`/uuid) é definida nos serviços Swarm de
   produção.
2. **Expected**: login e gravação de atividade do app motorista em produção
   permanecem **byte-a-byte idênticos**; nenhuma migration aplicada em
   chatmasterveloz; tela legada `/dashboard/motoristas` inalterada (FR-024/SC-008).
