import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';
import { toSlateError } from './errors';

export const systemInfoSchema = z.object({
  appVersion: z.string(),
  schemaVersion: z.number().int(),
  deviceId: z.string(),
  dbPath: z.string(),
  integrityOk: z.boolean(),
});
export type SystemInfo = z.infer<typeof systemInfoSchema>;

/** Appel IPC typé : la réponse est validée à l'exécution, les erreurs normalisées. */
async function call<T>(
  cmd: string,
  schema: z.ZodType<T>,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return schema.parse(await invoke(cmd, args));
  } catch (e) {
    throw toSlateError(e);
  }
}

export const nodeSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  parentId: z.string().nullable(),
  kind: z.enum(['folder', 'page', 'database']),
  title: z.string(),
  position: z.string(),
  isFavorite: z.boolean(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
export type NodeRow = z.infer<typeof nodeSchema>;
const nodesSchema = z.array(nodeSchema);
const workspaceSchema = z.object({ id: z.string(), name: z.string() });
const workspaceRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['personal', 'shared']),
});
export type WorkspaceRow = z.infer<typeof workspaceRowSchema>;
const pageDataSchema = z.object({
  docState: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
const savedSchema = z.object({ updatedAt: z.string(), version: z.number() });
export const searchHitSchema = z.object({
  nodeId: z.string(),
  kind: z.enum(['folder', 'page', 'database']),
  title: z.string(),
  snippet: z.string(),
  updatedAt: z.string(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;
const nothing = z.null().transform(() => undefined);
const habitDaySchema = z.object({ rowId: z.string(), day: z.string() });
const workspaceSyncSchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  kind: z.enum(['personal', 'shared']),
  role: z.enum(['viewer', 'editor', 'admin']),
  nodeCursor: z.number(),
  docCursor: z.number(),
  structCursor: z.number(),
  lastPushAt: z.string().nullable(),
  lastPullAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type WorkspaceSync = z.infer<typeof workspaceSyncSchema>;
const syncStatusSchema = z.object({
  enabled: z.boolean(),
  deviceId: z.string(),
  pending: z.number(),
  rejected: z.number(),
  workspaces: z.array(workspaceSyncSchema),
});
export type SyncStatus = z.infer<typeof syncStatusSchema>;
const pendingOpSchema = z.object({
  opId: z.string(),
  workspaceId: z.string(),
  entity: z.enum(['node', 'doc', 'prop', 'view', 'row', 'thread', 'comment']),
  entityId: z.string(),
  fields: z.record(z.string(), z.unknown()),
  update: z.string().nullable(),
  clockMs: z.number(),
  deviceId: z.string(),
});
export type PendingOp = z.infer<typeof pendingOpSchema>;
const applyReportSchema = z.object({
  applied: z.number(),
  skipped: z.number().default(0),
  unresolved: z.number(),
});
const docForMergeSchema = z.object({ docState: z.string(), updatedAt: z.string() });
export interface SyncAck {
  opId: string;
  status: string;
  reason: string | null;
}
/** Élément du flux « structure » (noms de champs du serveur). */
export type RemoteStruct =
  | {
      kind: 'prop';
      id: string;
      database_id: string;
      name: string;
      type: string;
      config: unknown;
      position: string;
      deleted_at: string | null;
    }
  | {
      kind: 'view';
      id: string;
      database_id: string;
      name: string;
      layout: string;
      config: unknown;
      position: string;
      deleted_at: string | null;
    }
  | { kind: 'row'; id: string; database_id: string; props: Record<string, unknown> }
  | {
      kind: 'thread';
      id: string;
      node_id: string;
      quote: string;
      author_label: string | null;
      created_at: string;
      resolved_at: string | null;
      resolved_label: string | null;
      deleted_at: string | null;
    }
  | {
      kind: 'comment';
      id: string;
      thread_id: string;
      body: string;
      author_label: string | null;
      created_at: string;
      edited_at: string | null;
      deleted_at: string | null;
    };
export interface RemoteNode {
  id: string;
  parentId: string | null;
  kind: string;
  title: string;
  position: string;
  deletedAt: string | null;
  /** Supprimé définitivement ailleurs : la copie locale doit disparaître. */
  purgedAt?: string | null;
  createdAt: string;
}
const commentSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  body: z.string(),
  author: z.string().nullable(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
});
const threadSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  quote: z.string(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  comments: z.array(commentSchema),
});
export type CommentThread = z.infer<typeof threadSchema>;
export type ThreadComment = z.infer<typeof commentSchema>;
const versionMetaSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  createdAt: z.string(),
  reason: z.enum(['auto', 'manual', 'restore']),
  label: z.string().nullable(),
  author: z.string().nullable(),
  bytes: z.number(),
  words: z.number(),
});
const versionDataSchema = versionMetaSchema.extend({
  contentJson: z.string(),
  textPlain: z.string(),
});
export type VersionMeta = z.infer<typeof versionMetaSchema>;
const mediaInfoSchema = z.object({ hash: z.string(), mime: z.string(), size: z.number() });
const mediaDataSchema = z.object({ data: z.string(), mime: z.string() });
const reminderSchema = z.object({
  rowId: z.string(),
  databaseId: z.string(),
  propertyId: z.string(),
  title: z.string(),
  fireAt: z.string(),
});

export const propertySchema = z.object({
  id: z.string(),
  databaseId: z.string(),
  name: z.string(),
  type: z.string(),
  config: z.record(z.string(), z.unknown()),
  position: z.string(),
});
export type PropertyRow = z.infer<typeof propertySchema>;
export const viewSchema = z.object({
  id: z.string(),
  databaseId: z.string(),
  name: z.string(),
  layout: z.enum(['table', 'kanban', 'list', 'gallery', 'calendar']),
  config: z.record(z.string(), z.unknown()),
  position: z.string(),
});
export type ViewRow = z.infer<typeof viewSchema>;
export const dbRowSchema = z.object({
  id: z.string(),
  databaseId: z.string(),
  title: z.string(),
  props: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DbRow = z.infer<typeof dbRowSchema>;
const databaseSchema = z.object({
  node: nodeSchema,
  properties: z.array(propertySchema),
  views: z.array(viewSchema),
});
export type DatabaseData = z.infer<typeof databaseSchema>;
const nodeInfoSchema = z.object({ node: nodeSchema, databaseId: z.string().nullable() });
export interface CellChange {
  rowId: string;
  propertyId: string;
  value: unknown;
}

const settingRowsSchema = z.array(z.object({ key: z.string(), valueJson: z.string() }));

export const lockStateSchema = z.object({
  enabled: z.boolean(),
  lockOnStart: z.boolean(),
  idleMinutes: z.number(),
  failedCount: z.number(),
  retryAfterMs: z.number(),
  locked: z.boolean(),
});
export type LockState = z.infer<typeof lockStateSchema>;

export const ipc = {
  syncStatus: () => call('sync_status', syncStatusSchema),
  syncEnable: (workspaceId: string) => call('sync_enable', syncStatusSchema, { workspaceId }),
  syncDisable: () => call('sync_disable', syncStatusSchema),
  syncPending: (limit = 100) => call('sync_pending', z.array(pendingOpSchema), { limit }),
  syncAck: (results: SyncAck[]) => call('sync_ack', nothing, { results }),
  syncApplyNodes: (workspaceId: string, nodes: RemoteNode[], cursor: number | null) =>
    call('sync_apply_nodes', applyReportSchema, { workspaceId, nodes, cursor }),
  syncApplyStruct: (workspaceId: string, items: RemoteStruct[], cursor: number | null) =>
    call('sync_apply_struct', applyReportSchema, { workspaceId, items, cursor }),
  syncDocGet: (nodeId: string) => call('sync_doc_get', docForMergeSchema.nullable(), { nodeId }),
  syncApplyDoc: (a: {
    nodeId: string;
    docState: string;
    contentJson: string;
    textPlain: string;
    expectedUpdatedAt: string | null;
  }) => call('sync_apply_doc', z.enum(['applied', 'stale', 'missing']), a),
  syncSetDocCursor: (workspaceId: string, cursor: number) =>
    call('sync_set_doc_cursor', nothing, { workspaceId, cursor }),
  syncRecordError: (workspaceId: string, message: string) =>
    call('sync_record_error', nothing, { workspaceId, message }),
  syncJoinWorkspace: (workspaceId: string, name: string, role: string) =>
    call('sync_join_workspace', syncStatusSchema, { workspaceId, name, role }),
  syncSetRole: (workspaceId: string, role: string | null) =>
    call('sync_set_role', syncStatusSchema, { workspaceId, role }),
  openExternal: (url: string) => call('open_external', nothing, { url }),
  threadCreate: (id: string, nodeId: string, quote: string, body: string, author: string | null) =>
    call('thread_create', threadSchema, { id, nodeId, quote, body, author }),
  threadList: (nodeId: string) => call('thread_list', z.array(threadSchema), { nodeId }),
  commentAdd: (threadId: string, body: string, author: string | null) =>
    call('comment_add', commentSchema, { threadId, body, author }),
  commentEdit: (id: string, body: string) => call('comment_edit', commentSchema, { id, body }),
  commentDelete: (id: string) => call('comment_delete', z.boolean(), { id }),
  threadResolve: (threadId: string, resolved: boolean, author: string | null) =>
    call('thread_resolve', threadSchema, { threadId, resolved, author }),
  threadDelete: (threadId: string) => call('thread_delete', nothing, { threadId }),
  versionCreate: (
    nodeId: string,
    reason: VersionMeta['reason'],
    label: string | null,
    author: string | null,
  ) => call('version_create', versionMetaSchema, { nodeId, reason, label, author }),
  versionList: (nodeId: string) => call('version_list', z.array(versionMetaSchema), { nodeId }),
  versionGet: (id: string) => call('version_get', versionDataSchema, { id }),
  versionRename: (id: string, label: string | null) =>
    call('version_rename', nothing, { id, label }),
  versionDelete: (id: string) => call('version_delete', nothing, { id }),
  mediaPut: (data: string) => call('media_put', mediaInfoSchema, { data }),
  mediaGet: (hash: string) => call('media_get', mediaDataSchema, { hash }),
  habitLogList: (databaseId: string, from: string, to: string) =>
    call('habit_log_list', z.array(habitDaySchema), { databaseId, from, to }),
  habitLogSet: (rowId: string, day: string, done: boolean, today: string) =>
    call('habit_log_set', nothing, { rowId, day, done, today }),
  remindersDue: () => call('reminders_due', z.array(reminderSchema)),
  reminderAck: (rowId: string, propertyId: string, fireAt: string) =>
    call('reminder_ack', nothing, { rowId, propertyId, fireAt }),
  reminderNotify: (title: string, body: string) =>
    call('reminder_notify', nothing, { title, body }),
  vaultLoad: () => call('vault_load', z.string().nullable()),
  vaultSave: (token: string) => call('vault_save', nothing, { token }),
  vaultClear: () => call('vault_clear', nothing),
  pinStatus: () => call('pin_status', lockStateSchema),
  pinSet: (pin: string, current: string | null) =>
    call('pin_set', lockStateSchema, { pin, current }),
  pinDisable: (pin: string) => call('pin_disable', lockStateSchema, { pin }),
  pinVerify: (pin: string) => call('pin_verify', lockStateSchema, { pin }),
  pinLock: () => call('pin_lock', lockStateSchema),
  pinOptions: (pin: string, lockOnStart: boolean, idleMinutes: number) =>
    call('pin_options', lockStateSchema, { pin, lockOnStart, idleMinutes }),
  workspaceDefault: () => call('workspace_default', workspaceSchema),
  workspaceList: () => call('workspace_list', z.array(workspaceRowSchema)),
  treeList: (workspaceId: string) => call('tree_list', nodesSchema, { workspaceId }),
  nodeCreate: (a: {
    workspaceId: string;
    parentId: string | null;
    kind: 'folder' | 'page';
    title: string;
    beforeId: string | null;
  }) => call('node_create', nodeSchema, a),
  nodeRename: (id: string, title: string) => call('node_rename', nodeSchema, { id, title }),
  nodeMove: (id: string, newParentId: string | null, beforeId: string | null) =>
    call('node_move', nodeSchema, { id, newParentId, beforeId }),
  nodeSetFavorite: (id: string, favorite: boolean) =>
    call('node_set_favorite', nodeSchema, { id, favorite }),
  nodeDelete: (id: string) => call('node_delete', z.number(), { id }),
  nodeRestore: (id: string) => call('node_restore', nodeSchema, { id }),
  trashList: (workspaceId: string) => call('trash_list', nodesSchema, { workspaceId }),
  nodePurge: (id: string) => call('node_purge', z.number(), { id }),
  trashEmpty: (workspaceId: string) => call('trash_empty', z.number(), { workspaceId }),
  recentTouch: (id: string) => call('recent_touch', nothing, { id }),
  recentList: (workspaceId: string, limit = 8) =>
    call('recent_list', nodesSchema, { workspaceId, limit }),
  pageGet: (id: string) => call('page_get', pageDataSchema, { id }),
  pageSave: (a: {
    id: string;
    docState: string;
    contentJson: string;
    textPlain: string;
    linkTargets: string[];
  }) => call('page_save', savedSchema, a),
  backlinksList: (id: string) => call('backlinks_list', nodesSchema, { id }),
  nodeGet: (id: string) => call('node_get', nodeInfoSchema, { id }),
  dbCreate: (a: {
    workspaceId: string;
    parentId: string | null;
    title: string;
    titlePropertyName: string;
    viewName: string;
  }) => call('db_create', databaseSchema, a),
  dbGet: (id: string) => call('db_get', databaseSchema, { id }),
  dbRows: (id: string) => call('db_rows', z.array(dbRowSchema), { id }),
  rowGet: (id: string) => call('row_get', dbRowSchema, { id }),
  propCreate: (a: {
    databaseId: string;
    name: string;
    kind: string;
    config: Record<string, unknown>;
    beforeId: string | null;
    twoWayName: string | null;
  }) => call('prop_create', propertySchema, a),
  propUpdate: (a: { id: string; name?: string; config?: Record<string, unknown>; kind?: string }) =>
    call('prop_update', propertySchema, a),
  propDelete: (id: string) => call('prop_delete', nothing, { id }),
  propMove: (id: string, beforeId: string | null) =>
    call('prop_move', propertySchema, { id, beforeId }),
  viewCreate: (a: {
    databaseId: string;
    name: string;
    layout: string;
    config: Record<string, unknown>;
  }) => call('view_create', viewSchema, a),
  viewUpdate: (a: { id: string; name?: string; config?: Record<string, unknown> }) =>
    call('view_update', viewSchema, a),
  viewDelete: (id: string) => call('view_delete', nothing, { id }),
  cellsSet: (changes: CellChange[]) => call('cells_set', z.array(dbRowSchema), { changes }),
  rowCreate: (a: { databaseId: string; title: string; props: Record<string, unknown> | null }) =>
    call('row_create', dbRowSchema, a),
  rowsDelete: (ids: string[]) => call('rows_delete', z.number(), { ids }),
  searchPages: (workspaceId: string, query: string, limit = 12) =>
    call('search_pages', z.array(searchHitSchema), { workspaceId, query, limit }),
  settingsGetAll: () => call('settings_get_all', settingRowsSchema),
  settingsSet: (key: string, valueJson: string) =>
    call('settings_set', z.null(), { key, valueJson }).then(() => undefined),
  settingsDelete: (key: string) => call('settings_delete', z.null(), { key }).then(() => undefined),
  ping: (message: string) => call('ping', z.string(), { message }),
  systemInfo: () => call('system_info', systemInfoSchema),
};
export type Ipc = typeof ipc;
