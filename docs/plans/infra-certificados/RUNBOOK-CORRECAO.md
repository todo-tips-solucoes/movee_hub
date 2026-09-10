# Runbook — certificados TLS expirados no VPSTodo

Responde ao [`BRIEFING-CERTIFICADOS-EXPIRADOS.md`](BRIEFING-CERTIFICADOS-EXPIRADOS.md).
Diagnóstico medido em **2026-09-10 00:34–00:45 UTC**. Nada foi escrito no ambiente
vivo: este documento é o artefato para o operador aprovar **antes** de qualquer
execução.

---

## 1. Causa — confirmada, e diferente da hipótese do briefing

O briefing supôs que a entrada de `app.moveelog.com.br` guardava uma **cópia do
certificado do domínio antigo**, e que por isso o Traefik nunca teria emitido um
certificado para o nome novo. **Não é isso.** O que está acontecendo:

> Os certificados dos dois domínios do produto são **multi-SAN**: cobrem o nome
> novo **e** o nome antigo. O nome antigo foi **apagado do DNS** no rebrand. Na
> renovação, o cliente ACME pede um certificado com **todos os nomes do
> certificado atual** — inclusive o nome morto — e a ordem inteira falha com
> NXDOMAIN. Resultado: nunca renova, e expira.

Medições que sustentam isso:

| # | Evidência | Onde |
|---|---|---|
| 1 | O cert de `app.moveelog.com.br` tem `SAN: DNS:app.moveelog.com.br, DNS:envmassv2.todo-tips.com` — cobre os **dois** nomes | `acme.json`, via `openssl x509 -ext subjectAltName` |
| 2 | O cert do motorista tem `SAN: DNS:app.motorista.moveelog.com.br, DNS:appmotorista.todo-tips.com` | idem |
| 3 | O Traefik **tenta renovar todo dia**, às 12:11 UTC | `Testing certificate renew...` em todos os logs rotacionados |
| 4 | O pedido de renovação inclui o nome morto | `[envmassv2.todo-tips.com, app.moveelog.com.br] acme: Obtaining bundled SAN certificate` |
| 5 | A ordem falha **só** por causa do nome morto | `Error renewing certificate from LE: {app.moveelog.com.br []} error="...[envmassv2.todo-tips.com] ... DNS problem: NXDOMAIN..."` |
| 6 | Os nomes antigos não resolvem | `dig +short A envmassv2.todo-tips.com @1.1.1.1` → vazio (idem `appmotorista`) |
| 7 | Os nomes novos resolvem para este host | `app.moveelog.com.br` e `app.motorista.moveelog.com.br` → `178.156.254.243` = IPv4 público do VPSTodo |
| 8 | Nenhum router serve os nomes antigos | as labels do Swarm só têm `Host(\`app.moveelog.com.br\`)` / `Host(\`app.motorista.moveelog.com.br\`)`; `appmotorista` é o **nome do router**, não um Host |

**Correção de premissa do briefing:** o descasamento `CN` × domínio roteado é um
falso alarme. O `CN` é apenas o primeiro nome do certificado; os navegadores
validam pelo **SAN**, e o SAN cobre o domínio certo. O certificado servido é
legítimo para o domínio — está **só expirado**.

### O que isso muda na correção

Forçar reemissão por cima **não resolveria**: o pedido continuaria carregando o
nome morto e falhando igual. A correção tem de **tirar o nome morto do pedido**.

---

## 2. A porta 80 chega de fora — pré-requisito do HTTP-01, verificado

| Prova | Resultado |
|---|---|
| Emissões bem-sucedidas recentes neste host | `sara.todo-tips.com` em **2026-09-07**, `langfuse` em 09-05, `barbeariadavilla` em 09-03 (`Server responded with a certificate`) |
| `sara.todo-tips.com` resolve para | `178.156.254.243` — **o mesmo IP** dos domínios moveelog |
| O desafio de `app.moveelog.com.br` em si | **passou**: o erro da ordem cita apenas `envmassv2.todo-tips.com` |
| Porta 80 escutando | `0.0.0.0:80` e `[::]:80` (docker-proxy) |
| Firewall | `iptables -P INPUT ACCEPT`, `ufw` inativo |

Não há bloqueio de porta 80. **DNS-01 não é necessário.**

Nota: `n8n2`, `pgadmin2` e `postgrest2` apontam para **outro** host
(`178.156.134.167`) — por isso o desafio deles devolve 404. Não é problema deste
servidor.

---

## 3. Escopo proposto da mudança

Remover do `acme.json` **8 entradas** e deixar o Traefik reemitir as 2 do produto:

| # | Entrada | Por quê | Efeito ao subir |
|---|---|---|---|
| 1 | `app.moveelog.com.br` | tem SAN morto; é o incidente | **reemite** com só o nome vivo |
| 2 | `app.motorista.moveelog.com.br` | idem | **reemite** com só o nome vivo |
| 3 | `envmassv2.todo-tips.com` | órfã: sem router, sem DNS | some; para de queimar cota |
| 4 | `appmotorista.todo-tips.com` | órfã: sem router, sem DNS | some; para de queimar cota |
| 5 | `n8n2.todo-tips.com` | órfã: sem router aqui, DNS aponta para outro host | some |
| 6 | `webhook.todo-tips.com` | órfã: sem router, DNS NXDOMAIN | some |
| 7 | `pgadmin2.todo-tips.com` | órfã: sem router aqui, DNS aponta para outro host | some |
| 8 | `postgrest2.todo-tips.com` | órfã: sem router aqui, DNS aponta para outro host | some |

As 6 órfãs (#3–#8) são o "escopo separado" do briefing. **Nenhuma tem router
neste host**, então nenhum usuário as alcança; elas apenas fazem o Traefik gastar
uma tentativa de validação por dia, cada uma. Removê-las **não emite nada** — só
para o desperdício. Se algum dia um serviço voltar a usar esses nomes, basta a
label do router: o Traefik emite sozinho.

> **Decisão do operador:** #1 e #2 são obrigatórias. #3–#8 são opcionais na mesma
> janela (custo marginal zero, já que o Traefik estará parado). Diga se entram.

**Não entram nesta mudança:** nenhuma outra entrada do `acme.json`, nenhuma label
de serviço, nenhuma imagem, nenhum registro DNS.

### Alternativa considerada e descartada

Recriar os registros A de `envmassv2` e `appmotorista` apontando para este host
faria a renovação passar sem tocar no `acme.json` e sem downtime. Foi descartada
porque **mantém a bomba armada**: o certificado seguiria dependendo para sempre
de um nome que o rebrand aposentou, e no dia em que alguém removesse o DNS de
novo o incidente voltaria idêntico. Fica registrada como plano B se o operador
preferir zero downtime agora e a poda numa janela tranquila.

---

## 4. Rate limits do Let's Encrypt — a conta antes de agir

| Limite | Situação |
|---|---|
| 5 certificados **duplicados** (mesmo conjunto de nomes) por semana | O conjunto pedido será `{app.moveelog.com.br}` — **conjunto novo**, nunca emitido. Os existentes são `{app.moveelog.com.br, envmassv2.todo-tips.com}`. **0 de 5 usados.** |
| 50 certificados por semana por domínio registrado | `moveelog.com.br` terá **2**. |
| 5 validações falhas por hora por hostname | As falhas diárias foram em `envmassv2` / `appmotorista`, **não** nos nomes novos. Os nomes novos validam com sucesso hoje (evidência #4 da seção 2). |

Margem confortável. Ainda assim: **se a primeira subida falhar, parar e
diagnosticar** — não repetir a operação, para não queimar cota.

---

## 5. Os 5 gates

| Gate | Estado |
|---|---|
| **G1 — Autorização explícita** | ⬜ **pendente**: o operador precisa autorizar *esta* mudança (as 8 entradas da seção 3, ou só as 2 obrigatórias). Autorização genérica ou antiga não vale. |
| **G2 — Janela combinada** | ⬜ **pendente**. O Traefik é a porta de entrada de **tudo** no host: parar = **todo o host sem HTTP/HTTPS** durante a troca (estimativa: 10–30 s). Isso inclui `registry.todo-tips.com`, `postgrest.todo-tips.com`, o painel, o app motorista e os produtos de terceiros no mesmo host. |
| **G3 — Rollback à mão** | ✅ preparado (seção 7), com backup verificado antes de qualquer escrita. |
| **G4 — Aplicação controlada** | ✅ `docker service scale` + edição por programa (`acme-podar.py`, já testado em cópia real). **Não** é `docker stack deploy`. Não há troca de imagem aqui, então o `--image` do rito não se aplica. |
| **G5 — Smoke test** | ✅ roteiro na seção 8, com controle e sem expor segredos. |

⚠️ O Traefik **não** é recurso `hub-*` — a exceção standing não vale. Rito integral.

---

## 6. Execução — passo a passo

Tudo com `umask 077`. O `acme.json` contém **chaves privadas**: nunca imprimir o
conteúdo, nunca versionar, nunca colar em log.

### Passo 0 — anotar o estado atual (rollback)

```bash
docker service ls --filter name=traefik_traefik --format '{{.Name}}\t{{.Image}}\t{{.Replicas}}'
docker volume inspect volume_swarm_certificates --format '{{.Mountpoint}}'
```

Anote a imagem (`traefik:v3.5.3`) e o mountpoint. **A imagem não muda nesta
operação** — só as réplicas sobem e descem.

### Passo 1 — backup, com o Traefik ainda no ar

```bash
umask 077
ACME=$(docker volume inspect volume_swarm_certificates --format '{{.Mountpoint}}')/acme.json
BKP=/var/lib/hub_secrets/acme-backup-$(date -u +%Y%m%dT%H%M%SZ).json
cp -a "$ACME" "$BKP"
chmod 600 "$BKP"
python3 -c "import json,sys; d=json.load(open('$BKP')); print('backup ok:', sum(len(v.get('Certificates') or []) for v in d.values()), 'entradas')"
ls -la "$BKP"
```

Esperado: `backup ok: 31 entradas`. **Se não der 31, pare aqui.**

### Passo 2 — parar o Traefik

```bash
docker service scale traefik_traefik=0
# aguarde a tarefa sumir antes de editar — o Traefik reescreve o arquivo ao sair
docker service ps traefik_traefik --format '{{.CurrentState}}'
```

⏱️ **O downtime começa aqui.**

### Passo 3 — podar

```bash
python3 /var/lib/envioMassa_homologacao/infra/producao/acme-podar.py \
  --arquivo "$ACME" \
  --remover app.moveelog.com.br,app.motorista.moveelog.com.br,envmassv2.todo-tips.com,appmotorista.todo-tips.com,n8n2.todo-tips.com,webhook.todo-tips.com,pgadmin2.todo-tips.com,postgrest2.todo-tips.com
```

Primeiro **sem** `--aplicar` (ensaio). Confira: `remover (8)` e `manter (23)`.
Depois repita **com** `--aplicar`.

> Se o operador optar só pelas 2 obrigatórias, use
> `--remover app.moveelog.com.br,app.motorista.moveelog.com.br` e espere
> `remover (2)` / `manter (29)`.

O script recusa a escrita se a conta não fechar, se um domínio informado não
existir no arquivo, se a `Account` ACME mudar, ou se o arquivo escrito não reler
igual. Ele faz backup próprio além do do Passo 1.

### Passo 4 — subir o Traefik

```bash
docker service scale traefik_traefik=1
docker service ps traefik_traefik --format '{{.CurrentState}}'
```

⏱️ **O downtime termina quando a tarefa fica `Running`.**

### Passo 5 — acompanhar a emissão (leva segundos)

```bash
TID=$(docker ps -qf name=traefik_traefik | head -1)
docker exec "$TID" sh -c 'grep -E "Server responded with a certificate|Error renewing" /var/log/traefik/traefik.log | tail -20'
```

Esperado: `[app.moveelog.com.br] Server responded with a certificate.` e o mesmo
para o domínio do motorista. **Se aparecer `Error renewing` para eles, pare** e
faça o rollback — não repita a operação (rate limit).

---

## 7. Rollback

Gatilho: qualquer erro no Passo 3, o Traefik não subir no Passo 4, ou emissão
falhando no Passo 5.

```bash
docker service scale traefik_traefik=0
cp "$BKP" "$ACME"
chmod 600 "$ACME"
python3 -c "import json; d=json.load(open('$ACME')); print('restaurado:', sum(len(v.get('Certificates') or []) for v in d.values()), 'entradas')"
docker service scale traefik_traefik=1
```

Esperado: `restaurado: 31 entradas`. O estado volta a ser exatamente o de agora —
os dois domínios do produto seguem com certificado expirado, que é o incidente,
mas **nada além disso piora**. O `acme-podar.py` também deixa seu próprio backup
`acme.json.bak-<timestamp>` ao lado do arquivo.

---

## 8. Prova pós-correção

### 8.1 — no host (cadeia e datas)

```bash
for d in app.moveelog.com.br app.motorista.moveelog.com.br; do
  echo "== $d"
  echo | openssl s_client -connect 127.0.0.1:443 -servername "$d" 2>/dev/null \
    | openssl x509 -noout -subject -enddate -ext subjectAltName
done
```

Aprova se, para os dois: `notAfter` ≈ **90 dias à frente**, e o `subjectAltName`
contém **apenas** o domínio novo (sem `envmassv2` / `appmotorista`). O
desaparecimento do nome antigo é o que prova que a causa foi removida — não só
que a data mudou.

### 8.2 — validação real da cadeia, sem `-k`

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://app.moveelog.com.br/login
curl -sS -o /dev/null -w '%{http_code}\n' https://app.motorista.moveelog.com.br/
# CONTROLE — prova que o 200 acima significa algo:
curl -sS -o /dev/null -w '%{http_code}\n' -k https://app.moveelog.com.br/api/v1/nao-existe   # espera 404
```

Aprova se os dois primeiros derem **200 sem `-k`** (antes: `curl: (60)
certificate has expired`) e o controle der **404**.

### 8.3 — de fora do host

1. **Operador abre os dois domínios no navegador do celular** (fora da rede do
   VPSTodo) e confirma o cadeado, sem aviso. Esta é a prova que fecha o
   incidente — é literalmente o que o cliente vê.
2. Registro público de transparência (confirma que a emissão saiu de fato, e é
   consultado de fora):
   `https://crt.sh/?q=app.moveelog.com.br` — deve mostrar uma entrada emitida
   hoje, com **um único** nome.

### 8.4 — o alarme enxerga

```bash
CERT_ESTADO=/tmp/cert-guard-pos.json node /var/lib/envioMassa_homologacao/infra/producao/cert-guard.js --dry-run
```

Aprova se sair **`0`** e nenhum domínio aparecer como problema.

---

## 9. Para não voltar a acontecer

Hoje **nada** avisa que um certificado vai expirar: quatro domínios ficaram
expirados por **quatro meses** e a primeira notícia do problema do produto foram
os clientes. O Traefik loga a falha diária num arquivo **dentro do container**,
que `docker logs` não mostra.

Entregue nesta rodada, ainda **não instalado** (instalar é escrita no host —
gate à parte):

- `infra/producao/cert-guard.js` — mede o `notAfter` do certificado **servido**
  (handshake TLS em `127.0.0.1:443` com SNI), descobre os domínios sozinho pelas
  labels do Swarm, alerta em 21 dias e escala para crítico em 7. Reusa o SMTP do
  robô, como o `disco-guard`.
- `infra/producao/cert-guard.timer` / `.service` — diário às 09:00.
- `infra/producao/cert-guard.test.js` — **23 testes, todos verdes**.
- `infra/producao/README-cert-guard.md` — instalação e limites.

**Prova de que o alarme funciona:** rodado contra a produção de agora, ele
apontou exatamente os 2 domínios do incidente, com os SANs que explicam a causa,
e deixou de fora os 17 domínios sãos (`exit 1`).

Limite conhecido, documentado no README: o guard vigia o que é **servido**, então
entradas órfãs do `acme.json` (sem router) não geram alarme — elas não afetam
usuário, só queimam cota. É o que a poda da seção 3 resolve de uma vez.

---

## 9-bis. Execução — o que aconteceu de fato (2026-09-10)

Autorizado pelo operador (G1 + G2, escopo das **8** entradas, janela imediata,
período noturno). Executado entre **01:12 e 01:22 UTC**.

| Passo | Resultado |
|---|---|
| 1 — backup | `/var/lib/hub_secrets/acme-backup-20260910T011218Z.json`, **31 entradas**, modo 600 |
| 2 — parar | `0/0`, zero containers, porta 443 sem listener (confirmado antes de editar) |
| 3 — poda | `remover (8)` / `manter (23)`; `Account` e `registry`/`postgrest` intactos |
| 4 — subir | `1/1`, `traefik:v3.5.3` — **imagem inalterada** |
| 5 — emissão | `app.moveelog.com.br` na 1ª tentativa; o do motorista **na 3ª** (ver abaixo) |

Janela de downtime: **1 min 38 s** na primeira, mais dois restarts de ~20 s.

### O que não saiu como previsto

`app.motorista.moveelog.com.br` **validou** na primeira tentativa
(`authorization already valid; skipping challenge` → `Validations succeeded`) mas
o **`finalize` deu `net/http: timeout awaiting response headers`** — falha de
rede com a LE, não de validação. Ficou servindo o `TRAEFIK DEFAULT CERT`
(self-signed) por ~6 minutos.

Antes de retentar, foi medido: conectividade com a LE **200 em 0,12 s** (v4 e v6,
3 amostras) — o timeout era transitório. A 2ª tentativa falhou igual, a 3ª
emitiu. Ponto que importa para a próxima vez: **a Let's Encrypt deduplica ordens**
— as três tentativas caíram na mesma URL (`finalize/…/555466269776`), e como as
autorizações já estavam válidas, **nenhuma tentativa custou cota de validação**.
Só o `finalize` travava. Por isso retentar foi seguro; martelar sem ler o erro é
que não seria.

⚠️ **O log do Traefik vive DENTRO do container** (não há volume para
`/var/log/traefik`). Cada restart começa um arquivo novo — depois de reiniciar,
`grep` no `traefik.log` não acha nada do que aconteceu antes, e isso parece
"nenhuma tentativa" quando na verdade é "o histórico foi embora". Para preservar
evidência entre restarts, copiar o log **antes** de reiniciar.

### Prova (seção 8), medida às 01:22–01:25 UTC

| Prova | Resultado |
|---|---|
| 8.1 `app.moveelog.com.br` | `CN = app.moveelog.com.br`, issuer Let's Encrypt YR2, `notAfter=Dec 9 00:17:06 2026`, **SAN só o nome novo** |
| 8.1 `app.motorista.moveelog.com.br` | `CN = app.motorista.moveelog.com.br`, issuer YR1, `notAfter=Dec 9 00:23:12 2026`, **SAN só o nome novo** |
| 8.2 `curl` **sem** `-k` | **200** nos dois (antes: `curl: (60) certificate has expired`) |
| 8.2 controle | `/api/v1/nao-existe` → **404**; `/api/v1/me` → **401** |
| 8.4 `cert-guard` | **exit 0**, 19 domínios, nenhum com problema |
| Não-regressão | os 17 domínios fora do escopo seguem idênticos ao pré-mudança (registry 57 d, postgrest 58 d…) |
| `acme.json` final | **25 entradas** (23 mantidas + 2 reemitidas), **nenhuma órfã** |

O desaparecimento do nome antigo do SAN é o que prova que a **causa** foi
removida — não apenas que a data mudou. A renovação de dezembro vai pedir só o
nome vivo.

Pendente: prova no navegador do operador, fora da rede do VPSTodo (8.3).

---

## 10. O que ficou deliberadamente de fora

- **Instalar o timer** do `cert-guard`: é escrita no host, precisa do seu aval.
- **Qualquer alteração de DNS**: nenhuma é necessária para a correção.
- **Os serviços por trás de `n8n2` / `pgadmin2` / `postgrest2`**: o DNS deles
  aponta para outro host (`178.156.134.167`). O que existe ou não lá é fora do
  escopo deste incidente; aqui só se removem as entradas órfãs do `acme.json`.
- **Rotação/limpeza do `access-log`** do Traefik (60 MB) e do aviso repetido
  `Labels traefik.docker.* … deprecated`: achados de passagem, sem relação com o
  incidente.
