import { create } from 'zustand';
import {
  type Todo,
  type TodoChangedPayload,
  type TodoCreateInput,
  type TodoPatch,
  createTodo as createTodoApi,
  deleteTodo as deleteTodoApi,
  listTodos,
  sortTodos,
  updateTodo as updateTodoApi,
} from '@/core/data/todosService';
import { BUS_EVENT_TODOS_CHANGED, busOn } from '@/core/data/bus';

/**
 * 待办集合状态（zustand，V09）——与 `useNotesStore` 同构。
 *
 * 每窗口各持独立实例，共享同一 SQLite 数据源；跨窗口一致性由事件总线保证
 * （本地与远端变更共用 `applyChanged` 一条应用路径）。
 * 提醒调度（ReminderScheduler）不经本 store：直接读库，避免多窗口重复调度。
 */

interface TodosState {
  /** 待办列表（已按 sortTodos 排序） */
  todos: Todo[];
  /** 是否已完成首次加载（含失败） */
  loaded: boolean;
  /** 首次加载失败信息（null = 正常） */
  error: string | null;

  /** 启动装配：加载列表 + 订阅跨窗口变更（幂等，可重复调用） */
  hydrate: () => Promise<void>;
  /** 新建待办（返回完整实体） */
  createTodo: (input?: TodoCreateInput) => Promise<Todo>;
  /** 增量更新待办 */
  updateTodo: (id: string, patch: TodoPatch) => Promise<void>;
  /** 删除待办 */
  deleteTodo: (id: string) => Promise<void>;
  /** 切换完成态（完成即置已提醒，不再通知） */
  toggleDone: (id: string) => Promise<void>;
}

/** 跨窗口变更 → 本地状态（本地广播与远端广播共用此路径）。 */
function applyChanged(payload: TodoChangedPayload): void {
  const { todos } = useTodosStore.getState();
  switch (payload.action) {
    case 'create': {
      const todo = payload.todo;
      if (todo && !todos.some((t) => t.id === todo.id)) {
        useTodosStore.setState({ todos: sortTodos([...todos, todo]) });
      }
      break;
    }
    case 'update': {
      const { patch, updatedAt } = payload;
      if (!patch) {
        break;
      }
      const mergedAt = updatedAt ?? Date.now();
      useTodosStore.setState({
        todos: sortTodos(
          todos.map((t) => (t.id === payload.id ? { ...t, ...patch, updatedAt: mergedAt } : t)),
        ),
      });
      break;
    }
    case 'delete':
      useTodosStore.setState({ todos: todos.filter((t) => t.id !== payload.id) });
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
  busOn<TodoChangedPayload>(BUS_EVENT_TODOS_CHANGED, applyChanged);
}

export const useTodosStore = create<TodosState>()((set, get) => ({
  todos: [],
  loaded: false,
  error: null,

  hydrate: async () => {
    subscribeOnce();
    if (get().loaded) {
      return;
    }
    try {
      const todos = await listTodos();
      set({ todos, loaded: true, error: null });
    } catch (error: unknown) {
      set({
        loaded: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  createTodo: (input) => createTodoApi(input ?? {}),

  updateTodo: (id, patch) => updateTodoApi(id, patch),

  deleteTodo: (id) => deleteTodoApi(id),

  toggleDone: async (id) => {
    const todo = get().todos.find((t) => t.id === id);
    if (!todo) {
      return;
    }
    await updateTodoApi(id, { done: !todo.done });
  },
}));
