import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { EnvioMassa, FilterState, StatsData } from "@/types"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBRL(valor: number | string): string {
  const num = typeof valor === 'string' ? parseFloat(valor) : valor;
  if (isNaN(num)) return 'R$ 0,00';
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function formatDateBR(dateStr: string | null): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';
  const formatted = date.toLocaleDateString('pt-BR');
  if (formatted === '31/12/1969') return '';
  return formatted;
}

export function computeStats(data: EnvioMassa[]): StatsData {
  let msgEnviada = 0;
  let msgErro = 0;
  let xmlEnviado = 0;
  let xmlErro = 0;

  for (const item of data) {
    if (item.enviado === 'ok') msgEnviada++;
    if (item.enviado === 'erro') msgErro++;
    if (item.numnota && item.nota_ok && item.data_emissao && !item.erro_validacao) {
      xmlEnviado++;
    }
    if (item.numnota && item.nota_ok && item.data_emissao && item.erro_validacao) {
      xmlErro++;
    }
  }

  return {
    total: data.length,
    msgEnviada,
    msgErro,
    xmlEnviado,
    xmlErro,
  };
}

export function applyFilters(data: EnvioMassa[], filters: FilterState): EnvioMassa[] {
  return data.filter((item) => {
    if (filters.numero && !item.number?.toLowerCase().includes(filters.numero.toLowerCase())) return false;
    if (filters.nome && !item.nome?.toLowerCase().includes(filters.nome.toLowerCase())) return false;
    if (filters.valor && !String(item.valor).includes(filters.valor)) return false;
    if (filters.numNota && !(item.numnota || '').toLowerCase().includes(filters.numNota.toLowerCase())) return false;

    if (filters.dataEmissao) {
      if (!item.data_emissao) return false;
      const itemDate = new Date(item.data_emissao);
      const filterDate = new Date(filters.dataEmissao + 'T00:00:00');
      if (isNaN(itemDate.getTime()) || isNaN(filterDate.getTime())) return false;
      if (itemDate.toDateString() !== filterDate.toDateString()) return false;
    }

    if (filters.enviado === 'yes' && item.enviado !== 'ok') return false;
    if (filters.enviado === 'no' && item.enviado === 'ok') return false;

    if (filters.sucesso === 'yes' && item.enviado !== 'erro') return false;
    if (filters.sucesso === 'no' && item.enviado === 'erro') return false;

    if (filters.validacao === 'yes' && !item.erro_validacao) return false;
    if (filters.validacao === 'no' && item.erro_validacao) return false;

    if (filters.enviouNota === 'yes' && !item.numnota) return false;
    if (filters.enviouNota === 'no' && item.numnota) return false;

    return true;
  });
}

export const initialFilters: FilterState = {
  numero: '',
  nome: '',
  valor: '',
  numNota: '',
  dataEmissao: '',
  enviado: 'all',
  sucesso: 'all',
  validacao: 'all',
  enviouNota: 'all',
};
