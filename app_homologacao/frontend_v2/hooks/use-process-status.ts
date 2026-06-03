'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { api } from '@/lib/api-client';
import { ProcessStatus } from '@/types';

interface UseProcessStatusOptions {
  onRefresh: () => void;
}

export function useProcessStatus({ onRefresh }: UseProcessStatusOptions) {
  const [isActive, setIsActive] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const clearPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const checkStatus = useCallback(async () => {
    try {
      const result = await api.get<ProcessStatus>('/process-status');
      setIsActive(result.active);
      if (result.active) {
        onRefresh();
      }
      return result.active;
    } catch {
      setIsActive(false);
      return false;
    }
  }, [onRefresh]);

  const startPolling = useCallback(() => {
    clearPolling();
    intervalRef.current = setInterval(() => {
      checkStatus();
    }, 13000);
  }, [checkStatus, clearPolling]);

  const startProcess = useCallback(async () => {
    try {
      setIsLoading(true);
      await api.post('/start-process');
      setIsActive(true);
      startPolling();
    } finally {
      setIsLoading(false);
    }
  }, [startPolling]);

  const stopProcess = useCallback(async () => {
    try {
      setIsLoading(true);
      await api.post('/stop-process');
      setIsActive(false);
      clearPolling();
      onRefresh();
    } finally {
      setIsLoading(false);
    }
  }, [clearPolling, onRefresh]);

  useEffect(() => {
    checkStatus().then((active) => {
      if (active) startPolling();
    });
    return clearPolling;
  }, [checkStatus, startPolling, clearPolling]);

  return {
    isActive,
    isLoading,
    startProcess,
    stopProcess,
  };
}
