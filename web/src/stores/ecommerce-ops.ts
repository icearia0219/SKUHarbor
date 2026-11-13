import { create } from 'zustand';
import { api } from '../api/client';

export type EcomRecord = Record<string, unknown>;
export interface EcomProduct extends EcomRecord {
  id: string;
  sku: string;
  market: string;
  locale: string;
  revision: number;
  facts: EcomRecord[];
}
export interface EcomArtifact extends EcomRecord {
  id: string;
  task_id: string;
  revision: number;
  content_hash: string;
  stale: boolean;
  result: EcomRecord;
  quality: EcomRecord[];
  review: (EcomRecord & { valid?: boolean; decision?: string }) | null;
}
export interface EcomWorkspace {
  products: EcomProduct[];
  assets: EcomRecord[];
  knowledge: EcomRecord[];
  tasks: EcomRecord[];
  artifacts: EcomArtifact[];
  reports: EcomRecord[];
}
export const asRecord = (value: unknown): EcomRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as EcomRecord)
    : {};
export const asRecords = (value: unknown): EcomRecord[] =>
  Array.isArray(value) ? value.map(asRecord) : [];
export const textValue = (value: unknown): string =>
  value == null
    ? '未知'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);
export const errorMessage = (error: unknown): string => {
  const record = asRecord(error);
  return textValue(
    record.message ??
      record.error ??
      (error instanceof Error ? error.message : '请求失败，请重试'),
  );
};
let availabilityEpoch = 0;
let dataEpoch = 0;
let activeOwner: string | undefined;
let availabilityPending: Promise<void> | null = null;
export const useEcommerceAvailability = create<{
  enabled: boolean;
  checked: boolean;
  loading: boolean;
  load: (owner?: string) => Promise<void>;
}>((set) => ({
  enabled: false,
  checked: false,
  loading: false,
  load: async (owner) => {
    if (owner !== undefined && owner !== activeOwner) {
      activeOwner = owner;
      availabilityEpoch++;
      availabilityPending = null;
      useEcommerceOpsStore.getState().clear();
      set({ enabled: false, checked: false });
    }
    if (availabilityPending) return availabilityPending;
    const epoch = ++availabilityEpoch;
    set({ loading: true });
    const pending = (async () => {
      try {
        const result = await api.get<{ enabled: boolean }>(
          '/api/ecommerce-ops/availability',
        );
        if (epoch === availabilityEpoch) {
          set({
            enabled: result.enabled === true,
            checked: true,
            loading: false,
          });
          if (!result.enabled) useEcommerceOpsStore.getState().clear();
        }
      } catch {
        if (epoch === availabilityEpoch) {
          set({ enabled: false, checked: true, loading: false });
          useEcommerceOpsStore.getState().clear();
        }
      } finally {
        if (epoch === availabilityEpoch) availabilityPending = null;
      }
    })();
    availabilityPending = pending;
    return pending;
  },
}));
export const workspaceQuery = (workspaceId: string) =>
  `workspace_id=${encodeURIComponent(workspaceId)}`;
export async function ecomRequest<T>(
  workspaceId: string,
  path: string,
  body?: EcomRecord,
  method: 'post' | 'patch' = 'post',
): Promise<T> {
  if (!useEcommerceAvailability.getState().enabled || !workspaceId)
    throw new Error('请先开启电商运营并选择工作区');
  return api[method]<T>(`/api/ecommerce-ops${path}`, {
    ...body,
    workspace_id: workspaceId,
  });
}
export async function ecomRead<T>(
  workspaceId: string,
  path: string,
): Promise<T> {
  if (!useEcommerceAvailability.getState().enabled || !workspaceId)
    throw new Error('电商运营不可用');
  return api.get<T>(
    `/api/ecommerce-ops${path}${path.includes('?') ? '&' : '?'}${workspaceQuery(workspaceId)}`,
  );
}
export const useEcommerceOpsStore = create<{
  workspaceId: string;
  data: EcomWorkspace | null;
  loading: boolean;
  error: string | null;
  load: (workspaceId: string) => Promise<void>;
  clear: () => void;
}>((set, get) => ({
  workspaceId: '',
  data: null,
  loading: false,
  error: null,
  clear: () => {
    dataEpoch++;
    set({ workspaceId: '', data: null, loading: false, error: null });
  },
  load: async (workspaceId) => {
    const epoch = ++dataEpoch;
    set({
      workspaceId,
      loading: true,
      error: null,
      ...(workspaceId !== get().workspaceId ? { data: null } : {}),
    });
    try {
      const data = await ecomRead<EcomWorkspace>(workspaceId, '/workspace');
      if (epoch === dataEpoch) set({ data, loading: false });
    } catch (error) {
      if (epoch === dataEpoch)
        set({ data: null, loading: false, error: errorMessage(error) });
    }
  },
}));
