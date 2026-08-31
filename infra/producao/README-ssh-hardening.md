# Endurecimento do SSH do VPSTodo (fail2ban + só chave)

Dois arquivos que vivem no host e são **fáceis de perder num reprovisionamento** —
por isso estão versionados aqui.

| Arquivo neste repo | Destino no host |
|---|---|
| `fail2ban-jail.local` | `/etc/fail2ban/jail.local` |
| `sshd-01-hardening.conf` | `/etc/ssh/sshd_config.d/01-hardening.conf` |

## Por que existem

Em 2026-08-30, investigando espaço em disco, `/var/log/btmp*` apareceu com 231 MB
só de tentativas de login falhadas. O `auth.log` tinha **7.757 falhas**, 1.823
delas contra `root` — e o servidor estava com `PermitRootLogin yes` e
`PasswordAuthentication yes`. Ou seja: aceitava exatamente o que o ataque procurava.

Duas camadas foram aplicadas:

1. **fail2ban** — desacelera: 5 falhas em 10 min banem o IP por 1h, dobrando a cada
   reincidência até 1 semana. Baniu 5 IPs na primeira hora.
2. **Só chave** — fecha o vetor: senha desligada, `root` só por chave.

## 🔴 Duas armadilhas — leia antes de aplicar em qualquer host

### 1. O prefixo `01` é parte da correção

No sshd **a PRIMEIRA diretiva encontrada vence**, e os drop-ins são lidos em ordem
alfabética. O arquivo nasceu como `99-hardening.conf` e **não funcionou**: o
`50-cloud-init.conf` (que o Ubuntu instala com `PasswordAuthentication yes`) era
lido antes e ganhava.

O `systemctl reload ssh` respondeu **`RELOAD OK`** e a senha continuou ligada.
Nunca declare o SSH endurecido por causa de um "OK".

### 2. `prohibit-password`, nunca `no`

O host é administrado **como root**. `PermitRootLogin no` bloquearia inclusive a
chave — lockout, com desbloqueio só pelo console da VPS.

## Instalar

**Pré-requisito inegociável**: confirme que o login por chave funciona **antes** de
desligar a senha, e faça isso com uma segunda sessão aberta.

```bash
# 1. a chave já é aceita? (procure um `Accepted publickey` recente para root)
grep "Accepted publickey" /var/log/auth.log | tail -3

# 2. fail2ban — troque <IP_DO_OPERADOR> pelo IP real ANTES de subir
sudo cp infra/producao/fail2ban-jail.local /etc/fail2ban/jail.local
sudo sed -i 's/<IP_DO_OPERADOR>/SEU.IP.AQUI/' /etc/fail2ban/jail.local
sudo systemctl restart fail2ban && sudo fail2ban-client status sshd

# 3. sshd — o `&&` garante que nada é recarregado se a sintaxe estiver errada
sudo cp infra/producao/sshd-01-hardening.conf /etc/ssh/sshd_config.d/01-hardening.conf \
  && sudo sshd -t && sudo systemctl reload ssh
```

⚠️ O `ignoreip` **não** carrega o IP real neste repositório (é dado pessoal, mesmo
princípio dos segredos em `/var/lib/hub_secrets/`). Sem preencher, o operador fica
sujeito a se autobanir com cinco erros de senha.

## Provar que funcionou — sem confiar em "OK"

```bash
# a config efetiva
sudo sshd -T | grep -E "^(permitrootlogin|passwordauthentication|maxauthtries)"
# esperado: prohibit-password (ou without-password) / no / 3

# a prova real: o servidor recusa senha
ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no root@127.0.0.1
# esperado: Permission denied (publickey).

sudo fail2ban-client status sshd     # jail ativa e banindo
sudo nft list ruleset | grep -A3 f2b # a regra existe no kernel
```

O último é útil porque `iptables -S` vem **vazio** neste host: o fail2ban usa
nftables, apesar de `jail.conf` dizer `banaction = iptables-multiport`. Olhar só o
iptables leva à conclusão errada de que o ban é decorativo.

## Rollback

```bash
sudo rm /etc/ssh/sshd_config.d/01-hardening.conf && sudo systemctl reload ssh
sudo systemctl stop fail2ban
```

O `sshd_config` original de 2026-08-30 está em `/root/sshd_config.bak-2026-08-30`.

## O que isto não faz

As tentativas **continuam chegando** — o atacante não sabe que a porta fechou. O
que mudou é que nenhuma pode dar certo, e quem insiste é banido. Silenciar o log
exigiria mudar a porta do SSH ou filtrar por IP de origem, o que atrapalha mais o
operador do que o atacante.
