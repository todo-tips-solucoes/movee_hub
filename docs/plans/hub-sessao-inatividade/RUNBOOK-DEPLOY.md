# Runbook de deploy — `hub-sessao-inatividade`

Renovação silenciosa da sessão do hub (proxy do `frontend_v2`), refresh
deslizante de **6 h** de inatividade e vida máxima de **24 h** desde o login
(backend). **Sem migration**: o instante do login viaja carimbado no próprio
refresh token (`<ms do login>.<256 bits>`), autenticado pelo hash gravado em
`SessaoRefresh`. Nada muda no banco.

> **O ambiente chamado "homologação" É produção.** Todo comando aqui atinge
> clientes reais. Execução sob os 5 gates do rito
> ([`docs/RITO-PRODUCAO.md`](../../RITO-PRODUCAO.md)).

---

## 0. Estado atual — anote antes de começar (este é o rollback)

Levantado em 2026-09-05 (`docker service ls`):

| Serviço | Imagem no ar (= **rollback**) |
|---|---|
| `envio-massa-homologacao_backend_homologacao` | `registry.todo-tips.com/envio-massa-backend:hub-motorista-360-3e607aa` |
| `envio-massa-homologacao_frontend_v2_homologacao` | `registry.todo-tips.com/envio-massa-frontend-v2:hub-enriq-feedback-c3ce2d6` |

- `ENV BACKEND_URL` do `frontend_v2/Dockerfile`:
  `https://envmassapihomologacao.todo-tips.com` — correto para este ambiente.
- Tag desta entrega: **`hub-sessao-<sha7>`** com `sha7 = git rev-parse --short HEAD`
  na `main` **já mergeada**.

Reconferir na hora:

```bash
docker service ls --filter name=envio-massa-homologacao_ --format '{{.Name}}\t{{.Image}}'
docker run --rm registry.todo-tips.com/envio-massa-backend:hub-motorista-360-3e607aa node --version   # v20.x
```

---

## 1. Pré-flight — abortar se qualquer um falhar

```bash
df -h /            # ABORTAR se < ~20 GB livres
free -h; swapon --show   # swap ATIVA e com folga
git -C /var/lib/envioMassa_homologacao status --short | grep -v '^??'   # vazio
git -C /var/lib/envioMassa_homologacao log -1 --oneline                  # a main mergeada
```

---

## 2. Build (a partir da main mergeada) e push

```bash
cd /var/lib/envioMassa_homologacao && git checkout main && git pull --ff-only
SHA7=$(git rev-parse --short HEAD); TAG=hub-sessao-$SHA7; echo $TAG

cd app_homologacao/backend
DOCKER_BUILDKIT=0 docker build --memory=2g -f Dockerfile.hub -t registry.todo-tips.com/envio-massa-backend:$TAG .
docker run --rm registry.todo-tips.com/envio-massa-backend:$TAG node --version   # DEVE ser v20.x
docker push registry.todo-tips.com/envio-massa-backend:$TAG

cd ../frontend_v2
grep -n '^ENV BACKEND_URL' Dockerfile   # https://envmassapihomologacao.todo-tips.com
DOCKER_BUILDKIT=0 docker build --memory=2g -t registry.todo-tips.com/envio-massa-frontend-v2:$TAG .
docker push registry.todo-tips.com/envio-massa-frontend-v2:$TAG
```

Anotar os digests do `push`.

---

## 3. Deploy — ordem: backend, depois frontend_v2

Backend primeiro: o frontend novo chama `POST /v1/auth/refresh`, que já existe
no backend atual — a ordem inversa também funciona, mas assim o backend novo
já emite tokens carimbados antes do proxy começar a renovar.

```bash
docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-backend:$TAG \
  envio-massa-homologacao_backend_homologacao

docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-frontend-v2:$TAG \
  envio-massa-homologacao_frontend_v2_homologacao   # stop-first, 1 réplica: downtime curto
```

Efeito nas sessões existentes: refresh tokens antigos (sem carimbo) continuam
válidos; na primeira renovação passam a contar o teto de 24 h a partir do
`criado_em` da linha e a janela de 6 h a partir dali. Ninguém é deslogado
pelo deploy do backend; o do frontend_v2 tem o downtime curto de sempre.

---

## 4. Smoke + prova do código servido

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://app.moveelog.com.br/hub/login          # 200
curl -s -o /dev/null -w '%{http_code}\n' https://envmassapihomologacao.todo-tips.com/api/v1/me   # 401 (sem cookie)
```

Prova de que o **backend** novo está no ar (só ele emite refresh carimbado e
`Max-Age=21600`): logar e olhar o `Set-Cookie` — sem expor o valor.

```bash
curl -s -D - -o /dev/null -H 'Content-Type: application/json' \
  -d '{"email":"<conta de prova>","senha":"<senha>"}' \
  https://app.moveelog.com.br/api/v1/auth/login \
  | grep -i '^set-cookie: hub_refreshToken' | sed -E 's/=([0-9]+)\.[0-9a-f]{64}/=\1.<oculto>/'
# esperado: hub_refreshToken=<13 dígitos>.<oculto>; Max-Age=21600; ...
```

Prova de que o **proxy** novo está no ar: com o jar acima, invalidar o access e
chamar uma rota do hub — o proxy renova e responde 200 com `Set-Cookie` novos.

```bash
curl -s -c jar -o /dev/null -H 'Content-Type: application/json' -d '{"email":"<conta>","senha":"<senha>"}' https://app.moveelog.com.br/api/v1/auth/login
sed -i '/hub_accessToken/d' jar                      # simula o access vencido/caído
curl -s -b jar -D - -o /dev/null https://app.moveelog.com.br/api/v1/me | grep -iE '^(HTTP|set-cookie: hub_accessToken)'
# esperado: HTTP/2 200 + Set-Cookie hub_accessToken novo (o proxy antigo devolvia 401 sem Set-Cookie)
rm -f jar
```

Prova comportamental (entregável 6 do briefing): usar o hub por > 15 min sem
cair; deixar uma aba parada 16 min e voltar sem cair.

---

## 5. Rollback

```bash
docker service update --with-registry-auth --image registry.todo-tips.com/envio-massa-backend:hub-motorista-360-3e607aa envio-massa-homologacao_backend_homologacao
docker service update --with-registry-auth --image registry.todo-tips.com/envio-massa-frontend-v2:hub-enriq-feedback-c3ce2d6 envio-massa-homologacao_frontend_v2_homologacao
```

Compatível nos dois sentidos: o backend antigo aceita os tokens carimbados
(faz hash do valor inteiro) e o novo aceita os antigos. Sem banco para
desfazer.
