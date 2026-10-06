'use client';

// Lançamento de conta bancária pelo operador (2026-10-05).
//
// Desde esta data o app do motorista só aceita conta CNPJ do PRÓPRIO titular, e
// nunca poupança. Quem precisa de conta PESSOA FÍSICA pede ao operador — este
// diálogo é a única porta para isso.
//
// Por que a busca de motorista vive aqui e não reusa a tela de Motoristas: quem
// lança conta tem `adiantamentos.contas_revisar`, e não necessariamente
// `motoristas.listar`, que é de outro módulo. O endpoint
// `GET /adiantamentos/contas/entregadores` existe por isso.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { buscarEntregadores, lancarConta, type EntregadorBusca } from '@/lib/hub/adiantamentos-api';

/** Dígitos puros, como o backend grava. */
function soDigitos(v: string): string {
  return v.replace(/\D/g, '');
}

/** Máscara de CPF (11) ou CNPJ (14) conforme a pessoa digita. */
export function mascararDocumento(valor: string): string {
  const d = soDigitos(valor).slice(0, 14);
  if (d.length <= 11) {
    return d
      .replace(/^(\d{3})(\d)/, '$1.$2')
      .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
  }
  return d
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
}

const CAMPO_ROTULO: Record<string, string> = {
  entregadorId: 'motorista',
  titularNome: 'nome do titular',
  titularDocumento: 'CPF/CNPJ do titular',
  bancoCodigo: 'código do banco',
  agencia: 'agência',
  conta: 'conta',
  contaDigito: 'dígito da conta',
  tipoConta: 'tipo de conta',
};

interface Props {
  aberto: boolean;
  onFechar: () => void;
  /** Chamado após lançar com sucesso, para a lista recarregar. */
  onLancada: () => void;
}

export function LancarContaDialog({ aberto, onFechar, onLancada }: Props) {
  const [busca, setBusca] = useState('');
  const [resultados, setResultados] = useState<EntregadorBusca[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [escolhido, setEscolhido] = useState<EntregadorBusca | null>(null);

  const [titularNome, setTitularNome] = useState('');
  const [documento, setDocumento] = useState('');
  const [bancoCodigo, setBancoCodigo] = useState('');
  const [agencia, setAgencia] = useState('');
  const [conta, setConta] = useState('');
  const [contaDigito, setContaDigito] = useState('');
  const [enviando, setEnviando] = useState(false);

  const limpar = useCallback(() => {
    setBusca(''); setResultados([]); setEscolhido(null);
    setTitularNome(''); setDocumento(''); setBancoCodigo('');
    setAgencia(''); setConta(''); setContaDigito('');
  }, []);

  // Busca com espera: o piso de 3 caracteres também vive no backend, aqui é
  // para não disparar requisição a cada tecla.
  useEffect(() => {
    if (busca.trim().length < 3) { setResultados([]); return; }
    let cancelado = false;
    const t = setTimeout(async () => {
      setBuscando(true);
      try {
        const items = await buscarEntregadores(busca.trim());
        if (!cancelado) setResultados(items);
      } catch {
        if (!cancelado) setResultados([]);
      } finally {
        if (!cancelado) setBuscando(false);
      }
    }, 350);
    return () => { cancelado = true; clearTimeout(t); };
  }, [busca]);

  const digitos = soDigitos(documento);
  const documentoPlausivel = digitos.length === 11 || digitos.length === 14;
  const podeEnviar = Boolean(
    escolhido && titularNome.trim() && documentoPlausivel
    && /^\d{3}$/.test(bancoCodigo) && agencia.trim() && conta.trim() && contaDigito.trim()
  );

  const enviar = useCallback(async () => {
    if (!escolhido || !podeEnviar) return;
    setEnviando(true);
    try {
      const r = await lancarConta({
        entregadorId: escolhido.id,
        titularNome: titularNome.trim(),
        titularDocumento: digitos,
        bancoCodigo,
        agencia: soDigitos(agencia),
        conta: soDigitos(conta),
        contaDigito: contaDigito.trim(),
        tipoConta: 'CORRENTE',
      });
      toast.success(`Conta ${r.titularTipo} lançada e aprovada para ${escolhido.nome}.`);
      limpar();
      onLancada();
      onFechar();
    } catch (e) {
      // o backend recusa no PRIMEIRO campo inválido e devolve `motivo` com o
      // nome dele — mostrar o campo evita a caça que a mensagem genérica causa
      const motivo = (e as { motivo?: string })?.motivo;
      const mensagem = e instanceof Error ? e.message : 'Erro ao lançar a conta';
      toast.error(motivo ? `${mensagem} — confira: ${CAMPO_ROTULO[motivo] ?? motivo}` : mensagem);
    } finally {
      setEnviando(false);
    }
  }, [escolhido, podeEnviar, titularNome, digitos, bancoCodigo, agencia, conta, contaDigito, limpar, onLancada, onFechar]);

  return (
    <Dialog open={aberto} onOpenChange={(open) => { if (!open) { limpar(); onFechar(); } }}>
      <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Lançar conta bancária</DialogTitle>
          <DialogDescription>
            Use quando o motorista precisar de conta <strong>pessoa física</strong> — o
            app só aceita CNPJ do próprio titular. A conta entra já aprovada, no
            seu nome, e substitui a anterior. Poupança não é aceita.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          {/* 1. quem */}
          <div className="grid gap-2">
            <Label htmlFor="lancar-busca">Motorista</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="lancar-busca"
                className="h-11 pl-9 sm:h-9"
                placeholder="Buscar por nome ou CNPJ (3+ caracteres)"
                value={escolhido ? escolhido.nome : busca}
                onChange={(e) => { setEscolhido(null); setBusca(e.target.value); }}
              />
              {buscando && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin" />}
            </div>
            {!escolhido && resultados.length > 0 && (
              <ul className="max-h-40 overflow-y-auto rounded-md border border-border">
                {resultados.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-muted"
                      onClick={() => {
                        setEscolhido(r);
                        // o titular costuma ser a própria pessoa; pré-preencher
                        // poupa digitação e o operador corrige quando não for
                        setTitularNome((atual) => atual || r.nome);
                      }}
                    >
                      <span className="text-sm">{r.nome}</span>
                      <span className="text-xs text-muted-foreground">
                        {r.documentoMascarado ?? 'sem CNPJ no cadastro'}
                        {r.temContaAprovada ? ' · já tem conta aprovada' : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!escolhido && busca.trim().length >= 3 && !buscando && resultados.length === 0 && (
              <p className="text-sm text-muted-foreground">Nenhum motorista encontrado.</p>
            )}
          </div>

          {/* 2. titular */}
          <div className="grid gap-2">
            <Label htmlFor="lancar-titular">Nome do titular</Label>
            <Input id="lancar-titular" className="h-11 sm:h-9" value={titularNome}
                   onChange={(e) => setTitularNome(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="lancar-documento">CPF ou CNPJ do titular</Label>
            <Input id="lancar-documento" className="h-11 sm:h-9" inputMode="numeric"
                   value={mascararDocumento(documento)}
                   onChange={(e) => setDocumento(e.target.value)} />
            {digitos.length > 0 && !documentoPlausivel && (
              <p className="text-sm text-muted-foreground">CPF tem 11 dígitos; CNPJ, 14.</p>
            )}
          </div>

          {/* 3. banco */}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="lancar-banco">Banco (código)</Label>
              <Input id="lancar-banco" className="h-11 sm:h-9" inputMode="numeric" placeholder="260"
                     value={bancoCodigo} onChange={(e) => setBancoCodigo(soDigitos(e.target.value).slice(0, 3))} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="lancar-agencia">Agência</Label>
              <Input id="lancar-agencia" className="h-11 sm:h-9" inputMode="numeric"
                     value={agencia} onChange={(e) => setAgencia(soDigitos(e.target.value).slice(0, 4))} />
            </div>
          </div>
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <div className="grid gap-2">
              <Label htmlFor="lancar-conta">Conta</Label>
              <Input id="lancar-conta" className="h-11 sm:h-9" inputMode="numeric"
                     value={conta} onChange={(e) => setConta(soDigitos(e.target.value))} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="lancar-digito">Dígito</Label>
              <Input id="lancar-digito" className="h-11 sm:h-9" maxLength={1}
                     value={contaDigito} onChange={(e) => setContaDigito(e.target.value.slice(0, 1))} />
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Conta corrente. Poupança não é aceita — nem aqui, nem pelo app.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" className="min-h-11 sm:min-h-9" onClick={() => { limpar(); onFechar(); }} disabled={enviando}>
            Cancelar
          </Button>
          <Button className="min-h-11 sm:min-h-9" onClick={enviar} disabled={!podeEnviar || enviando}>
            {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Lançar conta'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
