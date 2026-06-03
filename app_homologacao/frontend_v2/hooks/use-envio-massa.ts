'use client';

import { useState, useCallback, useMemo } from 'react';
import { EnvioMassa, FilterState, StatsData } from '@/types';
import { api } from '@/lib/api-client';
import { applyFilters, computeStats, initialFilters } from '@/lib/utils';

export function useEnvioMassa() {
  const [data, setData] = useState<EnvioMassa[]>([]);
  const [filters, setFilters] = useState<FilterState>(initialFilters);
  const [currentPage, setCurrentPage] = useState(1);
  const [recordsPerPage, setRecordsPerPage] = useState<number | 'all'>(100);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const result = await api.get<EnvioMassa[]>('/envio-massa');
      setData(Array.isArray(result) ? result : []);
    } catch {
      setData([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const filteredData = useMemo(() => applyFilters(data, filters), [data, filters]);

  const stats: StatsData = useMemo(() => computeStats(data), [data]);

  const totalPages = useMemo(() => {
    if (recordsPerPage === 'all') return 1;
    return Math.max(1, Math.ceil(filteredData.length / recordsPerPage));
  }, [filteredData.length, recordsPerPage]);

  const paginatedData = useMemo(() => {
    if (recordsPerPage === 'all') return filteredData;
    const start = (currentPage - 1) * recordsPerPage;
    return filteredData.slice(start, start + recordsPerPage);
  }, [filteredData, currentPage, recordsPerPage]);

  const updateFilters = useCallback((partial: Partial<FilterState>) => {
    setFilters((prev) => ({ ...prev, ...partial }));
    setCurrentPage(1);
  }, []);

  const resetFilters = useCallback(() => {
    setFilters(initialFilters);
    setCurrentPage(1);
  }, []);

  const changeRecordsPerPage = useCallback((value: number | 'all') => {
    setRecordsPerPage(value);
    setCurrentPage(1);
  }, []);

  const deleteRecord = useCallback(async (id: number) => {
    await api.del(`/envio-massa/${id}`);
    await fetchData();
  }, [fetchData]);

  const updateRecord = useCallback(async (id: number, body: Record<string, unknown>) => {
    await api.patch(`/update-envio-massa/${id}`, body);
    await fetchData();
  }, [fetchData]);

  const uploadFile = useCallback(async (file: File) => {
    const result = await api.uploadFile('/upload', file);
    await fetchData();
    return result;
  }, [fetchData]);

  const exportCSV = useCallback(() => {
    const fields = ['id', 'number', 'nome', 'valor', 'enviado', 'retorno_envio_msg_1', 'numnota', 'nota_ok', 'data_emissao', 'erro_validacao'];
    const header = fields.map(f => `"${f}"`).join(',');
    const rows = filteredData.map(row =>
      fields.map(f => {
        const val = row[f as keyof EnvioMassa];
        return val != null ? `"${String(val).replace(/"/g, '""')}"` : '""';
      }).join(',')
    );
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'envio_massa.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  }, [filteredData]);

  const downloadXML = useCallback(async () => {
    await api.downloadBlob('/download-xml-movimento', 'xml_movimento_aberto.zip');
  }, []);

  const closeMovement = useCallback(async () => {
    await api.post('/close-movimento');
    await fetchData();
  }, [fetchData]);

  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === paginatedData.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(paginatedData.map((d) => d.id)));
    }
  }, [paginatedData, selectedIds.size]);

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return {
    data,
    filteredData,
    paginatedData,
    stats,
    filters,
    loading,
    currentPage,
    recordsPerPage,
    totalPages,
    selectedIds,
    fetchData,
    updateFilters,
    resetFilters,
    setCurrentPage,
    changeRecordsPerPage,
    deleteRecord,
    updateRecord,
    uploadFile,
    exportCSV,
    downloadXML,
    closeMovement,
    toggleSelectAll,
    toggleSelect,
  };
}
