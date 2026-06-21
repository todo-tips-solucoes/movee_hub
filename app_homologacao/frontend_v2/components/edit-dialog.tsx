'use client';

import { useState, useEffect, useRef } from 'react';
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { EnvioMassa } from '@/types';
import { toast } from 'sonner';

// Retorna apenas os dígitos de uma string (FR-014 / contrato §Convenções de Borda)
const onlyDigits = (v: string) => v.replace(/\D/g, '');

// Aplica máscara visual XX.XXX.XXX/XXXX-XX sem alterar o valor interno (dígitos)
function maskCNPJ(digits: string): string {
  const d = digits.slice(0, 14);
  if (d.length <= 2) return d;
  if (d.length <= 5) return `${d.slice(0, 2)}.${d.slice(2)}`;
  if (d.length <= 8) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
  if (d.length <= 12) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8)}`;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

interface EditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record: EnvioMassa | null;
  onSave: (id: number, data: Record<string, unknown>) => Promise<void>;
}

export function EditDialog({ open, onOpenChange, record, onSave }: EditDialogProps) {
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // cnpjPrestador armazena apenas dígitos; exibição usa maskCNPJ (FR-014)
  const [cnpjPrestador, setCnpjPrestador] = useState('');
  const [form, setForm] = useState({
    number: '',
    nome: '',
    valor: '',
    cnpj_tomador: '',
    mensagem1: '',
    mensagem2: '',
  });

  useEffect(() => {
    if (record) {
      setForm({
        number: record.number || '',
        nome: record.nome || '',
        valor: String(record.valor || ''),
        cnpj_tomador: record.cnpj_tomador || '',
        mensagem1: record.mensagem1 || '',
        mensagem2: record.mensagem2 || '',
      });
      setCnpjPrestador(onlyDigits(record.cnpj_prestador || ''));
    }
  }, [record]);

  // Reseta a confirmação visual ao (re)abrir; ao fechar (inclui ESC/backdrop),
  // cancela um eventual timer de fechamento pendente p/ não fechar um diálogo
  // reaberto. Limpa também no unmount.
  useEffect(() => {
    if (open) {
      setSaved(false);
    } else if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, [open]);

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  // CNPJ válido = 14 dígitos exatos (FR-008)
  const cnpjValido = cnpjPrestador.length === 14;

  const handleSave = async () => {
    if (!record) return;
    // Payload inclui cnpj_prestador somente com dígitos (FR-014, contrato §Convenções de Borda)
    const payload: Record<string, unknown> = { ...form, cnpj_prestador: cnpjPrestador };
    try {
      setLoading(true);
      await onSave(record.id, payload);
      toast.success('Registro atualizado com sucesso!');
      // Confirmação visual breve antes de fechar (U011)
      setSaved(true);
      closeTimer.current = setTimeout(() => onOpenChange(false), 900);
    } catch (err) {
      // Tratar erros específicos do backend (4.2 — FR-008/FR-014)
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('409') || msg.toLowerCase().includes('já cadastrado') || msg.toLowerCase().includes('conflict')) {
        toast.error('CNPJ já cadastrado para outro motorista. Verifique e tente novamente.');
      } else if (msg.includes('400') || msg.toLowerCase().includes('inválido') || msg.toLowerCase().includes('invalid')) {
        toast.error('CNPJ inválido. Verifique e tente novamente.');
      } else {
        toast.error(err instanceof Error ? err.message : 'Erro ao atualizar registro');
      }
    } finally {
      setLoading(false);
    }
  };

  // cnpj_prestador é tratado em bloco dedicado (máscara + aviso + validação)
  const fields = [
    { key: 'number', label: 'Numero' },
    { key: 'nome', label: 'Nome' },
    { key: 'valor', label: 'Valor' },
    { key: 'cnpj_tomador', label: 'CNPJ Tomador' },
    { key: 'mensagem1', label: 'Mensagem 1' },
    { key: 'mensagem2', label: 'Mensagem 2' },
  ] as const;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* R003: largura mobile explícita (sem scroll horizontal); scroll interno já no body */}
      <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-md">
        <AnimatePresence>
          {saved && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-[inherit] bg-card/95 backdrop-blur-sm"
              role="status"
              aria-live="polite"
            >
              <motion.div
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 18 }}
              >
                <CheckCircle2 className="h-12 w-12 text-success" aria-hidden="true" />
              </motion.div>
              <p className="text-sm font-medium">Registro atualizado</p>
            </motion.div>
          )}
        </AnimatePresence>
        <DialogHeader>
          <DialogTitle>
            {record?.nome ? `Editar “${record.nome}”` : 'Editar registro'}
          </DialogTitle>
          <DialogDescription>
            {record?.number
              ? `Atualize os dados do registro nº ${record.number}.`
              : 'Atualize os dados do registro selecionado.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-4 max-h-[60vh] overflow-y-auto pr-1">
          {fields.map(({ key, label }) => (
            <div key={key} className="grid gap-1.5">
              <Label htmlFor={key} className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</Label>
              <Input
                id={key}
                value={form[key]}
                onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                className="h-11 sm:h-9 md:h-8"
              />
            </div>
          ))}

          {/* Bloco dedicado CNPJ Prestador — máscara, aviso de impacto e validação (FR-008, FR-014, US4) */}
          <div className="grid gap-1.5">
            <Label
              htmlFor="cnpj_prestador"
              className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              CNPJ Prestador
            </Label>
            <Input
              id="cnpj_prestador"
              inputMode="numeric"
              autoComplete="off"
              value={maskCNPJ(cnpjPrestador)}
              aria-label="CNPJ do Prestador (14 dígitos)"
              aria-invalid={cnpjPrestador.length > 0 && !cnpjValido}
              aria-describedby="cnpj-prestador-aviso cnpj-prestador-erro"
              className="h-11 sm:h-9 md:h-8"
              onChange={(e) => {
                // Aceitar apenas dígitos, limitar a 14 (FR-008, CHK035)
                setCnpjPrestador(onlyDigits(e.target.value).slice(0, 14));
              }}
            />
            {/* Erro inline de validação — aparece quando digitou mas incompleto */}
            {cnpjPrestador.length > 0 && !cnpjValido && (
              <p id="cnpj-prestador-erro" className="text-xs text-destructive">
                CNPJ deve conter 14 dígitos ({cnpjPrestador.length}/14)
              </p>
            )}
            {/* Aviso fixo e não-dismissível de impacto no app motorista (FR-004, CHK038) */}
            <div
              id="cnpj-prestador-aviso"
              role="note"
              className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>Alterar o CNPJ atualizará o cadastro de login do motorista no app.</span>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading || saved}>
            Cancelar
          </Button>
          {/* Salvar desabilitado se CNPJ incompleto ou durante loading/saved (CHK043) */}
          <Button onClick={handleSave} disabled={loading || saved || !cnpjValido}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
