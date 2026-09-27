# Evidência F2 — controle negativo (tasks.md 2.1)

Escopo desta evidência: **só o nível de rota/unit** (mock de `hubPostgrestRequest`,
`hub-rbac-cache`, `hub-auditoria` via `Module._load` — mesma técnica de
`tests/hub-adiantamentos-rotas-unit.test.js`), arquivo
`app_homologacao/backend/tests/hub-usuarios-trava-unit.test.js`.

**Não cobre** (continua pendente de ambiente `hub-test-*`, tasks.md 2.1.1–2.1.4
literais, 2.5.6):
- `POST /UsuarioEntidade`/`POST /PapelPermissao` **direto no PostgREST**
  (RLS real — task 2.1.2);
- as mesmas 4 chamadas batidas contra um `hub-test-*` real antes/depois da
  0097 (task 2.1.1/2.1.3/2.5.4);
- rodar `hub-rbac-integration.sh`/`hub-papeis-integration.sh` (task 2.5.6).

## Antes da trava (routes/hub-usuarios.js sem `papelEhRestrito`)

Comando: `node --test tests/hub-usuarios-trava-unit.test.js` (branch
`feat/repasse-saldo-minimo`, antes de qualquer edição em
`routes/hub-usuarios.js` nesta onda).

Resultado: **7 de 15 testes falharam**, todos pelo motivo esperado — a rota
respondia `200`/`201` onde o contrato (`contracts/hub-usuarios-trava.md`)
exige `403 PAPEL_RESTRITO`:

```
not ok - admin_entidade tentando criar usuário com papel admin_plataforma -> 403 PAPEL_RESTRITO, sem criar nada
  Expected 403, got 201
not ok - admin_entidade tentando criar usuário com papel financeiro_aprovador -> 403 PAPEL_RESTRITO
  Expected 403, got 201
not ok - admin_entidade tentando vincular usuário 52 com papel admin_plataforma -> 403 PAPEL_RESTRITO
  Expected 403, got 201
not ok - admin_entidade tentando desativar vínculo 900 (papel atual admin_plataforma) -> 403
  Expected 403, got 200
not ok - admin_entidade tentando promover vínculo 901 (não restrito) para admin_plataforma -> 403
  Expected 403, got 200
not ok - admin_entidade tentando trocar a senha do usuário 50 (vínculo ativo admin_plataforma) -> 403
  Expected 403, got 200
not ok - admin_entidade tentando desativar (ativo:false) o usuário 50 -> 403
  Expected 403, got 200

# tests 15
# pass 8
# fail 7
```

Isso prova o furo ao nível de rota: `POST /usuarios`, `POST /usuarios/:id/vinculos`,
`PUT /usuarios/:id/vinculos/:vinculoId` e `PUT /usuarios/:id` aceitavam
`admin_entidade` concedendo/alterando/desativando papel restrito — exatamente
FR-009/FR-010/FR-012a.

## Depois da trava (routes/hub-usuarios.js com `papelEhRestrito` + `lib/hub-papeis-restritos.js`)

Mesmo comando, após as edições desta onda (trava nas 4 rotas + auditoria
`usuario_vinculo_negado` + regressão FR-011 preservada):

```
# tests 15
# pass 15
# fail 0
```

Os 8 testes de regressão/positivo (`admin_entidade` com papel não-restrito,
`admin_plataforma` com papel restrito) continuaram verdes nas duas rodadas —
nunca foram afetados pela trava.

## Direto no PostgREST — RLS real, antes/depois da 0097 (2026-09-27)

Driver: `infra/hub/testes/hub-financeiro-aprovador-furo.sh` (novo, `hub-test-*`
efêmero, SOMENTE `db`+`postgrest` — sem build do backend, que não participa
desta prova: a checagem de rota já está coberta ao nível de unit acima).
JWT gerado com o MESMO helper de produção (`lib/hub-postgrest-jwt.js`),
`sub`/`escopo` de um usuário com vínculo comum (`leitura`) na entidade —
prova que a RLS pré-0097 não distinguia "qualquer membro da entidade" de
"admin_plataforma" para conceder papel restrito.

ANTES (schema em `0096`, migração `-t 0096`):

```
POST /UsuarioEntidade {papel_id: admin_plataforma} -> HTTP 201  (furo: autorizado)
POST /PapelPermissao {arbitrário}                  -> HTTP 409  (conflito de
  chave, NÃO de permissão -- "duplicate key value violates unique constraint
  PapelPermissao_pkey": a escrita foi AUTORIZADA, só colidiu com uma linha
  existente; prova o mesmo furo sem exigir um par (papel_id,permissao_id) inédito)
```

DEPOIS (série completa, `0097`+`0098` aplicadas):

```
POST /UsuarioEntidade {papel_id: admin_plataforma} -> HTTP 403
  {"code":"42501","message":"new row violates row-level security policy for table \"UsuarioEntidade\""}
POST /PapelPermissao {arbitrário}                  -> HTTP 403
  {"code":"42501","message":"permission denied for table PapelPermissao"}
```

Evidência bruta: `EVIDENCIA-F2-POSTGREST-ANTES.txt` / `-DEPOIS.txt` (mesmo
diretório). Container/imagem do `hub-test-*` desta rodada foram removidos ao
final (`docker compose down -v --rmi local`); confirmado sem sobra
(`docker ps -a` / `docker images` sem `hub-test-*` residual).

tasks.md 2.1.1/2.1.2/2.1.4/2.1.5 (Cenário F2.4) resolvidos por esta prova.
2.1.3 (`PUT /usuarios/:id` trocando senha de alvo com vínculo `admin_plataforma`)
não foi repetido contra um backend real: a checagem (`papelEhRestrito`, lista
hardcoded em `lib/hub-papeis-restritos.js`) é independente do estado da
migration — já demonstrada acima ao nível de unit (mock), e sua contraparte
de banco (RLS de `UsuarioEntidade` no `UPDATE`) é a MESMA policy provada
acima para o `INSERT`. 2.3.4 (rollback `0097`) e o rollback/quickstart da
`0098` foram conferidos à parte, via
`infra/hub/testes/hub-repasse-saldo-minimo.sh` (SQL-only, transacional contra
`hub_homolog_db`) — ver tasks.md.

Pendente ainda: 2.5.1-2.5.7 (cenários RBAC completos F2.1-F2.5 + rodar
`hub-rbac-integration.sh`/`hub-papeis-integration.sh` + revisão adversarial)
— exige backend real (build da imagem), não coberto nesta onda.
