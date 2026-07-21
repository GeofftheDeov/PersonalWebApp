/**
 * Postgres-backed model layer with a mongoose-compatible API surface.
 *
 * Phase-1 of the MongoDB → Postgres migration (see POSTGRES_MIGRATION.md):
 * routes keep their existing call sites (find/findOne/save/populate/...)
 * while all persistence runs as parameterized SQL on node-postgres.
 * Supported surface is exactly what the codebase uses — this is not a
 * general ORM. Idiomize hot paths to plain SQL incrementally.
 */
import pg from "pg";
import pool from "./index.js";

// ---------------------------------------------------------------- types

type FieldType = "plain" | "jsonb" | "uuid" | "uuid[]" | "text[]";

export interface FieldDef {
  col: string;
  type?: FieldType; // default "plain"
}

export interface ModelDef {
  table: string;
  /** jsField -> column. Dotted jsFields (e.g. "sender.id") nest on load. */
  fields: Record<string, string | FieldDef>;
  /** jsField -> Model factory, for populate(). */
  refs?: Record<string, () => any>;
  /** Applied on insert when the field is undefined. Functions are called. */
  defaults?: Record<string, any>;
  /** Runs before INSERT/UPDATE from save()/create(). */
  preSave?: (doc: any, ctx: { isNew: boolean; isModified: (f: string) => boolean }) => Promise<void> | void;
  /** Fired (not awaited) after a successful INSERT from save()/create(). */
  postSave?: (doc: any) => void;
}

export interface ClientSession {
  client: pg.PoolClient | null;
  startTransaction(): Promise<void>;
  commitTransaction(): Promise<void>;
  abortTransaction(): Promise<void>;
  endSession(): void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): boolean => typeof v === "string" && UUID_RE.test(v);

/** Drop-in for mongoose.startSession() — wraps a pg transaction. */
export async function startSession(): Promise<ClientSession> {
  let client: pg.PoolClient | null = null;
  return {
    get client() { return client; },
    async startTransaction() {
      client = await pool.connect();
      await client.query("BEGIN");
    },
    async commitTransaction() {
      if (client) await client.query("COMMIT");
    },
    async abortTransaction() {
      if (client) { try { await client.query("ROLLBACK"); } catch { /* noop */ } }
    },
    endSession() {
      client?.release();
      client = null;
    },
  };
}

// ---------------------------------------------------------------- helpers

function fdef(def: ModelDef, jsField: string): FieldDef | null {
  const f = def.fields[jsField];
  if (!f) return null;
  return typeof f === "string" ? { col: f, type: "plain" } : { col: f.col, type: f.type ?? "plain" };
}

function runner(session?: ClientSession | null): pg.Pool | pg.PoolClient {
  return session?.client ?? pool;
}

function toParam(value: any, type: FieldType): any {
  if (type === "jsonb") return value === undefined || value === null ? null : JSON.stringify(value);
  return value === undefined ? null : value;
}

function castSuffix(type: FieldType): string {
  return type === "jsonb" ? "::jsonb" : "";
}

/** Convert a JS RegExp (or string) to a Postgres regex condition. */
function regexCond(col: string, re: RegExp | string, options?: string, params?: any[]): string {
  const src = re instanceof RegExp ? re.source : String(re);
  const flags = (re instanceof RegExp ? re.flags : options) ?? "";
  params!.push(src);
  return `${col} ${flags.includes("i") ? "~*" : "~"} $${params!.length}`;
}

// ---------------------------------------------------------------- where builder

function buildWhere(def: ModelDef, filter: any, params: any[]): string {
  if (!filter || Object.keys(filter).length === 0) return "TRUE";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$or" || key === "$and") {
      const sub = (value as any[]).map((f) => `(${buildWhere(def, f, params)})`);
      parts.push(`(${sub.join(key === "$or" ? " OR " : " AND ")})`);
      continue;
    }
    const f = key === "_id" || key === "id" ? { col: "id", type: "uuid" as FieldType } : fdef(def, key);
    if (!f) throw new Error(`[db] ${def.table}: unknown filter field "${key}"`);
    parts.push(fieldCond(f, value, params));
  }
  return parts.join(" AND ") || "TRUE";
}

function fieldCond(f: FieldDef, value: any, params: any[]): string {
  const isUuidField = f.type === "uuid";
  const guard = (v: any) => !(isUuidField && !isUuid(String(v))); // bad uuid -> no match, not an error

  if (value === null) return `${f.col} IS NULL`;
  if (value instanceof RegExp) return regexCond(f.col, value, undefined, params);

  if (typeof value === "object" && !(value instanceof Date) && !Array.isArray(value)) {
    const conds: string[] = [];
    for (const [op, v] of Object.entries(value)) {
      switch (op) {
        case "$in": {
          const arr = (v as any[]).filter(guard).map(String);
          if (arr.length === 0) return "FALSE";
          params.push(arr);
          conds.push(`${f.col} = ANY($${params.length}${isUuidField ? "::uuid[]" : ""})`);
          break;
        }
        case "$nin": {
          const arr = (v as any[]).filter(guard).map(String);
          if (arr.length === 0) { conds.push("TRUE"); break; }
          params.push(arr);
          conds.push(`NOT (${f.col} = ANY($${params.length}${isUuidField ? "::uuid[]" : ""}))`);
          break;
        }
        case "$ne":
          if (v === null) conds.push(`${f.col} IS NOT NULL`);
          else { params.push(v); conds.push(`${f.col} IS DISTINCT FROM $${params.length}`); }
          break;
        case "$gt": params.push(v); conds.push(`${f.col} > $${params.length}`); break;
        case "$gte": params.push(v); conds.push(`${f.col} >= $${params.length}`); break;
        case "$lt": params.push(v); conds.push(`${f.col} < $${params.length}`); break;
        case "$lte": params.push(v); conds.push(`${f.col} <= $${params.length}`); break;
        case "$regex": conds.push(regexCond(f.col, v as any, (value as any).$options, params)); break;
        case "$options": break; // consumed by $regex
        case "$exists": conds.push((v as boolean) ? `${f.col} IS NOT NULL` : `${f.col} IS NULL`); break;
        default: throw new Error(`[db] unsupported operator ${op} on ${f.col}`);
      }
    }
    return conds.length ? conds.join(" AND ") : "TRUE";
  }

  // plain equality
  if (isUuidField && !guard(value)) return "FALSE";
  if (f.type === "uuid[]") { // equality against array field means "contains"
    if (!isUuid(String(value))) return "FALSE";
    params.push(String(value));
    return `$${params.length}::uuid = ANY(${f.col})`;
  }
  params.push(value instanceof Date ? value : value);
  return `${f.col} = $${params.length}`;
}

// ---------------------------------------------------------------- update builder

function buildUpdate(def: ModelDef, update: any, params: any[]): string {
  const sets: string[] = [];
  const plain: Record<string, any> = {};
  for (const [key, value] of Object.entries(update ?? {})) {
    switch (key) {
      case "$set": Object.assign(plain, value); break;
      case "$setOnInsert": break; // handled by upsert path
      case "$inc":
        for (const [k, v] of Object.entries(value as any)) {
          const f = fdef(def, k); if (!f) throw new Error(`[db] unknown $inc field ${k}`);
          params.push(v);
          sets.push(`${f.col} = COALESCE(${f.col}, 0) + $${params.length}`);
        }
        break;
      case "$push":
      case "$addToSet":
        for (const [k, v] of Object.entries(value as any)) {
          const f = fdef(def, k); if (!f) throw new Error(`[db] unknown ${key} field ${k}`);
          const cast = f.type === "uuid[]" ? "::uuid" : "";
          params.push(String(v));
          const p = `$${params.length}${cast}`;
          sets.push(key === "$addToSet"
            ? `${f.col} = CASE WHEN ${p} = ANY(${f.col}) THEN ${f.col} ELSE array_append(${f.col}, ${p}) END`
            : `${f.col} = array_append(${f.col}, ${p})`);
        }
        break;
      case "$pull":
        for (const [k, v] of Object.entries(value as any)) {
          const f = fdef(def, k); if (!f) throw new Error(`[db] unknown $pull field ${k}`);
          params.push(String(v));
          sets.push(`${f.col} = array_remove(${f.col}, $${params.length}${f.type === "uuid[]" ? "::uuid" : ""})`);
        }
        break;
      default:
        if (key.startsWith("$")) throw new Error(`[db] unsupported update operator ${key}`);
        plain[key] = value;
    }
  }
  for (const [k, v] of Object.entries(plain)) {
    const f = fdef(def, k);
    if (!f) continue; // silently skip unknown fields, like mongoose strict mode
    params.push(toParam(v, f.type!));
    sets.push(`${f.col} = $${params.length}${castSuffix(f.type!)}`);
  }
  if (!sets.length) throw new Error(`[db] ${def.table}: empty update`);
  return sets.join(", ");
}

// ---------------------------------------------------------------- row <-> doc

function rowToDoc(def: ModelDef, row: any, ModelClass: any, partial: boolean): any {
  const doc = Object.create(ModelClass.prototype);
  doc.__def = def;
  doc.__isNew = false;
  doc.__partial = partial;
  for (const [jsField, raw] of Object.entries(def.fields)) {
    const f = typeof raw === "string" ? { col: raw } : raw;
    if (!(f.col in row)) continue;
    setPath(doc, jsField, row[f.col]);
  }
  doc._id = row.id;
  doc.id = row.id;
  if ("created_at" in row) doc.createdAt = row.created_at;
  if ("updated_at" in row) doc.updatedAt = row.updated_at;
  doc.__orig = JSON.parse(JSON.stringify(doc.toObject()));
  return doc;
}

function setPath(obj: any, path: string, value: any) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] ?? (cur[parts[i]] = {});
  cur[parts[parts.length - 1]] = value;
}

function getPath(obj: any, path: string): any {
  return path.split(".").reduce((o, p) => (o == null ? undefined : o[p]), obj);
}

// ---------------------------------------------------------------- query chain

class Query<T = any> implements PromiseLike<T> {
  private _sort: string | null = null;
  private _limit: number | null = null;
  private _select: string | null = null;
  private _lean = false;
  private _populate: Array<string | { path: string; select?: string }> = [];
  private _session: ClientSession | null = null;

  constructor(
    private M: any,
    private filter: any,
    private mode: "many" | "one",
    private byId: string | null = null,
  ) {}

  sort(spec: Record<string, 1 | -1 | "asc" | "desc">) {
    const parts = Object.entries(spec).map(([k, dir]) => {
      const f = k === "_id" ? { col: "id" } : fdef(this.M.__def, k);
      if (!f) throw new Error(`[db] unknown sort field ${k}`);
      return `${f.col} ${dir === 1 || dir === "asc" ? "ASC" : "DESC"}`;
    });
    this._sort = parts.join(", ");
    return this;
  }
  limit(n: number) { this._limit = n; return this; }
  select(spec: string) { this._select = spec; return this; }
  lean() { this._lean = true; return this; }
  populate(spec: string | { path: string; select?: string }) { this._populate.push(spec); return this; }
  session(s: ClientSession | null) { this._session = s; return this; }

  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.exec().then(onfulfilled as any, onrejected as any);
  }
  catch(onrejected: (reason: any) => any) { return this.exec().catch(onrejected); }

  async exec(): Promise<any> {
    const def: ModelDef = this.M.__def;
    if (this.byId !== null && !isUuid(this.byId)) return this.mode === "one" ? null : [];
    const params: any[] = [];
    const where = this.byId !== null
      ? (params.push(this.byId), `id = $1`)
      : buildWhere(def, this.filter, params);
    let sql = `SELECT * FROM ${def.table} WHERE ${where}`;
    if (this._sort) sql += ` ORDER BY ${this._sort}`;
    if (this.mode === "one") sql += " LIMIT 1";
    else if (this._limit != null) sql += ` LIMIT ${Number(this._limit)}`;
    const { rows } = await runner(this._session).query(sql, params);

    const partial = this._select != null;
    let docs = rows.map((r) => rowToDoc(def, r, this.M, partial));
    if (this._select) docs = docs.map((d) => applySelect(d, this._select!));
    if (this._populate.length) await populateDocs(this.M, docs, this._populate);
    if (this._lean) docs = docs.map((d) => d.toObject());
    return this.mode === "one" ? (docs[0] ?? null) : docs;
  }
}

function applySelect(doc: any, spec: string): any {
  const parts = spec.split(/\s+/).filter(Boolean);
  const excludes = parts.filter((p) => p.startsWith("-")).map((p) => p.slice(1));
  const includes = parts.filter((p) => !p.startsWith("-"));
  if (includes.length) {
    const keep = new Set([...includes, "_id", "id", "createdAt"]);
    for (const k of Object.keys(doc)) {
      if (k.startsWith("__")) continue;
      if (!keep.has(k)) delete doc[k];
    }
  }
  for (const e of excludes) delete doc[e];
  return doc;
}

async function populateDocs(M: any, docs: any[], specs: Array<string | { path: string; select?: string }>) {
  for (const spec of specs) {
    const path = typeof spec === "string" ? spec : spec.path;
    const select = typeof spec === "string" ? undefined : spec.select;
    const refFactory = M.__def.refs?.[path];
    if (!refFactory) continue; // silently skip, mongoose-style
    const Ref = refFactory();
    const ids = new Set<string>();
    for (const d of docs) {
      const v = getPath(d, path);
      if (Array.isArray(v)) v.forEach((x) => isUuid(String(x)) && ids.add(String(x)));
      else if (v != null && isUuid(String(v))) ids.add(String(v));
    }
    if (!ids.size) continue;
    let q = Ref.find({ _id: { $in: [...ids] } });
    if (select) q = q.select(select);
    const refs = await q;
    const byId = new Map(refs.map((r: any) => [String(r._id), r]));
    for (const d of docs) {
      const v = getPath(d, path);
      if (Array.isArray(v)) setPath(d, path, v.map((x) => byId.get(String(x)) ?? x));
      else if (v != null) setPath(d, path, byId.get(String(v)) ?? null);
    }
  }
}

// ---------------------------------------------------------------- model factory

export function defineModel(def: ModelDef): any {
  class Model {
    static __def = def;
    static modelName = def.table;

    __def!: ModelDef;
    __isNew!: boolean;
    __partial!: boolean;
    __orig: any;
    _id?: string;
    id?: string;
    [key: string]: any;

    constructor(fields: Record<string, any> = {}) {
      this.__def = def;
      this.__isNew = true;
      this.__partial = false;
      this.__orig = {};
      for (const [k, v] of Object.entries(fields)) setPath(this, k, v);
    }

    isModified(field: string): boolean {
      if (this.__isNew) return getPath(this, field) !== undefined;
      return JSON.stringify(getPath(this, field) ?? null) !== JSON.stringify(getPath(this.__orig, field) ?? null);
    }

    toObject(): any {
      const out: any = {};
      for (const k of Object.keys(this)) {
        if (k.startsWith("__")) continue;
        out[k] = this[k];
      }
      return out;
    }
    toJSON(): any { return this.toObject(); }

    async save(opts: { session?: ClientSession } = {}): Promise<any> {
      if (this.__partial) throw new Error(`[db] ${def.table}: refusing to save() a select()-narrowed document`);
      const isNew = this.__isNew;
      if (def.preSave) await def.preSave(this, { isNew, isModified: (f) => this.isModified(f) });
      const r = runner(opts.session);

      if (isNew) {
        const cols: string[] = [];
        const placeholders: string[] = [];
        const params: any[] = [];
        for (const [jsField, raw] of Object.entries(def.fields)) {
          const f = typeof raw === "string" ? { col: raw, type: "plain" as FieldType } : { type: "plain" as FieldType, ...raw };
          let v = getPath(this, jsField);
          if (v === undefined && def.defaults && jsField in def.defaults) {
            const dv = def.defaults[jsField];
            v = typeof dv === "function" ? dv() : dv;
            setPath(this, jsField, v);
          }
          if (v === undefined) continue;
          cols.push(f.col);
          params.push(toParam(v, f.type!));
          placeholders.push(`$${params.length}${castSuffix(f.type!)}`);
        }
        const sql = cols.length
          ? `INSERT INTO ${def.table} (${cols.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`
          : `INSERT INTO ${def.table} DEFAULT VALUES RETURNING *`;
        const { rows } = await r.query(sql, params);
        rehydrate(this, def, rows[0]);
        this.__isNew = false;
        if (def.postSave) { try { def.postSave(this); } catch (e) { console.error(`[db] postSave ${def.table}:`, e); } }
        return this;
      }

      // UPDATE only modified columns
      const params: any[] = [];
      const sets: string[] = [];
      for (const [jsField, raw] of Object.entries(def.fields)) {
        const f = typeof raw === "string" ? { col: raw, type: "plain" as FieldType } : { type: "plain" as FieldType, ...raw };
        if (!this.isModified(jsField)) continue;
        params.push(toParam(getPath(this, jsField), f.type!));
        sets.push(`${f.col} = $${params.length}${castSuffix(f.type!)}`);
      }
      if (!sets.length) return this;
      params.push(this._id);
      const { rows } = await r.query(
        `UPDATE ${def.table} SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params);
      if (rows[0]) rehydrate(this, def, rows[0]);
      return this;
    }

    // ---------------- statics ----------------
    static find(filter: any = {}) { return new Query(Model, filter, "many"); }
    static findOne(filter: any = {}) { return new Query(Model, filter, "one"); }
    static findById(id: any) { return new Query(Model, null, "one", String(id)); }

    static async create(fields: Record<string, any>) {
      const doc = new Model(fields);
      return doc.save();
    }

    static async countDocuments(filter: any = {}, opts: { session?: ClientSession } = {}): Promise<number> {
      const params: any[] = [];
      const where = buildWhere(def, filter, params);
      const { rows } = await runner(opts.session).query(`SELECT COUNT(*)::int AS n FROM ${def.table} WHERE ${where}`, params);
      return rows[0].n;
    }

    static async updateOne(filter: any, update: any, opts: { session?: ClientSession } = {}) {
      const params: any[] = [];
      const setSql = buildUpdate(def, update, params);
      const where = buildWhere(def, filter, params);
      const res = await runner(opts.session).query(
        `UPDATE ${def.table} SET ${setSql} WHERE id = (SELECT id FROM ${def.table} WHERE ${where} LIMIT 1)`, params);
      return { matchedCount: res.rowCount, modifiedCount: res.rowCount };
    }

    static async updateMany(filter: any, update: any, opts: { session?: ClientSession } = {}) {
      const params: any[] = [];
      const setSql = buildUpdate(def, update, params);
      const where = buildWhere(def, filter, params);
      const res = await runner(opts.session).query(`UPDATE ${def.table} SET ${setSql} WHERE ${where}`, params);
      return { matchedCount: res.rowCount, modifiedCount: res.rowCount };
    }

    static async findOneAndUpdate(filter: any, update: any, opts: { session?: ClientSession; new?: boolean; upsert?: boolean } = {}) {
      const r = runner(opts.session);
      const params: any[] = [];
      const setSql = buildUpdate(def, update, params);
      const where = buildWhere(def, filter, params);
      const { rows } = await r.query(
        `UPDATE ${def.table} SET ${setSql} WHERE id = (SELECT id FROM ${def.table} WHERE ${where} LIMIT 1) RETURNING *`, params);
      if (rows[0]) return rowToDoc(def, rows[0], Model, false);
      if (!opts.upsert) return null;
      // upsert: merge equality fields from the filter + $set/$setOnInsert + plain update fields
      const seed: Record<string, any> = {};
      for (const [k, v] of Object.entries(filter ?? {})) {
        if (!k.startsWith("$") && (typeof v !== "object" || v instanceof Date || v === null)) seed[k] = v;
      }
      Object.assign(seed, update?.$setOnInsert ?? {});
      Object.assign(seed, update?.$set ?? {});
      for (const [k, v] of Object.entries(update ?? {})) if (!k.startsWith("$")) seed[k] = v;
      const doc = new Model(seed);
      return doc.save({ session: opts.session });
    }

    static async findByIdAndUpdate(id: any, update: any, opts: { session?: ClientSession; new?: boolean } = {}) {
      if (!isUuid(String(id))) return null;
      const params: any[] = [];
      const setSql = buildUpdate(def, update, params);
      params.push(String(id));
      const { rows } = await runner(opts.session).query(
        `UPDATE ${def.table} SET ${setSql} WHERE id = $${params.length} RETURNING *`, params);
      return rows[0] ? rowToDoc(def, rows[0], Model, false) : null;
    }

    static async findByIdAndDelete(id: any, opts: { session?: ClientSession } = {}) {
      if (!isUuid(String(id))) return null;
      const { rows } = await runner(opts.session).query(`DELETE FROM ${def.table} WHERE id = $1 RETURNING *`, [String(id)]);
      return rows[0] ? rowToDoc(def, rows[0], Model, false) : null;
    }

    static async findOneAndDelete(filter: any, opts: { session?: ClientSession } = {}) {
      const params: any[] = [];
      const where = buildWhere(def, filter, params);
      const { rows } = await runner(opts.session).query(
        `DELETE FROM ${def.table} WHERE id = (SELECT id FROM ${def.table} WHERE ${where} LIMIT 1) RETURNING *`, params);
      return rows[0] ? rowToDoc(def, rows[0], Model, false) : null;
    }

    static async deleteOne(filter: any, opts: { session?: ClientSession } = {}) {
      const params: any[] = [];
      const where = buildWhere(def, filter, params);
      const res = await runner(opts.session).query(
        `DELETE FROM ${def.table} WHERE id = (SELECT id FROM ${def.table} WHERE ${where} LIMIT 1)`, params);
      return { deletedCount: res.rowCount };
    }

    static async deleteMany(filter: any = {}, opts: { session?: ClientSession } = {}) {
      const params: any[] = [];
      const where = buildWhere(def, filter, params);
      const res = await runner(opts.session).query(`DELETE FROM ${def.table} WHERE ${where}`, params);
      return { deletedCount: res.rowCount };
    }
  }
  return Model;
}

function rehydrate(doc: any, def: ModelDef, row: any) {
  for (const [jsField, raw] of Object.entries(def.fields)) {
    const f = typeof raw === "string" ? { col: raw } : raw;
    if (f.col in row) setPath(doc, jsField, row[f.col]);
  }
  doc._id = row.id;
  doc.id = row.id;
  if ("created_at" in row) doc.createdAt = row.created_at;
  if ("updated_at" in row) doc.updatedAt = row.updated_at;
  doc.__orig = JSON.parse(JSON.stringify(doc.toObject()));
}
