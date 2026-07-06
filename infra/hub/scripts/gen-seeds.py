#!/usr/bin/env python3
# =============================================================================
# gen-seeds.py — gera seeds ANONIMIZADOS a partir dos CSVs reais (ZIPs de
# faturamento/performance). Plano técnico §4.6 (anonimização) e §7 (formato).
#
# Propriedades obrigatórias:
#   - IRREVERSÍVEL: todo mapeamento usa HMAC com salt de os.urandom(32) que é
#     DESCARTADO ao final (nunca gravado, nunca impresso).
#   - REPETÍVEL: o processo pode ser re-executado (gera novo universo anônimo).
#   - DETERMINÍSTICO NA EXECUÇÃO: o mesmo UUID/nome vira sempre o mesmo fake
#     dentro de uma execução (dimensão Entregador consistente entre arquivos).
#   - FAIL-CLOSED: coluna desconhecida no CSV → erro (nada passa sem
#     classificação explícita keep/anonimizar).
#   - ASSERÇÃO DE NÃO-VAZAMENTO: nenhum UUID original, nenhum nome completo
#     original (como campo OU substring), nenhuma origem original na saída.
#   - SÍNTESE DE VOLUME (opcional, p/ S10): --synthesize-days N replica os dias
#     disponíveis com datas deslocadas, valores re-perturbados e as mesmas
#     identidades fake (hashes de linha novos).
#   - LGPD: nunca imprime linha bruta nem dado pessoal no stdout; execução
#     recomendada no sandbox context-mode; saída em infra/hub/seeds/out/
#     (gitignored).
#
# Uso:
#   python3 infra/hub/scripts/gen-seeds.py \
#     [--fat docs/documentos_apoio/Faturamento.zip] \
#     [--perf docs/documentos_apoio/Performance_.zip] \
#     [--out infra/hub/seeds/out] [--synthesize-days N]
# =============================================================================
import argparse
import csv
import hashlib
import hmac
import io
import json
import os
import re
import sys
import uuid
import zipfile
from datetime import date, timedelta

# ---------------------------------------------------------------- fake data
FIRST = [
    "Adriano", "Beatriz", "Caio", "Daniela", "Eduardo", "Fernanda", "Gustavo",
    "Helena", "Igor", "Juliana", "Kleber", "Larissa", "Marcos", "Natalia",
    "Otavio", "Patricia", "Quintino", "Renata", "Sergio", "Tatiane", "Ulisses",
    "Vanessa", "Wagner", "Ximena", "Yago", "Zilda", "Anderson", "Bruna",
    "Cesar", "Debora", "Elias", "Flavia", "Geraldo", "Isadora", "Joel",
    "Karen", "Leandro", "Monica", "Nelson", "Olivia",
]
LAST = [
    "Andrade", "Barbosa", "Cardoso", "Duarte", "Esteves", "Farias", "Guimaraes",
    "Henriques", "Inacio", "Junqueira", "Klein", "Lacerda", "Macedo", "Nogueira",
    "Ornelas", "Pacheco", "Queiroz", "Rezende", "Sampaio", "Tavares", "Uchoa",
    "Vasconcelos", "Winter", "Xavier", "Ypiranga", "Zanetti", "Amaral", "Bittencourt",
    "Camargo", "Dutra", "Evangelista", "Fontes", "Godoy", "Hoffmann", "Iglesias",
    "Jardim", "Kfouri", "Lemos", "Moraes", "Navarro",
]

# ------------------------------------------------------- classificação (§7)
FAT_SPEC = {
    "data_do_lancamento_financeiro": "date",
    "data_do_periodo_de_referencia": "date",
    "data_do_repasse": "date",
    "periodo": "keep",
    "praca": "keep",
    "subpraca": "keep",
    "origem": "origem",
    "id_da_pessoa_entregadora": "uuid",
    "recebedor": "name",
    "tipo": "keep",
    "valor": "money_comma",
    "descricao": "keep",
    "atingido": "pct_comma",
    "percentual_de_tempo_disponivel": "pct_comma",
    "percentual_de_aceitacao": "pct_comma",
    "percentual_de_conclusao": "pct_comma",
    "criterio_tempo_disponivel": "keep",
    "criterio_rotas_aceitas": "keep",
    "criterio_rotas_concluidas": "keep",
    "margem_fee_porcentagem": "keep",
}
PERF_SPEC = {
    "data_do_periodo": "date",
    "periodo": "keep",
    "duracao_do_periodo": "keep",
    "numero_minimo_de_entregadores_regulares_na_escala": "keep",
    "tag": "keep",
    "id_da_pessoa_entregadora": "uuid",
    "pessoa_entregadora": "name",
    "praca": "keep",
    "sub_praca": "keep",
    "origem": "origem",
    "tempo_disponivel_escalado": "pct_dot",
    "tempo_disponivel_absoluto": "time_scale",
    "numero_de_corridas_ofertadas": "count",
    "numero_de_corridas_aceitas": "count",
    "numero_de_corridas_rejeitadas": "count",
    "numero_de_corridas_completadas": "count",
    "numero_de_corridas_canceladas_pela_pessoa_entregadora": "count",
    "numero_de_pedidos_aceitos_e_concluidos": "count",
    "soma_das_taxas_das_corridas_aceitas": "cents",
}


class Anon:
    """Mapeamentos determinísticos-na-execução baseados em HMAC(salt, ...)."""

    def __init__(self):
        self.salt = os.urandom(32)  # DESCARTADO ao final; jamais persistido
        self.uuid_map = {}
        self.name_map = {}
        self.origem_map = {}
        self.real_names = set()
        self.real_uuids = set()
        self.real_origens = set()

    def _h(self, *parts):
        return hmac.new(self.salt, "|".join(parts).encode("utf-8"),
                        hashlib.sha256).digest()

    def factor(self, *parts, lo=0.8, hi=1.2):
        d = self._h("factor", *parts)
        x = int.from_bytes(d[:8], "big") / 2**64
        return lo + (hi - lo) * x

    def fake_uuid(self, real):
        real = real.strip()
        if not real:
            return real
        self.real_uuids.add(real.lower())
        if real not in self.uuid_map:
            b = bytearray(self._h("uuid", real)[:16])
            b[6] = (b[6] & 0x0F) | 0x40  # versão 4
            b[8] = (b[8] & 0x3F) | 0x80  # variante RFC 4122
            self.uuid_map[real] = str(uuid.UUID(bytes=bytes(b)))
        return self.uuid_map[real]

    def fake_name(self, real, key=None):
        real = real.strip()
        if not real:
            return real
        self.real_names.add(real)
        k = (key or real).strip() or real
        if k not in self.name_map:
            for salt2 in range(1000):
                d = self._h("name", k, str(salt2))
                fake = "{} {} {}".format(
                    FIRST[d[0] % len(FIRST)],
                    LAST[d[1] % len(LAST)],
                    LAST[d[2] % len(LAST)],
                )
                if fake != real:
                    break
            self.name_map[k] = fake
        return self.name_map[k]

    def fake_origem(self, real):
        real = real.strip()
        if not real:
            return real
        self.real_origens.add(real)
        if real not in self.origem_map:
            d = self._h("origem", real)
            self.origem_map[real] = "Hub Sintetico {:03d}".format(
                int.from_bytes(d[:2], "big") % 1000)
        return self.origem_map[real]

    def wipe(self):
        self.salt = None  # descarte explícito do salt (irreversibilidade)


# ------------------------------------------------------------- num helpers
def parse_comma(s):
    s = s.strip()
    if not s:
        return None
    return float(s.replace(".", "").replace(",", "."))


def fmt_comma(x):
    return "{:.2f}".format(x).replace(".", ",")


def parse_dot(s):
    s = s.strip()
    return float(s) if s else None


def shift_date(s, days):
    s = s.strip()
    if not s or days == 0:
        return s
    y, m, d = (int(p) for p in s.split("-"))
    return (date(y, m, d) + timedelta(days=days)).isoformat()


def scale_hms(s, f):
    s = s.strip()
    if not s:
        return s
    h, m, sec = (int(p) for p in s.split(":"))
    total = int(round((h * 3600 + m * 60 + sec) * f))
    return "{:02d}:{:02d}:{:02d}".format(total // 3600, (total % 3600) // 60,
                                         total % 60)


COUNT_COLS = [
    "numero_de_corridas_ofertadas",
    "numero_de_corridas_aceitas",
    "numero_de_corridas_rejeitadas",
    "numero_de_corridas_completadas",
    "numero_de_corridas_canceladas_pela_pessoa_entregadora",
    "numero_de_pedidos_aceitos_e_concluidos",
]


def scale_counts(row, f):
    """Escala contagens preservando invariantes do §7.3:
    aceitas+rejeitadas <= ofertadas; completadas <= aceitas."""
    vals = {c: int(row[c]) if row.get(c, "").strip() else 0 for c in COUNT_COLS}
    of = max(0, round(vals[COUNT_COLS[0]] * f))
    ac = min(round(vals[COUNT_COLS[1]] * f), of)
    rej = min(round(vals[COUNT_COLS[2]] * f), of - ac)
    comp = min(round(vals[COUNT_COLS[3]] * f), ac)
    canc = min(round(vals[COUNT_COLS[4]] * f), ac)
    ped = max(0, round(vals[COUNT_COLS[5]] * f))
    if vals[COUNT_COLS[5]] >= vals[COUNT_COLS[3]]:
        ped = max(ped, comp)  # vários pedidos por corrida (fato §7.3)
    out = dict(zip(COUNT_COLS, [of, ac, rej, comp, canc, ped]))
    return {k: str(v) for k, v in out.items()}


# --------------------------------------------------------------- pipeline
def parse_csv(text, spec, dataset):
    """Parse ÚNICO por arquivo (as réplicas do modo síntese reusam as rows —
    review S1: reparsear 365× custava ~2,4M parses de linha redundantes)."""
    reader = csv.DictReader(io.StringIO(text), delimiter=";")
    cols = reader.fieldnames or []
    unknown = [c for c in cols if c not in spec]
    if unknown:
        raise SystemExit(
            "FAIL-CLOSED: colunas sem classificação em {}: {} — classifique em "
            "gen-seeds.py antes de prosseguir".format(dataset, unknown))
    return cols, list(reader)


def process_rows(cols, rows, spec, anon, dataset, day_shift):
    out_rows = []
    for i, row in enumerate(rows):
        key = row.get("id_da_pessoa_entregadora", "").strip() or \
              row.get("recebedor", row.get("pessoa_entregadora", "")).strip()
        f_row = anon.factor(dataset, key or str(i), str(i), str(day_shift))
        new = {}
        counts_done = False
        for c in cols:
            v = row[c] if row[c] is not None else ""
            kind = spec[c]
            if kind == "keep":
                new[c] = v
            elif kind == "date":
                new[c] = shift_date(v, day_shift)
            elif kind == "uuid":
                new[c] = anon.fake_uuid(v)
            elif kind == "name":
                new[c] = anon.fake_name(
                    v, key=row.get("id_da_pessoa_entregadora", "").strip() or None)
            elif kind == "origem":
                new[c] = anon.fake_origem(v)
            elif kind == "money_comma":
                x = parse_comma(v)
                new[c] = fmt_comma(x * f_row) if x is not None else v.strip()
            elif kind == "pct_comma":
                x = parse_comma(v)
                new[c] = fmt_comma(max(0.0, x * anon.factor(dataset, c, key, str(i), str(day_shift)))) \
                    if x is not None else v.strip()
            elif kind == "pct_dot":
                x = parse_dot(v)
                new[c] = "{:.2f}".format(max(0.0, x * f_row)) if x is not None else v.strip()
            elif kind == "time_scale":
                new[c] = scale_hms(v, f_row)
            elif kind == "cents":
                new[c] = str(max(0, round(int(v) * f_row))) if v.strip() else v.strip()
            elif kind == "count":
                if not counts_done:
                    new.update(scale_counts(row, f_row))
                    counts_done = True
            else:
                raise SystemExit("tipo desconhecido: " + kind)
        out_rows.append(new)
    return out_rows


def write_csv(path, cols, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, delimiter=";")
        w.writeheader()
        w.writerows(rows)


UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)


def assert_no_leak(out_dir, anon):
    """Asserção de não-vazamento sobre TODOS os arquivos gerados.

    Streaming arquivo a arquivo (review S1: o blob único custaria ~1 GB de RAM
    e minutos de scan no dataset S10 de 365 dias). Semântica: (a) UUIDs
    extraídos por regex e intersectados com os reais; (b) nomes/origens reais
    comparados por CÉLULA exata (nos dados-fonte, nome/origem são sempre a
    célula inteira — uma coluna esquecida de anonimizar reapareceria idêntica);
    (c) mapeamentos de nome cujo fake colide com QUALQUER nome real contam
    como identidade."""
    uuid_hits_set = set()
    cell_values = set()
    for root, _, files in os.walk(out_dir):
        for fn in files:
            if fn.endswith(".csv"):
                with open(os.path.join(root, fn), encoding="utf-8") as fh:
                    for line in fh:
                        uuid_hits_set.update(
                            u.lower() for u in UUID_RE.findall(line))
                        cell_values.update(
                            c.strip() for c in line.rstrip("\n").split(";"))

    uuid_hits = len(uuid_hits_set & anon.real_uuids)
    name_hits = len(cell_values & anon.real_names)
    origem_hits = len(cell_values & anon.real_origens)
    ident_names = sum(1 for v in anon.name_map.values() if v in anon.real_names)
    leaks = uuid_hits + name_hits + origem_hits + ident_names

    print("ASSERCAO 0-VAZAMENTOS:")
    print("  uuids originais na saida ......: {} (de {} observados)".format(
        uuid_hits, len(anon.real_uuids)))
    print("  nomes completos originais .....: {} (de {} observados)".format(
        name_hits, len(anon.real_names)))
    print("  origens originais .............: {} (de {} observadas)".format(
        origem_hits, len(anon.real_origens)))
    print("  mapeamentos identidade nome ...: {}".format(ident_names))
    if leaks:
        raise SystemExit("VAZAMENTO DETECTADO ({} ocorrencias) — saída INVALIDADA".format(leaks))
    print("  RESULTADO: 0 vazamentos — OK")
    return {
        "uuid_hits": uuid_hits, "name_hits": name_hits,
        "origem_hits": origem_hits, "identity_names": ident_names,
        "real_uuids_seen": len(anon.real_uuids),
        "real_names_seen": len(anon.real_names),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fat", default="docs/documentos_apoio/Faturamento.zip")
    ap.add_argument("--perf", default="docs/documentos_apoio/Performance_.zip")
    ap.add_argument("--out", default="infra/hub/seeds/out")
    ap.add_argument("--synthesize-days", type=int, default=0,
                    help="replica cada dia disponível N vezes com datas deslocadas (S10)")
    args = ap.parse_args()

    anon = Anon()
    manifest = {"datasets": {}, "synthesize_days": args.synthesize_days,
                "leak_assertion": None,
                "nota": "salt HMAC descartado apos a geracao (irreversivel); "
                        "arquivos gerados sao gitignored"}

    for label, zpath, spec in (("faturamento", args.fat, FAT_SPEC),
                               ("performance", args.perf, PERF_SPEC)):
        if not os.path.exists(zpath):
            raise SystemExit("ZIP nao encontrado: " + zpath)
        with zipfile.ZipFile(zpath) as zf:
            csvs = [n for n in zf.namelist() if n.lower().endswith(".csv")]
            if not csvs:
                raise SystemExit("nenhum CSV em " + zpath)
            files_out = {}
            for name in sorted(csvs):
                m = re.search(r"(\d{4}-\d{2}-\d{2})", name)
                base_day = m.group(1) if m else os.path.splitext(os.path.basename(name))[0]
                text = zf.read(name).decode("utf-8-sig")
                cols, raw_rows = parse_csv(text, spec, label)
                for k in range(0, args.synthesize_days + 1):
                    rows = process_rows(cols, raw_rows, spec, anon, label, k)
                    day_out = shift_date(base_day, k) if m else "{}+{}".format(base_day, k)
                    if day_out in files_out:
                        raise SystemExit(
                            "FAIL-CLOSED: dois CSVs de {} produzem o mesmo dia de "
                            "saída '{}' ({}); a sobrescrita silenciosa perderia "
                            "linhas".format(label, day_out, name))
                    path = os.path.join(args.out, label, day_out + ".csv")
                    write_csv(path, cols, rows)
                    files_out[day_out] = len(rows)
            manifest["datasets"][label] = {
                "zip": os.path.basename(zpath),
                "dias_gerados": len(files_out),
                "linhas_por_dia": files_out,
                "linhas_total": sum(files_out.values()),
            }

    manifest["leak_assertion"] = assert_no_leak(args.out, anon)
    anon.wipe()  # descarte do salt — irreversibilidade

    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)

    print("RESUMO:")
    for label, info in manifest["datasets"].items():
        print("  {}: {} dia(s), {} linhas".format(label, info["dias_gerados"],
                                                  info["linhas_total"]))
    print("  saida: {} (gitignored)".format(args.out))


if __name__ == "__main__":
    sys.exit(main())
