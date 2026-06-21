# Feature: migrar cadastro do motorista ao alterar o CNPJ do prestador num movimento

## Objetivo
No painel `app.moveelog.com.br` (frontend_v2), quando um admin edita um movimento e altera o
`cnpj_prestador`, o sistema deve: (a) gravar de fato o novo CNPJ no movimento; e (b) **migrar a
conta do motorista** na tabela `Motorista` (base de login/validação do app do motorista) do CNPJ
antigo para o novo, **preservando senha, nome e status `ativo`** — para que o motorista **não
precise se recadastrar** no app.

## Contexto do sistema (já investigado — confirme antes de codar)

### Fluxo atual (com defeito)
- Tela: `EditDialog` em `app_homologacao/frontend_v2/components/edit-dialog.tsx`. Aberto pelo
  botão "Editar" de cada linha da tabela de movimentos (`components/data-table.tsx`) no
  `app/dashboard/page.tsx`.
  - O campo **CNPJ Prestador já é editável**: state em `edit-dialog.tsx:36`, carga inicial em
    `:48`, declaração do field em `:92`, Input em `:137-142` (sem máscara/validação).
  - Ao salvar, envia o **form completo** via `onSave(record.id, form)` (`:75`).
- Hook: `hooks/use-envio-massa.ts` → `updateRecord` (≈ linhas 68-72) faz
  `api.patch('/update-envio-massa/:id', { ...body, empresa_id })`.
- Backend: rota `app.patch('/update-envio-massa/:id', ...)` em `app_homologacao/backend/server.js:856`.
  - **Só extrai `{ enviado, mensagem, tipo }` do body** — `cnpj_prestador` é IGNORADO.
  - Chama `updateEnvioMassa(id, enviado, mensagem, tipo, idEmp)` (`server.js:819`), que monta
    `updateData` apenas com `enviado` / `retorno_envio_msg_1` / `retorno_envio_msg_2` conforme
    `tipo` (`"men1"`/`"men2"`), e faz `PATCH EnvioMassa?id=eq.${id}&id_empresa=eq.${idEmp}`.
  - Escopo de empresa via `resolveEmpresaAlvo(req.user, req.body.empresa_id, ...)` (mantém
    proteção IDOR pelo filtro composto `id` + `id_empresa`).
- Resultado hoje: o CNPJ digitado **não altera nem o movimento nem o `Motorista`**, mas o toast
  exibe sucesso. Esta feature corrige isso.

### Tabela `Motorista` (login do app motorista) — `backend/db/001_create_motorista.sql`
- Colunas: `id bigserial PK`, `cnpj_prestador text UNIQUE NOT NULL`, `senha text` (nullable após
  migração 008 — NULL = pré-cadastro sem senha), `nome text`, `ativo boolean default true`,
  `created_at`.
- Identidade de login = `cnpj_prestador` (normalizado, só dígitos). Login em
  `backend/routes/motorista.js` (≈ linha 175+): busca `Motorista?cnpj_prestador=eq.{cnpjNorm}`.
  Se o CNPJ muda no movimento mas não na tabela `Motorista`, o login com o CNPJ novo não acha
  registro → o motorista teria que refazer `/register`.

### Regra de domínio crítica — grupo Movee (NÃO IGNORAR)
- O app motorista é **exclusivo do grupo Movee** = empresa `id=6` **+ filiais**, resolvido por
  `mesmoGrupoQue(idEmpresa, 6, cache)` em `backend/routes/grupo.js` — **nunca** `id_empresa === 6`
  estrito.
- A base `Motorista` só deve conter motoristas do grupo Movee. O `upsertMotoristasFromLote`
  (`server.js:1220`) já respeita isso: quem o chama verifica `mesmoGrupoQue(empresaId, 6, ...)`
  antes (`server.js:1597-1598`, `:1944`).
- **Portanto a migração do `Motorista` só pode rodar quando o movimento pertence ao grupo Movee.**
  Para empresas fora do grupo: apenas grava o novo CNPJ no movimento, **sem tocar `Motorista`**.

### Helpers existentes a reutilizar (não reinventar)
- `onlyDigits(...)` e `isCNPJ14(...)` em `server.js` (usados no `upsertMotoristasFromLote`).
- `postgrestRequest(path, method, body)` em `server.js`.
- `mesmoGrupoQue(idEmpresa, 6, cache)` em `routes/grupo.js`.

## DECISÕES DE DESIGN A CONFIRMAR COM O OPERADOR ANTES DE CODAR (etapa clarify)

1. **Escopo da troca de CNPJ entre movimentos.** A edição é por movimento individual, mas a
   tabela `Motorista` é por CNPJ. Se eu trocar o CNPJ só de 1 movimento e migrar o `Motorista`,
   os DEMAIS movimentos do mesmo prestador continuam com o CNPJ antigo e ficam "órfãos" (o
   motorista, agora com novo CNPJ, não casa com eles).
   - **Opção A (recomendada p/ correção de digitação):** ao salvar, atualizar **todos os
     movimentos** com o CNPJ antigo **dentro da mesma empresa** (ou do mesmo lote/`id_arquivo`,
     a definir) para o novo CNPJ, e então migrar o `Motorista`. Evita órfãos.
   - **Opção B:** atualizar só o movimento editado e migrar o `Motorista` mesmo assim
     (documentar o risco de órfãos).
   - **Opção C:** migrar o `Motorista` apenas quando não restar nenhum movimento com o CNPJ
     antigo. Confirmar qual.

2. **Conflito de unicidade.** Se já existir um `Motorista` com o CNPJ **novo**:
   - Recomendado: **abortar a migração** e retornar erro/aviso ao admin (HTTP 409) — não fundir
     contas automaticamente (risco de credenciais). Confirmar.

3. **Quando o `Motorista` do CNPJ antigo NÃO existir** (motorista nunca foi pré-cadastrado):
   - Recomendado: criar **pré-cadastro** com o novo CNPJ (`senha` NULL, `ativo` true), só se
     grupo Movee. Confirmar se deve criar ou apenas ignorar.

4. **Validação de CNPJ no front:** aplicar máscara + exigir 14 dígitos antes de habilitar
   "Salvar"? (Recomendado sim.)

## Especificação técnica

### Backend (`app_homologacao/backend/server.js`)
1. Estender a rota `PATCH /update-envio-massa/:id` (`:856`) para também aceitar
   `cnpj_prestador` do body.
   - Normalizar com `onlyDigits`; validar `isCNPJ14` (400 se inválido).
   - Manter `resolveEmpresaAlvo` / filtro `id_empresa` (não regredir IDOR).
2. Buscar o movimento atual para obter o `cnpj_prestador` **antigo** (e validar que pertence à
   empresa do escopo). Se `cnpjNovo === cnpjAntigo` → no-op para a parte de CNPJ (idempotente).
3. Atualizar `EnvioMassa.cnpj_prestador` (do movimento, ou de todos conforme decisão #1) via
   `postgrestRequest('EnvioMassa?...','PATCH',{ cnpj_prestador: cnpjNovo })`.
4. Nova função `migrarCnpjMotorista(cnpjAntigo, cnpjNovo, idEmpresa, cache)`:
   - Se **não** `mesmoGrupoQue(idEmpresa, 6, cache)` → retornar sem tocar `Motorista`.
   - Buscar `Motorista?cnpj_prestador=eq.{cnpjNovo}`: se já existe → tratar conflito (decisão #2).
   - Buscar `Motorista?cnpj_prestador=eq.{cnpjAntigo}`:
     - existe → `PATCH Motorista?cnpj_prestador=eq.{cnpjAntigo}` com `{ cnpj_prestador: cnpjNovo }`
       (preserva `senha`, `nome`, `ativo`, `id`).
     - não existe → conforme decisão #3 (criar pré-cadastro ou ignorar).
   - Idempotente; logar resultado (`[UPDATE][MOTORISTA] migrou {antigo}->{novo}` sem expor segredos).
5. Chamar `migrarCnpjMotorista` **após** o PATCH do movimento ter sucesso. Tratar falha parcial
   (PostgREST não dá transação multi-request): logar e retornar status claro; considerar migrar o
   `Motorista` antes e reverter se o movimento falhar, OU ordem inversa — escolher e documentar.
6. **Não** alterar a semântica atual de `enviado`/`men1`/`men2` (não regredir o fluxo de envio).

### Frontend (`app_homologacao/frontend_v2/components/edit-dialog.tsx`)
1. Adicionar validação/máscara de CNPJ (14 dígitos) ao campo `cnpj_prestador` (`:92`, `:137-142`).
2. Exibir aviso quando o CNPJ for alterado e a empresa for do grupo Movee: "Isto também
   atualizará o login do motorista no app." (Pode ser texto fixo no diálogo.)
3. Tratar resposta de erro do backend (ex.: 409 conflito de CNPJ já cadastrado; 400 inválido) com
   toast de erro real — não mostrar "atualizado" em falha.
4. Garantir que `cnpj_prestador` segue no payload (`hooks/use-envio-massa.ts updateRecord`).

## Critérios de aceitação
- Editar o CNPJ de um movimento (grupo Movee) com um motorista já cadastrado (com senha) →
  `EnvioMassa.cnpj_prestador` atualizado **e** `Motorista.cnpj_prestador` migrado; a senha,
  nome e `ativo` preservados; o motorista loga no app com o **novo** CNPJ e a **mesma senha**.
- Editar CNPJ de movimento de empresa **fora** do grupo Movee → movimento atualizado,
  `Motorista` **não** tocado.
- CNPJ novo já existente em `Motorista` → erro 409, nada migrado (sem fundir contas).
- CNPJ inválido (≠ 14 dígitos) → erro 400, nada alterado.
- Idempotência: salvar sem mudar o CNPJ → sem efeito colateral no `Motorista`.
- Não regredir o fluxo `enviado`/`men1`/`men2` nem a proteção de escopo por empresa.

## Testes
- Unit/integração do backend para `migrarCnpjMotorista` cobrindo: migração feliz, fora-do-grupo,
  conflito de unicidade, CNPJ antigo inexistente, idempotência, CNPJ inválido.
- E2E manual na UI: editar CNPJ → conferir no banco (`Motorista` e `EnvioMassa`) → login do app
  com novo CNPJ + senha antiga.

## Restrições do projeto (OBRIGATÓRIO)
- "Homologação" É produção (clientes reais). **NÃO** fazer deploy, DDL, nem escrita no banco do
  cliente sem os 5 gates e autorização explícita do operador (ver `CLAUDE.md` / `docs/RITO-PRODUCAO.md`).
- Entregar **código + PR** (e, se precisar de DDL, um script idempotente/aditivo); o deploy é do
  operador. Esta feature **não deve precisar de DDL** (a coluna `cnpj_prestador` já existe nas
  duas tabelas) — confirmar.
- Commits terminam com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; corpo de PR
  termina com `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Branch própria; não commitar/pushar/mergear sem autorização explícita.
