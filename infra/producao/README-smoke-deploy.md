# smoke-deploy — conferência pós-deploy

`infra/producao/smoke-deploy.sh` prova que um deploy **subiu o código certo**, não só que o
serviço respondeu. **Só leitura**: nenhum `service update`, restart ou escrita no banco
(o banco recebe um único `SELECT`). Seguro a qualquer hora. Não imprime segredos.

## Como rodar

```bash
infra/producao/smoke-deploy.sh                                    # tudo, sem exigir tag
infra/producao/smoke-deploy.sh -t fix-filtros-2ff2b6c             # exige a tag em backend, frontend_v2 e frontend_motorista
infra/producao/smoke-deploy.sh -t fix-filtros-2ff2b6c -t frontend_motorista=ajuda-6415a0a   # tag por serviço
infra/producao/smoke-deploy.sh -B                                 # sem a checagem de banco
infra/producao/smoke-deploy.sh -s outro-arquivo.strings           # outras strings de bundle
```

Saída: uma linha `OK`/`FALHA` por verificação e `N verificações, M falhas`. Código de saída
`0` = tudo OK, `1` = alguma falha, `2` = uso incorreto.

## O que verifica e o que fazer na falha

| # | Verificação | Falha significa | Fazer |
|---|---|---|---|
| 1 | Tag da imagem dos 4 serviços (com `-t`: igual à esperada) | `no ar: X \| esperado: Y` = o deploy não aconteceu (ou foi outro serviço) | `docker service ps <serviço>`; refazer o `service update` (rito dos 5 gates) |
| 2 | `node --version` dentro do container vivo do backend = v20 | v14 = imagem buildada com o `Dockerfile` antigo | rollback para a imagem anterior; rebuildar com `Dockerfile.hub` |
| 3 | Cada `serviço\|tag\|string` (tag no ar ≠ registrada = FALHA) de `smoke-deploy.strings` existe no código servido | string AUSENTE = o container roda código velho (smoke 200 não prova isto) | conferir a tag; se a string for velha demais, atualizar o arquivo |
| 4 | `/hub/login`, `/login` e o app motorista respondem 200 | `curl 000 = certificado recusado` **não é queda**: a app responde com `-k`; ver `cert-guard`/Traefik. Outro código = serviço fora | `docker service ps`; logs do container |
| 5 | `POST /api/v1/adiantamentos/repasse/lotes/previa` = 401 | 404 = a rota sumiu; 5xx = quebrou | olhar o backend; considerar rollback |
| 6 | Funções `hub_repasse_%` existem em `chatmasterveloz` | nenhuma = migration não aplicada (ou `psql` falhou) | aplicar a migration **antes** do código (rito); SIGUSR1 no `pgadmin_postgrest` |

## Manutenção a cada deploy

- `smoke-deploy.strings` guarda linhas `serviço|tag|string`. Se a tag no ar não for a registrada, o smoke FALHA ("ATENCAO ... a prova de bundle NAO vale"): atualize o arquivo no deploy. A string deve ser **ASCII** (acento não
  casa através do `docker exec`) e existir só na entrega nova. Troque-a a cada deploy.
  Verificação de bundle só vale para `backend`, `frontend_v2` e `frontend_motorista`.
- O backend é inspecionado em `routes lib server.js`; os frontends em `.next` (o BusyBox do
  alpine não tem `grep --exclude-dir`).
- Containers são resolvidos pelo nome exato do Swarm (`envio-massa-homologacao_<svc>_homologacao.N.<hash>`),
  nunca por `grep | head`. O banco é o `pgadmin_db` de produção (não o `hub_homolog_db`).
