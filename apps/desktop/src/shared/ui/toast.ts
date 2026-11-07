import { create } from 'zustand';

export interface ToastAction {
  label: string;
  run(): void;
}
export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
  action?: ToastAction;
}
interface ToastState {
  toasts: Toast[];
  push(kind: Toast['kind'], message: string, action?: ToastAction): number;
  dismiss(id: number): void;
}
let seq = 0;
export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push(kind, message, action) {
    const id = ++seq;
    const t: Toast = action ? { id, kind, message, action } : { id, kind, message };
    set((s) => ({ toasts: [...s.toasts.slice(-3), t] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
export const toast = {
  info: (m: string, action?: ToastAction) => useToasts.getState().push('info', m, action),
  success: (m: string) => useToasts.getState().push('success', m),
  error: (m: string) => useToasts.getState().push('error', m),
};
