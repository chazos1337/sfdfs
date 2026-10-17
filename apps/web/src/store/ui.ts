import type { Stage } from '@mf/shared';
import { create } from 'zustand';

// Local UI state (what is open/selected). Kept apart from the server-fed
// `useFactory` store so the scene worker only has to care about one of them.

export type MainTab = 'factory' | 'vault';
export type SettingsTab = 'profile' | 'limits' | 'allowlist' | 'mcp' | 'upgrades' | 'audit';

interface UiState {
  tab: MainTab;
  selectedAgentId: number | null;
  building: Stage | 'breakroom' | null;
  crateId: number | null;
  opportunityId: number | null;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  highlightApprovalId: number | null;
  trayOpen: boolean;
  toasts: Array<{ id: number; text: string; level: 'bad' | 'good' | 'info' }>;

  setTab: (t: MainTab) => void;
  selectAgent: (id: number | null) => void;
  openBuilding: (b: Stage | 'breakroom' | null) => void;
  openCrate: (id: number | null) => void;
  openOpportunity: (id: number | null) => void;
  openSettings: (open: boolean, tab?: SettingsTab) => void;
  highlightApproval: (id: number | null) => void;
  setTrayOpen: (o: boolean) => void;
  toast: (text: string, level?: 'bad' | 'good' | 'info') => void;
  dismissToast: (id: number) => void;
  openRef: (ref: string | null) => void;
}

let toastSeq = 0;

export const useUi = create<UiState>()((set, get) => ({
  tab: 'factory',
  selectedAgentId: null,
  building: null,
  crateId: null,
  opportunityId: null,
  settingsOpen: false,
  settingsTab: 'profile',
  highlightApprovalId: null,
  trayOpen: true,
  toasts: [],

  setTab: (tab) => set({ tab }),
  selectAgent: (selectedAgentId) => set({ selectedAgentId }),
  openBuilding: (building) => set({ building }),
  openCrate: (crateId) => set({ crateId }),
  openOpportunity: (opportunityId) => set({ opportunityId }),
  openSettings: (settingsOpen, tab) => set({ settingsOpen, settingsTab: tab ?? get().settingsTab }),
  highlightApproval: (highlightApprovalId) => set({ highlightApprovalId, trayOpen: highlightApprovalId != null ? true : get().trayOpen }),
  setTrayOpen: (trayOpen) => set({ trayOpen }),
  toast: (text, level = 'bad') => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, text, level }].slice(-4) });
    setTimeout(() => get().dismissToast(id), 6000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  /** Open whatever a feed ref like `crate:12` / `opportunity:3` / `action:7` points at. */
  openRef: (ref) => {
    if (!ref) return;
    const [kind, raw] = ref.split(':');
    const id = Number(raw);
    if (!Number.isFinite(id)) return;
    if (kind === 'crate') set({ crateId: id });
    else if (kind === 'opportunity') set({ opportunityId: id });
    else if (kind === 'action') set({ highlightApprovalId: id, trayOpen: true });
    else if (kind === 'agent') set({ selectedAgentId: id });
  },
}));
