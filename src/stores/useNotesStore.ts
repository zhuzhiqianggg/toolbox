import { create } from 'zustand';
import {
  type Note,
  type NoteChangedPayload,
  type NoteCreateInput,
  type NoteGeometry,
  type NotePatch,
  createNote as createNoteApi,
  deleteNote as deleteNoteApi,
  listNotes,
  setGeometry as setGeometryApi,
  sortNotes,
  updateNote as updateNoteApi,
} from '@/core/data/notesService';
import { BUS_EVENT_NOTES_CHANGED, busOn } from '@/core/data/bus';

/**
 * 便签集合状态（zustand，V08）。
 *
 * 每个窗口（主面板 / 各便签窗）各持有一份独立实例，共享同一 SQLite 数据源；
 * 跨窗口一致性由事件总线保证：本窗口写操作经 service 广播，所有窗口（含自己）
 * 统一走 `applyChanged` 应用变更——**本地与远端共用同一条应用路径**，语义一致。
 */

interface NotesState {
  /** 便签列表（已按 pinned → z → updatedAt 排序） */
  notes: Note[];
  /** 是否已完成首次加载（含失败） */
  loaded: boolean;
  /** 首次加载失败信息（null = 正常） */
  error: string | null;
  /**
   * 外部请求聚焦的笔记 id（V18）。
   *
   * 用途：待办里「打开来源笔记」不再弹桌面悬浮便签窗，而是切到工作台的笔记面板
   * 并定位到那一条。工作台与待办同在主窗口、共用本 store，所以用一次性请求传递即可；
   * 消费方（`NotesPanel`）定位后必须调用 `clearFocusRequest` 清空，避免重复触发。
   */
  focusRequestId: string | null;

  /** 请求把笔记面板定位到指定笔记（切视图由调用方负责） */
  requestFocus: (id: string) => void;
  /** 清空聚焦请求（消费后调用） */
  clearFocusRequest: () => void;

  /** 启动装配：加载列表 + 订阅跨窗口变更（幂等，可重复调用） */
  hydrate: () => Promise<void>;
  /** 新建便签（返回完整实体） */
  createNote: (input?: NoteCreateInput) => Promise<Note>;
  /** 增量更新便签 */
  updateNote: (id: string, patch: NotePatch) => Promise<void>;
  /** 删除便签 */
  deleteNote: (id: string) => Promise<void>;
  /** 批量写几何（拖动/缩放结束时调用） */
  setGeometry: (id: string, geometry: NoteGeometry) => Promise<void>;
  /** 切换置顶 */
  togglePin: (id: string) => Promise<void>;
}

/** 跨窗口变更 → 本地状态（本地广播与远端广播共用此路径）。 */
function applyChanged(payload: NoteChangedPayload): void {
  const { notes } = useNotesStore.getState();
  switch (payload.action) {
    case 'create': {
      const note = payload.note;
      if (note && !notes.some((n) => n.id === note.id)) {
        useNotesStore.setState({ notes: sortNotes([...notes, note]) });
      }
      break;
    }
    case 'update': {
      const { patch, updatedAt } = payload;
      if (!patch) {
        break;
      }
      const mergedAt = updatedAt ?? Date.now();
      useNotesStore.setState({
        notes: sortNotes(
          notes.map((n) => (n.id === payload.id ? { ...n, ...patch, updatedAt: mergedAt } : n)),
        ),
      });
      break;
    }
    case 'geometry': {
      const geometry = payload.geometry;
      if (!geometry) {
        break;
      }
      useNotesStore.setState({
        notes: notes.map((n) => (n.id === payload.id ? { ...n, ...geometry } : n)),
      });
      break;
    }
    case 'delete':
      useNotesStore.setState({ notes: notes.filter((n) => n.id !== payload.id) });
      break;
  }
}

/** 总线订阅只注册一次（hydrate 可能被多个组件/多个窗口调用） */
let subscribed = false;
function subscribeOnce(): void {
  if (subscribed) {
    return;
  }
  subscribed = true;
  busOn<NoteChangedPayload>(BUS_EVENT_NOTES_CHANGED, applyChanged);
}

export const useNotesStore = create<NotesState>()((set, get) => ({
  notes: [],
  loaded: false,
  error: null,
  focusRequestId: null,

  requestFocus: (id) => set({ focusRequestId: id }),

  clearFocusRequest: () => set({ focusRequestId: null }),

  hydrate: async () => {
    subscribeOnce();
    if (get().loaded) {
      return;
    }
    try {
      const notes = await listNotes();
      set({ notes, loaded: true, error: null });
    } catch (error: unknown) {
      set({
        loaded: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  createNote: (input) => createNoteApi(input ?? {}),

  updateNote: (id, patch) => updateNoteApi(id, patch),

  deleteNote: (id) => deleteNoteApi(id),

  setGeometry: (id, geometry) => setGeometryApi(id, geometry),

  togglePin: async (id) => {
    const note = get().notes.find((n) => n.id === id);
    if (!note) {
      return;
    }
    await updateNoteApi(id, { pinned: !note.pinned });
  },
}));
