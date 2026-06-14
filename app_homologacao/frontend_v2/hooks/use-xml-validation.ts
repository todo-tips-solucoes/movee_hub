'use client';

import { useState, useCallback } from 'react';

// Enum de status terminal por XML (snake_case — paridade com backend)
export type ValidationStatus =
  | 'ja_validada'
  | 'validada'
  | 'revalidada'
  | 'duplicada_no_lote'
  | 'sem_movimento'
  | 'erro';

// Critério usado para casar o XML com o movimento
export type MatchCriterio = 'chave' | 'fallback' | 'none';

// Uma linha da resposta — substitui as flags booleanas antigas
export interface ValidationRow {
  arquivo: string;
  status: ValidationStatus;
  match_criterio: MatchCriterio;
  movimento_id: number | null;
  cnpj_prestador: string | null;
  numnota: string | null;
  erro_validacao: string | null;
}

// 7 contadores snake_case (paridade com backend)
export interface BatchStats {
  total: number;
  ja_validada: number;
  validada: number;
  revalidada: number;
  duplicada_no_lote: number;
  sem_movimento: number;
  erro: number;
}

export interface ValidationResponse {
  stats: BatchStats;
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
        let msg = `Erro na validacao (status ${res.status})`;
        try {
          const body = await res.json();
          // 4xx com detail = erro de negócio (propagar real); 5xx = infra
          if (res.status < 500 && body?.detail) {
            msg = body.detail;
          } else {
            msg = 'Servico de validacao indisponivel. Tente novamente mais tarde.';
          }
        } catch {
          if (res.status >= 500) {
            msg = 'Servico de validacao indisponivel. Tente novamente mais tarde.';
          }
        }
        throw new Error(msg);
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
    const fields: (keyof ValidationRow)[] = [
      'arquivo', 'status', 'match_criterio', 'movimento_id',
      'cnpj_prestador', 'numnota', 'erro_validacao',
    ];
    const header = fields.map(f => `"${f}"`).join(',');
    const rows = data.results.map(row =>
      fields.map(f => {
        const val = row[f];
        if (val === null || val === undefined) return '""';
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
