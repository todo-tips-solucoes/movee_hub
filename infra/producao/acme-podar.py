#!/usr/bin/env python3
"""
acme-podar — remove entradas de certificado do acme.json do Traefik, com rede.

── Por que existe ──────────────────────────────────────────────────────────────
O acme.json de produção tem 31 domínios, 381 KB e as CHAVES PRIVADAS de tudo que
roda no host, inclusive `registry.todo-tips.com` (de onde saem os deploys) e
`postgrest.todo-tips.com` (que o backend usa). Um erro nesse arquivo derruba o
TLS do host inteiro. Editar isso à mão, num terminal, sob incidente, é o pior
lugar possível para um deslize de vírgula — e um heredoc colado no terminal deste
host já colapsou antes (CLAUDE.md).

Então o arquivo se edita por programa: backup primeiro, remoção só do que foi
nomeado, e o resultado é validado ANTES de substituir o original.

── O que NÃO faz ───────────────────────────────────────────────────────────────
Não para nem sobe o Traefik. O Traefik mantém o estado do ACME em memória e
reescreve o arquivo, então editar com ele no ar é jogar fora a edição — parar e
subir é decisão do operador, com janela, e está no runbook.

Uso:
    acme-podar.py --arquivo acme.json --remover dom1[,dom2...] [--aplicar]

Sem `--aplicar` é um ensaio: mostra o que sairia e não escreve nada.
Runbook: docs/plans/infra-certificados/RUNBOOK-CORRECAO.md
"""

import argparse
import json
import os
import shutil
import sys
import time


def carregar(caminho):
    with open(caminho, encoding="utf-8") as f:
        return json.load(f)


def podar(dados, remover):
    """Devolve (novos_dados, removidos, restantes). Não muta a entrada."""
    novos = json.loads(json.dumps(dados))
    removidos, restantes = [], []
    for resolver, corpo in novos.items():
        certs = corpo.get("Certificates") or []
        mantidos = []
        for c in certs:
            main = (c.get("domain") or {}).get("main")
            if main in remover:
                removidos.append(f"{resolver}:{main}")
            else:
                mantidos.append(c)
                restantes.append(f"{resolver}:{main}")
        corpo["Certificates"] = mantidos
    return novos, removidos, restantes


def conferir(novos, dados, remover):
    """Recusa a escrita se o resultado não for exatamente o pedido.

    A conta tem de fechar nos dois sentidos: nada a mais removido (perder um
    certificado alheio derruba o TLS de outro produto) e nada a menos (deixar o
    domínio quebrado para trás faz o incidente continuar de pé, com a aparência
    de resolvido).
    """
    antes = sum(len(v.get("Certificates") or []) for v in dados.values())
    depois = sum(len(v.get("Certificates") or []) for v in novos.values())
    mains_antes = {
        (c.get("domain") or {}).get("main")
        for v in dados.values()
        for c in (v.get("Certificates") or [])
    }
    alvos_presentes = remover & mains_antes
    ausentes = remover - mains_antes
    if ausentes:
        raise SystemExit(
            f"ABORTADO: estes domínios não existem no arquivo: {sorted(ausentes)}\n"
            "Confira a grafia — remover o domínio errado é o erro caro aqui."
        )
    if antes - depois != len(alvos_presentes):
        raise SystemExit(
            f"ABORTADO: esperava remover {len(alvos_presentes)}, o resultado tem "
            f"{antes - depois} a menos. Nada foi escrito."
        )
    if not novos.keys() == dados.keys():
        raise SystemExit("ABORTADO: os resolvers mudaram. Nada foi escrito.")
    for resolver, corpo in novos.items():
        if corpo.get("Account") != dados[resolver].get("Account"):
            raise SystemExit(f"ABORTADO: a conta ACME de {resolver} mudou. Nada foi escrito.")


def main():
    p = argparse.ArgumentParser(description="Remove entradas de certificado do acme.json do Traefik")
    p.add_argument("--arquivo", required=True, help="caminho do acme.json (uma CÓPIA, com o Traefik parado)")
    p.add_argument("--remover", required=True, help="domínios (domain.main) separados por vírgula")
    p.add_argument("--aplicar", action="store_true", help="escreve de verdade; sem isso é ensaio")
    args = p.parse_args()

    remover = {d.strip() for d in args.remover.split(",") if d.strip()}
    if not remover:
        raise SystemExit("ABORTADO: nenhum domínio informado em --remover.")

    dados = carregar(args.arquivo)
    novos, removidos, restantes = podar(dados, remover)
    conferir(novos, dados, remover)

    print(f"remover  ({len(removidos)}): {sorted(removidos)}")
    print(f"manter   ({len(restantes)}): {len(restantes)} entradas preservadas")

    if not args.aplicar:
        print("\nENSAIO — nada foi escrito. Repita com --aplicar para valer.")
        return

    backup = f"{args.arquivo}.bak-{time.strftime('%Y%m%dT%H%M%S')}"
    shutil.copy2(args.arquivo, backup)
    os.chmod(backup, 0o600)

    tmp = f"{args.arquivo}.novo"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(novos, f)
    os.chmod(tmp, 0o600)

    # Relê o que foi escrito antes de substituir: um JSON truncado aqui derruba
    # o TLS do host inteiro na próxima subida do Traefik.
    reconferido = carregar(tmp)
    if reconferido != novos:
        raise SystemExit(f"ABORTADO: o arquivo escrito não confere. Original intacto. Veja {tmp}")

    os.replace(tmp, args.arquivo)
    print(f"\nOK. Backup: {backup}")
    print(f"Rollback: cp {backup} {args.arquivo}")


if __name__ == "__main__":
    sys.exit(main())
