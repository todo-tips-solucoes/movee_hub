# cert-guard — alarme de certificado TLS

Avisa **antes** de um certificado expirar. Nasceu do incidente de 2026-09-09, em
que os certificados de `app.moveelog.com.br` e `app.motorista.moveelog.com.br`
expiraram e a primeira notícia do problema foram os **clientes** vendo aviso de
segurança do navegador — enquanto quatro domínios legados já estavam expirados
havia **quatro meses** sem que ninguém soubesse.

O Traefik tentava renovar todo dia, falhava todo dia, e registrava a falha num
arquivo de log **dentro do container** (`--log.filePath`), que `docker logs` não
mostra e ninguém lia.

## O que ele mede

Para cada domínio roteado, abre um handshake TLS e lê o `notAfter` do
certificado **servido**.

- **Mede o que o usuário recebe**, não o que o `acme.json` guarda. Foi exatamente
  a diferença entre as duas coisas que criou o incidente.
- **Conecta em `127.0.0.1:443` com SNI**. Evita depender do DNS e do hairpin do
  VPSTodo (já medido em ~28 s) e ainda assim exercita o mesmo caminho TLS do
  cliente externo.
- **Descobre os domínios sozinho**, pelas regras `Host(...)` das labels dos
  serviços do Swarm. Lista fixa envelhece calada: um domínio novo entraria sem
  alarme, que é o buraco que este guard existe para fechar.

Limiares (env, todas opcionais): `CERT_LIMIAR_DIAS` (21), `CERT_LIMIAR_CRITICO_DIAS`
(7), `REAVISO_HORAS` (12), `CERT_DOMINIOS` (lista fixa, ignora a descoberta),
`CERT_ESTADO`, `CERT_TIMEOUT_MS` (8000).

## O que ele NÃO cobre

Entradas **órfãs** do `acme.json` — domínios que existem no arquivo mas não têm
router neste host (hoje: `n8n2`, `webhook`, `pgadmin2`, `postgrest2`,
`appmotorista`, `envmassv2`). Como ninguém as acessa, elas não afetam usuário
algum; mas o Traefik **continua tentando renová-las todo dia** e cada tentativa
queima cota de validação no Let's Encrypt. Auditá-las é manual, com o script de
`docs/plans/infra-certificados/RUNBOOK-CORRECAO.md`.

## Como rodar à mão

```bash
# sem enviar e-mail, com estado descartável
CERT_ESTADO=/tmp/cert-guard-teste.json node infra/producao/cert-guard.js --dry-run

# testes
node --test infra/producao/cert-guard.test.js
```

Códigos de saída: `0` tudo são · `1` algum certificado abaixo do limiar (a
unidade fica `failed` de propósito — é o rastro que sobrevive mesmo se o e-mail
não sair) · `2` o próprio guard falhou, que **nunca** deve ser lido como "ok".

## Instalação (host)

```bash
sudo ln -sf /var/lib/envioMassa_homologacao/infra/producao/cert-guard.service /etc/systemd/system/cert-guard.service
sudo ln -sf /var/lib/envioMassa_homologacao/infra/producao/cert-guard.timer   /etc/systemd/system/cert-guard.timer
sudo systemctl daemon-reload
sudo systemctl enable --now cert-guard.timer
systemctl list-timers cert-guard.timer --no-pager
```

## Canal de alerta

Reusa o SMTP do robô EntreGô (`infra/robo-entrego/src/alerta-email.js` + o `.env`
de `/var/lib/hub_secrets/robo-entrego`), como o `disco-guard`. Um segundo canal de
e-mail seria mais uma coisa para configurar, quebrar e esquecer.

⚠️ O VPSTodo tem as portas **25 e 465 filtradas na saída** — só 587 com STARTTLS
sai. É por isso que o `exit 1` importa: se o e-mail não sair, o alarme ainda fica
visível em `systemctl list-timers` e no `journalctl -u cert-guard`.
