'use client';

import { useState, useCallback } from 'react';
import { api } from '@/lib/api-client';

export interface ValidationRow {
  cnpj_prestador: string;
  data_emissao: string;
  razao_social: string;
  valor_nota: string;
  filename: string;
  valid: boolean;
  valid_cnpj_prestador: boolean;
  valid_cnpj: boolean;
  valid_descricao_servico: boolean;
  valid_valor: boolean;
  valid_trib_nac: boolean;
  valid_dCompet: boolean;
}

export interface ValidationStats {
  total: number;
  success: number;
  errors: number;
}

export interface ValidationResponse {
  stats: ValidationStats;
  results: ValidationRow[];
}

export function useXmlValidation() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ValidationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const validateBatch = useCallback(async (files: File[], validarDescricao: boolean) => {
    setLoading(true);
    setData(null);
    setError(null);
    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append('xmlFiles', file);
      }
      formData.append('validar_descricao_servico', String(validarDescricao));

      const res = await fetch('/api/validate-xml-batch', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      if (!res.ok) {
        throw new Error(`Erro na validacao (status ${res.status})`);
      }

      const json: ValidationResponse = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao validar XMLs');
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const downloadCSV = useCallback(() => {
    if (!data) return;
    const fields = [
      'cnpj_prestador', 'data_emissao', 'razao_social', 'valor_nota', 'filename',
      'valid', 'valid_cnpj_prestador', 'valid_cnpj', 'valid_descricao_servico',
      'valid_valor', 'valid_trib_nac', 'valid_dCompet'
    ];
    const header = fields.map(f => `"${f}"`).join(',');
    const rows = data.results.map(row =>
      fields.map(f => {
        const val = row[f as keyof ValidationRow];
        return typeof val === 'string' ? `"${val.replace(/"/g, '""')}"` : String(val);
      }).join(',')
    );
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'validacao_nfse.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  }, [data]);

  const reset = useCallback(() => {
    setData(null);
    setError(null);
  }, []);

  return { loading, data, error, validateBatch, downloadCSV, reset };
}
