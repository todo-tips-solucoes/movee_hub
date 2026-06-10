# Research — Grupo Unificado de Filiais

**Feature**: `grupo-unificado-filiais`
**Data**: 2026-06-10
**Status**: Completo — todos os unknowns resolvidos

---

## Decision 1 — Helper de pertencimento ao grupo (Módulo A)

**Contexto**: Os ramos 415, 938, 1314 e 1762 de `server.js` usam `id_empresa === 6`
(ou `Number(empresaId) === 6`) como guarda. Precisamos de um helper que responda
"essa empresa pertence ao mesmo grupo da Movee (id=6)?" sem disparar uma consulta ao
PostgREST por item no loop de envio (~881+ itens).

**Decision**: Criar `mesmoGrupoQue(idEmpresa, idReferencia)` em `routes/grupo.js`,
com **cache em memória por ciclo de envio** (passado por parâmetro ou fechamento).

**Rationale**:
- A tabela `Grupo` (id, nome, id_empresa_pai) já existe; `Empresa.id_grupo` já é
  populado pelo cadastro-filiais.
- O helper faz **uma única consulta PostgREST** por ciclo: `Grupo?id_empresa_pai=eq.6`
  → obtém o `id` do grupo → guarda o array de `Empresa?id_grupo=eq.<grupo_id>&select=id`
  → usa o array para checar.
- Alternativa descartada: verificar `id_grupo` do token. O token carrega `id_grupo`
  do usuário logado, mas os ramos de `server.js` recebem `id_empresa` do item
  iterado (do banco), não o `empresaId` do token. São entidades diferentes.
- Cache simples (objeto/Map no escopo da função de processamento em lote) é suficiente;
  não há necessidade de Redis nem de invalidação cross-request.

**Alternatives considered**:
1. Coluna denormalizada `is_movee_group` em `Empresa` → exige DDL + manutenção.
   Descartado (CL-003: sem DDL).
2. `resolveScope` existente → retorna array de IDs do escopo do token logado, não
   verifica membresia de id arbitrário. Interface errada para o caso de uso.
3. IN query por ciclo → consulta por item (não por ciclo). Descartado (FR-005).

---

## Decision 2 — `PUT /grupo/empresas/:id` vs `PATCH` (Módulo B)

**Decision**: `PUT` semântico com body completo (espelha o `POST /grupo/empresas:293`).

**Rationale**:
- O formulário de edição pré-preenche todos os campos; o admin edita e salva o
  conjunto completo — semântica PUT (replace) é mais clara que PATCH (diff).
- O `POST` existente já valida todos os campos obrigatórios (nome, email, cnpj) e
  opcionais (fiscal). Espelhar o código reduz superfície de diferença.
- `pass` (senha) é **ignorada** no PUT: CL-001/FR-B confirmou que senha de filial
  não é gravada nesta operação. O campo pode vir no body e é simplesmente descartado.

**Alternatives considered**:
1. `PATCH` parcial → mais flexível mas exigiria lógica de merge; o frontend envia
   tudo de qualquer forma.

---

## Decision 3 — Bloqueio de login de filial (Módulo C)

**Decision**: Inserir guarda **antes** de `bcrypt.compare` no `POST /login`
(`server.js:142`):

```javascript
// 1. Verificar se a empresa é filial (id_grupo setado e não é pai)
const grupoCheckFilial = await postgrestRequest(
  `Grupo?id_empresa_pai=eq.${user.id}&select=id`
);
const ehPai = grupoCheckFilial && grupoCheckFilial.length > 0;
if (user.id_grupo && !ehPai) {
  return res.status(403).json({
    error: 'Acesse o painel usando o login do grupo'
  });
}
```

**Rationale**:
- Bloquear ANTES do `bcrypt.compare` evita timing oracle: não revelamos se a senha
  está correta para contas bloqueadas.
- A verificação usa `id_grupo` (campo da tabela `Empresa`) + query em `Grupo` para
  confirmar se é pai — o mesmo padrão do `POST /login` atual (linha 161-177).
- Alternativa "usar `is_grupo_pai` do token" — não aplicável aqui: o token ainda
  não existe no fluxo de login.

**Nota**: a query `Grupo?id_empresa_pai=eq.${user.id}` pode ser eliminada se
adicionarmos ao SELECT inicial de `Empresa` o JOIN com `Grupo`. Mas para manter
a mudança cirúrgica e auditável, mantemos a abordagem de duas queries (padrão
já existente no login atual).

---

## Decision 4 — `mesmoGrupoQue`: cache de ciclo via closure vs parâmetro

**Decision**: Passar o cache como **objeto `{ids: Set | null}`** de fora para dentro
do loop de processamento em `server.js`. O helper `mesmoGrupoQue` preenche o cache
na primeira chamada e o reutiliza nas subsequentes.

```javascript
// Antes do loop:
const grupoCache = { ids: null }; // populated on first call

// Dentro do loop (por item):
const ehDoGrupo = await mesmoGrupoQue(item.id_empresa, 6, grupoCache);
```

**Rationale**:
- Closure simples, sem estado global. O cache é descartado ao fim do ciclo.
- Se o grupo mudar entre ciclos (novo cadastro de filial), o próximo ciclo busca
  do banco novamente — não há stale indefinido.
- Alternativa global (module-level) descartada: cria estado compartilhado entre
  requests concorrentes, race condition se dois usuários disparam em massa
  simultaneamente.

---

## Decision 5 — Tela de edição de filial: modal vs nova rota

**Decision**: **Painel colapsável inline** na lista de filiais (mesmo padrão da
"seção dados fiscais" do cadastro), sem nova rota de navegação.

**Rationale**:
- FR-012 exige que a edição seja acessível a partir da lista existente, sem
  nova rota de primeiro nível.
- A página `/dashboard/configuracoes/grupo/page.tsx` já tem estrutura de lista
  de filiais + formulário. Padrão mais simples = menos código novo.
- Alternativa modal descartada: a lista pode ter muitos campos fiscais; modal
  seria scrollável e menos acessível.

---

## Decision 6 — Unicidade de email no `PUT /grupo/empresas/:id`

**Decision**: Checar unicidade excluindo o próprio ID da filial sendo editada:
`Empresa?email=eq.<email>&id=neq.<idFilial>&select=id`.

**Rationale**:
- Se o admin não muda o email, a checagem sem exclusão do próprio ID retornaria
  "já cadastrado" erroneamente.
- Mesmo padrão para CNPJ.

---

## Decision 7 — Backward-compat: empresas sem grupo

**Decision**: Todos os ramos novos têm `if (!mesmoGrupoQue(...)) { /* comportamento atual */ }`.
Empresas com `id_grupo = null` nunca entram no conjunto retornado pelo helper, portanto
seguem o ramo atual sem alteração.

**Rationale**: FR-006 (MUST). O helper `mesmoGrupoQue` retorna `false` para qualquer
empresa cujo `id_grupo` seja null — sem consulta adicional.
