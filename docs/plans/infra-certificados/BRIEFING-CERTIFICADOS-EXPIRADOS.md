# Briefing — certificados TLS expirados no VPSTodo (INCIDENTE ATIVO)

Prompt para sessão limpa. **Leia o `CLAUDE.md` do repositório antes de qualquer
coisa.** O ambiente chamado "homologação" É produção. O Traefik **não** é recurso
`hub-*`, então a exceção standing não vale aqui: vale o **rito integral dos 5 gates**
(autorização explícita para esta mudança · janela combinada · rollback à mão ·
aplicação controlada · smoke test). Autorização é **por etapa**.

## O impacto agora

**Usuários estão vendo aviso de segurança do navegador nos dois domínios do produto.**
A aplicação está 100% sã — é só TLS. Medido em 2026-09-10 00:30 UTC:

| Teste | Resultado |
|---|---|
| `curl https://app.moveelog.com.br/login` | falha, `curl: (60) certificate has expired` |
| `curl -k` (mesma URL, sem validar cert) | **200** |
| `curl -k https://app.moveelog.com.br/api/v1/me` | **401** (rota existe, exige auth) |
| controle: `curl -k .../api/v1/nao-existe` | **404** (prova que o 401 significa algo) |

No log do Traefik, o efeito em usuários reais:
`http: TLS handshake error from <ip>: remote error: tls: expired certificate`,
de vários IPs distintos.

## A auditoria completa (medida, não suposta)

7 dos 31 domínios do `acme.json` estão com certificado expirado:

| dias | domínio roteado | CN no certificado | expira |
|---|---|---|---|
| -125 | n8n2.todo-tips.com | n8n2.todo-tips.com | May 8 2026 |
| -125 | webhook.todo-tips.com | webhook.todo-tips.com | May 8 2026 |
| -124 | pgadmin2.todo-tips.com | pgadmin2.todo-tips.com | May 9 2026 |
| -124 | postgrest2.todo-tips.com | postgrest2.todo-tips.com | May 9 2026 |
| -8 | appmotorista.todo-tips.com | appmotorista.todo-tips.com | Sep 2 2026 |
| **-1** | **app.motorista.moveelog.com.br** | **appmotorista.todo-tips.com** ⚠️ | Sep 9 22:44 |
| **-1** | **app.moveelog.com.br** | **envmassv2.todo-tips.com** ⚠️ | Sep 9 22:41 |

Os outros 24 renovam normalmente (validade em Nov/Dez 2026) — **o ACME funciona**.

## A causa, e o que a sustenta

As duas entradas do produto têm **CN diferente do domínio roteado**: a entrada de
`app.moveelog.com.br` guarda o certificado de `envmassv2.todo-tips.com`, e a de
`app.motorista.moveelog.com.br` guarda o de `appmotorista.todo-tips.com`.

Interpretação: no rebrand para `moveelog.com.br` (Traefik `label-add`), a entrada foi
criada reaproveitando o certificado do domínio antigo. Para o Traefik aquela entrada
está "resolvida", então ele **nunca emitiu** certificado para o nome novo e nunca
renovou. Evidência que reforça: `envmassv2.todo-tips.com` tem entrada **própria e
renovada** (expira Sep 10 18:18) — ou seja, o Traefik renova o domínio antigo e
serve ao domínio novo uma cópia velha do mesmo certificado.

⚠️ **Isto é interpretação, não fato medido.** O que está medido é o descasamento
CN × domínio e o fato de as outras 24 renovarem. Confirme antes de agir.

## Configuração relevante (já levantada)

```
--certificatesresolvers.letsencryptresolver.acme.httpchallenge=true
--certificatesresolvers.letsencryptresolver.acme.httpchallenge.entrypoint=web
--certificatesresolvers.letsencryptresolver.acme.storage=/etc/traefik/letsencrypt/acme.json
--certificatesresolvers.letsencryptresolver.acme.email=paulo@todo-tips.com
--log.level=DEBUG --log.filePath=/var/log/traefik/traefik.log
```

- Serviço: `traefik_traefik`, imagem `traefik:v3.5.3`, 1/1 réplica.
- Storage: volume `volume_swarm_certificates` → `/etc/traefik/letsencrypt`.
- Labels dos routers estão **corretas**:
  `traefik.http.routers.frontendv2apphomologacao.rule=Host(`app.moveelog.com.br`)` +
  `.tls.certresolver=letsencryptresolver` (idem `appmotorista` para o domínio do motorista).

## O que se quer

Restaurar TLS válido nos **dois domínios do produto** (`app.moveelog.com.br` e
`app.motorista.moveelog.com.br`) e deixar a renovação automática funcionando para
eles como funciona para os outros 24.

Os 5 domínios legados expirados (`n8n2`, `webhook`, `pgadmin2`, `postgrest2`,
`appmotorista.todo-tips.com`) são **escopo separado**: decidir com o operador se
ainda existem serviços atrás deles. Se não, a ação é limpar as entradas — não emitir
certificado para o que foi desativado.

## Restrições e riscos — leia antes de tocar no acme.json

🔴 **O `acme.json` tem 31 domínios e 381 KB.** Um erro nesse arquivo derruba o TLS de
**tudo** no host, inclusive `registry.todo-tips.com` (de onde saem os deploys) e
`postgrest.todo-tips.com` (que o backend usa). **Backup do arquivo antes**, e o
rollback é restaurar o backup + reiniciar o Traefik.

🔴 **Limites do Let's Encrypt** — forçar reemissão não é grátis:
- 5 validações falhas por hora, por conta e por hostname;
- 50 certificados por semana por domínio registrado;
- 5 certificados duplicados por semana (mesmo conjunto de nomes).
Se o desafio HTTP-01 falhar, cada tentativa queima cota. **Confirme que a porta 80
chega ao host de fora** (o desafio usa o entrypoint `web`) **antes** de forçar
qualquer reemissão. Um `iptables`/firewall bloqueando 80 explicaria a falha e
tornaria a reemissão impossível — nesse caso o caminho é outro (DNS-01).

🔴 **Não editar o `acme.json` com o Traefik rodando** — ele mantém estado em memória
e sobrescreve. O padrão seguro é: parar/escalar a zero, editar, subir.

⚠️ **O arquivo contém CHAVES PRIVADAS.** Nunca imprimir o conteúdo, nunca colar em
log, nunca versionar. Extraia apenas nomes e datas (há um script pronto no final).

⚠️ **Traefik loga em ARQUIVO, não no stdout** (`--log.filePath`). `docker logs` não
mostra nada de ACME — foi o que atrasou este diagnóstico. Use
`docker exec <traefik> grep -i acme /var/log/traefik/traefik.log`.

⚠️ **`curl` devolvendo `000` parece queda total e não é** — é o próprio curl
recusando o certificado. Sempre confirmar com `-k` antes de concluir que a aplicação
caiu, e olhar `curl -sS` para ver o erro real.

⚠️ Do host, o domínio público pode ter latência de hairpin — se um teste externo for
necessário, prefira medir de fora do VPSTodo.

## Contexto para não confundir com outra coisa

Em 2026-09-09 21:24 BRT houve deploy do backend (`:hub-enriq-auto-3952eb3`) e a
migration `0060` foi aplicada em produção. **Nada disso causou o problema de
certificado**: os certs expiraram às 19:41/19:44 BRT, cerca de 1h40 **antes** do
deploy, e trocar imagem de backend não toca no Traefik. O rollback do backend é
`:hub-sessao-fix-1e281d0`, e não tem relação com este incidente.

## Entregáveis

1. Confirmação (ou refutação) da causa, com evidência.
2. Verificação de que a porta 80 chega de fora — pré-requisito do HTTP-01.
3. Runbook com os 5 gates e rollback explícito, para o operador aprovar **antes** de
   qualquer escrita.
4. Execução, com autorização por etapa.
5. Prova pós-correção, medida **de fora do host**: `openssl s_client` nos dois
   domínios mostrando `CN` igual ao domínio e `notAfter` ~90 dias à frente, e
   `curl` **sem** `-k` devolvendo 200.
6. Recomendação para que isto não volte: hoje nada avisa que um certificado vai
   expirar — 4 domínios estão expirados há 4 meses e ninguém soube. Um check
   simples de validade (o script abaixo) num timer do systemd fecha esse buraco.

## Script de auditoria (read-only, só nomes e datas — reutilize)

```bash
TID=$(docker ps -qf name=traefik | head -1)
docker exec "$TID" sh -c 'cat /etc/traefik/letsencrypt/acme.json' | python3 -c "
import json,sys,base64,subprocess,datetime
j=json.load(sys.stdin); agora=datetime.datetime.now(datetime.timezone.utc); L=[]
for res,v in j.items():
    for c in (v.get('Certificates') or []):
        main=c.get('domain',{}).get('main','?')
        der=base64.b64decode(c['certificate'])
        out=subprocess.run(['openssl','x509','-noout','-subject','-enddate'],input=der,capture_output=True).stdout.decode()
        cn=[l.split('CN = ')[-1].strip() for l in out.splitlines() if l.startswith('subject')][0]
        fim=[l.split('=')[1].strip() for l in out.splitlines() if l.startswith('notAfter')][0]
        dt=datetime.datetime.strptime(fim,'%b %d %H:%M:%S %Y %Z').replace(tzinfo=datetime.timezone.utc)
        L.append(((dt-agora).days, main, cn, fim))
L.sort()
for dias,main,cn,fim in L:
    print(f'{dias:>6}  {main:42} {cn:38} {fim}', 'EXPIRADO' if dias<0 else '', '<-- CN DIFERENTE' if cn!=main else '')
"
```
