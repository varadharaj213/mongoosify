/// <reference types="node" />

import { EventEmitter } from 'events';
import { ObjectId, ClientSession, Collection, Db, MongoClient } from 'mongodb';

// ─── Utility Types ────────────────────────────────────────────────────────────

export type AnyObject = Record<string, any>;

/** Recursively makes all properties optional */
export type DeepPartial<T> = { [K in keyof T]?: DeepPartial<T[K]> };

/** Strip methods and virtuals to get plain data keys */
export type DocData<T> = Omit<T, keyof Document<T>>;

/** MongoDB filter type */
export type FilterQuery<T> = {
  [K in keyof T]?: T[K] | { [op: string]: any };
} & { [key: string]: any };

/** MongoDB update type */
export type UpdateQuery<T> = {
  $set?: Partial<T> & AnyObject;
  $unset?: { [K in keyof T]?: any };
  $inc?: { [K in keyof T]?: number };
  $push?: { [K in keyof T]?: any };
  $pull?: { [K in keyof T]?: any };
  $addToSet?: { [K in keyof T]?: any };
  [op: string]: any;
};

export type ProjectionType<T> = { [K in keyof T]?: 0 | 1 } & { [key: string]: any };

// ─── SchemaType Classes ───────────────────────────────────────────────────────

export class SchemaType {
  path: string;
  instance: string;
  options: AnyObject;
  validators: Array<{ validator: (v: any) => boolean; message: string; type: string }>;
  _defaultValue: any;

  default(val: any): this;
  required(required: boolean | [boolean, string], message?: string): this;
  validate(obj: ((v: any) => boolean) | { validator: (v: any) => boolean; message?: string }, errorMsg?: string, type?: string): this;
  enum(values: any[] | AnyObject): this;
  cast(val: any): any;
  doValidate(value: any, fn: (err: Error | null) => void, scope: any): void;
}

export class StringSchemaType extends SchemaType {
  minlength(val: number | [number, string]): this;
  maxlength(val: number | [number, string]): this;
  match(regExp: RegExp | [RegExp, string]): this;
}
export class NumberSchemaType extends SchemaType {
  min(val: number | [number, string]): this;
  max(val: number | [number, string]): this;
}
export class BooleanSchemaType extends SchemaType {}
export class DateSchemaType extends SchemaType {
  min(val: Date | string): this;
  max(val: Date | string): this;
}
export class ObjectIdSchemaType extends SchemaType {}
export class ArraySchemaType extends SchemaType {}
export class MixedSchemaType extends SchemaType {}
export class BufferSchemaType extends SchemaType {}
export class MapSchemaType extends SchemaType {}

// ─── SchemaTypes Registry ────────────────────────────────────────────────────

export const SchemaTypes: {
  String: typeof StringSchemaType;
  Number: typeof NumberSchemaType;
  Boolean: typeof BooleanSchemaType;
  Bool: typeof BooleanSchemaType;
  Date: typeof DateSchemaType;
  ObjectId: typeof ObjectIdSchemaType;
  ObjectID: typeof ObjectIdSchemaType;
  Oid: typeof ObjectIdSchemaType;
  Array: typeof ArraySchemaType;
  Mixed: typeof MixedSchemaType;
  Object: typeof MixedSchemaType;
  Buffer: typeof BufferSchemaType;
  Map: typeof MapSchemaType;
  resolve(type: any): typeof SchemaType;
};

// ─── Schema Definition Types ─────────────────────────────────────────────────

export type SchemaTypeOpts<T> = {
  type?: any;
  required?: boolean | string | [boolean, string];
  default?: T | (() => T);
  unique?: boolean;
  index?: boolean | AnyObject;
  sparse?: boolean;
  enum?: T[];
  validate?: ((v: T) => boolean) | { validator: (v: T) => boolean; message?: string };
  ref?: string;
  trim?: boolean;
  lowercase?: boolean;
  uppercase?: boolean;
  minlength?: number | [number, string];
  maxlength?: number | [number, string];
  match?: RegExp | [RegExp, string];
  min?: T extends number ? number | [number, string] : never;
  max?: T extends number ? number | [number, string] : never;
  immutable?: boolean;
  select?: boolean;
  get?: (v: T) => any;
  set?: (v: T) => T;
  alias?: string;
  [key: string]: any;
};

export type SchemaDefinitionProperty<T = any> =
  | null
  | typeof String
  | typeof Number
  | typeof Boolean
  | typeof Date
  | typeof Buffer
  | typeof Map
  | typeof ObjectId
  | 'String' | 'Number' | 'Boolean' | 'Date' | 'Array' | 'Mixed' | 'ObjectId' | 'ObjectID'
  | SchemaTypeOpts<T>
  | SchemaDefinitionProperty<T>[]
  | SchemaDefinition;

export type SchemaDefinition<T = any> = {
  [K in keyof T]?: SchemaDefinitionProperty<T[K]>;
};

// ─── Schema Options ───────────────────────────────────────────────────────────

export interface SchemaOptions {
  timestamps?: boolean | { createdAt?: string; updatedAt?: string };
  versionKey?: string | false;
  id?: boolean;
  _id?: boolean;
  strict?: boolean;
  autoIndex?: boolean;
  collection?: string | null;
  toJSON?: { virtuals?: boolean; [key: string]: any };
  toObject?: { virtuals?: boolean; [key: string]: any };
  bufferTimeoutMS?: number;
  [key: string]: any;
}

// ─── Populate Options ────────────────────────────────────────────────────────

export interface PopulateOptions {
  path: string;
  select?: string | AnyObject;
  model?: string;
  match?: AnyObject;
  populate?: PopulateOptions | PopulateOptions[];
}

// ─── Schema Class ─────────────────────────────────────────────────────────────

export class Schema<DocType = any, InstanceMethods = AnyObject, StaticMethods = AnyObject> {
  obj: AnyObject;
  paths: Record<string, SchemaType>;
  virtuals: Record<string, { get: (() => any) | null; set: ((v: any) => void) | null; options?: AnyObject }>;
  methods: Record<string, Function>;
  statics: Record<string, Function>;
  query: Record<string, Function>;
  _hooks: { pre: Record<string, Function[]>; post: Record<string, Function[]> };
  _indexes: Array<{ fields: AnyObject; options: AnyObject }>;
  options: Required<SchemaOptions>;
  childSchemas: Array<{ schema: Schema; model: { path: string } }>;

  constructor(definition?: SchemaDefinition<DocType>, options?: SchemaOptions);

  // Path management
  path(path: string): SchemaType | null;
  path(path: string, obj: any): this;

  // Virtuals
  virtual(name: string, options?: { ref: string; localField: string; foreignField: string; justOne?: boolean; [key: string]: any }): {
    get(fn: (this: Document<DocType> & DocType) => any): this;
    set(fn: (this: Document<DocType> & DocType, v: any) => void): this;
  };

  // Middleware / Hooks
  pre(event: string | RegExp, fn: (this: Document<DocType> & DocType, next: (err?: Error) => void) => void | Promise<void>): this;
  post(event: string | RegExp, fn: (this: Document<DocType> & DocType, next?: (err?: Error) => void) => void | Promise<void>): this;
  getHooks(type: 'pre' | 'post', event: string): Function[];

  // Indexes
  index(fields: AnyObject, options?: AnyObject): this;
  indexes(): Array<[AnyObject, AnyObject]>;

  // Plugins
  plugin(fn: (schema: Schema, opts?: any) => void, opts?: any): this;

  // Collection
  collectionName(modelName: string): string;

  // Validation
  validate(data: AnyObject, isUpdate?: boolean): Promise<AnyObject>;

  static Types: typeof SchemaTypes;
  static ObjectId: typeof ObjectIdSchemaType;
}

// ─── Document Class ───────────────────────────────────────────────────────────

export class Document<DocType = any> {
  _id: ObjectId;
  errors: Record<string, any>;

  constructor(data?: Partial<DocType>, schema?: Schema, model?: any);

  get(path: string): any;
  set(path: string, value: any): this;

  isModified(path?: string): boolean;
  markModified(path: string): this;
  isNew(): boolean;

  validate(): Promise<this>;
  save(): Promise<this>;
  remove(): Promise<this>;
  deleteOne(): Promise<this>;

  populate(path: string | PopulateOptions): Promise<this>;

  toObject(options?: { virtuals?: boolean; [key: string]: any }): AnyObject;
  toJSON(options?: AnyObject): AnyObject;
  toString(): string;
  inspect(): AnyObject;
}

// ─── Query Class ─────────────────────────────────────────────────────────────

export class Query<ResultType = any, DocType = any> implements Promise<ResultType> {
  readonly [Symbol.toStringTag]: string;

  readonly model: ModelType<DocType>;
  readonly op: string;
  /** Set by pre-hooks for timing; read by post-hooks. Mirrors Mongoose behaviour used by mongoose-monitor. */
  _startTime: number | null;
  /** Alias for op — Mongoose-compatible query type identifier */
  readonly mongooseQueryType: string;
  /** Database name of this query's model — for middleware/logging use */
  readonly _dbName: string;
  /** Collection name of this query's model — for middleware/logging use */
  readonly _collectionName: string;

  getQuery(): FilterQuery<DocType>;
  getFilter(): FilterQuery<DocType>;

  // Chainable modifiers
  select(fields: string | ProjectionType<DocType>): this;
  sort(arg: string | AnyObject): this;
  limit(n: number): this;
  skip(n: number): this;
  lean(val?: boolean): Query<AnyObject[], DocType>;
  hint(h: AnyObject): this;
  maxTimeMS(ms: number): this;
  comment(c: string): this;
  collation(c: AnyObject): this;
  where(path: string | AnyObject, val?: any): this;
  populate(path: string | PopulateOptions, select?: string | AnyObject): this;
  distinct(field: string): this;
  countDocuments(): Query<number, DocType>;

  // Execution
  exec(): Promise<ResultType>;
  then<TResult1 = ResultType, TResult2 = never>(
    onfulfilled?: ((value: ResultType) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2>;
  catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null): Promise<ResultType | TResult>;
  finally(onfinally?: (() => void) | null): Promise<ResultType>;

  cursor(): any;
}

// ─── Aggregate Class ──────────────────────────────────────────────────────────

export class Aggregate<ResultType = any[]> implements Promise<ResultType> {
  readonly [Symbol.toStringTag]: string;

  constructor(model: any, pipeline?: AnyObject[], options?: AnyObject);

  append(...stages: AnyObject[]): this;
  match(obj: AnyObject): this;
  group(obj: AnyObject): this;
  sort(obj: AnyObject): this;
  project(obj: AnyObject): this;
  limit(n: number): this;
  skip(n: number): this;
  unwind(path: string | AnyObject): this;
  lookup(obj: AnyObject): this;
  addFields(obj: AnyObject): this;
  count(field?: string): this;
  facet(obj: AnyObject): this;
  sample(size: number): this;
  replaceRoot(obj: AnyObject): this;
  option(key: string | AnyObject, val?: any): this;
  pipeline(): AnyObject[];

  exec(): Promise<ResultType>;
  then<TResult1 = ResultType, TResult2 = never>(
    onfulfilled?: ((value: ResultType) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2>;
  catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null): Promise<ResultType | TResult>;
  finally(onfinally?: (() => void) | null): Promise<ResultType>;
}

// ─── Paginate Options & Result ────────────────────────────────────────────────

export interface PaginateOptions {
  page?: number;
  limit?: number;
  sort?: string | AnyObject;
  select?: string | AnyObject;
  populate?: string | PopulateOptions | Array<string | PopulateOptions>;
  lean?: boolean;
  leanWithId?: boolean;
  pagination?: boolean;
  projection?: AnyObject;
  collation?: AnyObject;
  customLabels?: {
    docs?: string;
    totalDocs?: string;
    limit?: string;
    page?: string;
    totalPages?: string;
    nextPage?: string;
    prevPage?: string;
    pagingCounter?: string;
    hasPrevPage?: string;
    hasNextPage?: string;
    meta?: string;
    [key: string]: string | undefined;
  };
}

export interface PaginateResult<DocType> {
  docs: DocType[];
  totalDocs: number;
  limit: number;
  page: number;
  totalPages: number;
  hasPrevPage: boolean;
  hasNextPage: boolean;
  prevPage: number | null;
  nextPage: number | null;
  pagingCounter: number;
  [key: string]: any;
}

// ─── Model Type ───────────────────────────────────────────────────────────────

export type ModelType<DocType, InstanceMethods = AnyObject, QueryHelpers = AnyObject> = {
  new(data?: Partial<DocType>): Document<DocType> & DocType & InstanceMethods;

  modelName: string;
  schema: Schema<DocType>;
  base: Connection;
  collection: Collection;
  db: Db;

  _waitForConnection(): Promise<void>;
  ensureIndexes(): Promise<void>;

  // CRUD
  create(docs: Partial<DocType>): Promise<Document<DocType> & DocType>;
  create(docs: Partial<DocType>[]): Promise<Array<Document<DocType> & DocType>>;
  insertMany(docs: Partial<DocType>[], options?: AnyObject): Promise<Array<Document<DocType> & DocType>>;

  find(filter?: FilterQuery<DocType>, projection?: ProjectionType<DocType> | string | null, options?: AnyObject): Query<Array<Document<DocType> & DocType>, DocType> & QueryHelpers;
  findOne(filter?: FilterQuery<DocType>, projection?: ProjectionType<DocType> | string | null): Query<(Document<DocType> & DocType) | null, DocType> & QueryHelpers;
  findById(id: any, projection?: ProjectionType<DocType> | string | null): Query<(Document<DocType> & DocType) | null, DocType>;

  findByIdAndUpdate(id: any, update: UpdateQuery<DocType>, options?: AnyObject): Promise<(Document<DocType> & DocType) | null>;
  findOneAndUpdate(filter: FilterQuery<DocType>, update: UpdateQuery<DocType>, options?: AnyObject): Promise<(Document<DocType> & DocType) | null>;
  findOneAndReplace(filter: FilterQuery<DocType>, replacement: Partial<DocType>, options?: AnyObject): Promise<(Document<DocType> & DocType) | null>;
  findByIdAndDelete(id: any, options?: AnyObject): Promise<(Document<DocType> & DocType) | null>;
  findByIdAndRemove(id: any, options?: AnyObject): Promise<(Document<DocType> & DocType) | null>;
  findOneAndDelete(filter: FilterQuery<DocType>, options?: AnyObject): Promise<(Document<DocType> & DocType) | null>;
  findOneAndRemove(filter: FilterQuery<DocType>, options?: AnyObject): Promise<(Document<DocType> & DocType) | null>;

  updateOne(filter: FilterQuery<DocType>, update: UpdateQuery<DocType>, options?: AnyObject): Query<any, DocType>;
  updateMany(filter: FilterQuery<DocType>, update: UpdateQuery<DocType>, options?: AnyObject): Query<any, DocType>;
  replaceOne(filter: FilterQuery<DocType>, replacement: Partial<DocType>, options?: AnyObject): Promise<any>;

  deleteOne(filter?: FilterQuery<DocType>): Query<any, DocType>;
  deleteMany(filter?: FilterQuery<DocType>): Query<any, DocType>;
  remove(filter?: FilterQuery<DocType>): Query<any, DocType>;

  countDocuments(filter?: FilterQuery<DocType>): Query<number, DocType>;
  estimatedDocumentCount(): Promise<number>;
  exists(filter: FilterQuery<DocType>): Promise<{ _id: ObjectId } | null>;
  distinct(field: string, filter?: FilterQuery<DocType>): Query<any[], DocType>;

  aggregate(pipeline?: AnyObject[], options?: AnyObject): Aggregate;

  watch(pipeline?: AnyObject[], options?: AnyObject): any;
  bulkWrite(ops: AnyObject[], options?: AnyObject): Promise<any>;

  populate(docs: any | any[], options: string | PopulateOptions): Promise<any>;

  // Pagination
  paginate(filter?: FilterQuery<DocType>, options?: PaginateOptions): Promise<PaginateResult<Document<DocType> & DocType>>;
  aggregatePaginate(aggregate: Aggregate | AnyObject[], options?: AnyObject): Promise<any>;

  _populateDoc(doc: any, opts: PopulateOptions | string): Promise<void>;
} & InstanceMethods & { [key: string]: any };

// ─── Connection States ────────────────────────────────────────────────────────

export interface ConnectionStates {
  disconnected: 0;
  connected: 1;
  connecting: 2;
  disconnecting: 3;
}

// ─── Connection Class ─────────────────────────────────────────────────────────

export class Connection extends EventEmitter {
  client: MongoClient | null;
  db: Db | null;
  readyState: 0 | 1 | 2 | 3;
  STATES: ConnectionStates;

  readonly name: string;
  readonly host: string;
  readonly port: number;

  connect(uri: string, options?: AnyObject): Promise<this>;
  disconnect(): Promise<this>;
  close(force?: boolean): Promise<this>;

  getDb(): Db;
  collection(name: string): Collection;

  /**
   * Map of collection-name → Collection for all model-registered collections.
   * Mirrors Mongoose's `connection.collections` — safe to use in `for..in` loops.
   *
   * ```ts
   * const cols = mongoose.connection.collections;
   * for (const key in cols) { await cols[key].deleteMany({}); }
   * ```
   */
  readonly collections: Record<string, Collection>;

  /**
   * Async version — returns Collection objects for *every* collection that
   * actually exists in the database. Useful for test teardown:
   *
   * ```ts
   * for (const col of await mongoose.connection.listCollections()) {
   *   await col.deleteMany({});
   * }
   * ```
   */
  listCollections(filter?: AnyObject): Promise<Collection[]>;

  model<DocType = any>(name: string): ModelType<DocType>;
  model<DocType = any>(name: string, schema: Schema<DocType>, collectionName?: string): ModelType<DocType>;

  createConnection(uri?: string, options?: AnyObject): Connection;
  useDb(dbName: string): this;
  dropDatabase(): Promise<any>;
  startSession(options?: AnyObject): Promise<ClientSession>;
  withTransaction<T = any>(fn: (session: ClientSession) => Promise<T>, options?: AnyObject): Promise<T>;
}

// ─── Mongoosify (default export) ──────────────────────────────────────────────

export interface Mongoosify {
  // Connection
  connect(uri: string, options?: AnyObject): Promise<Mongoosify>;
  disconnect(): Promise<Connection>;
  createConnection(uri?: string, options?: AnyObject): Connection;
  readonly connection: Connection;
  readonly connections: Connection[];

  // Model registry
  model<DocType = any, InstanceMethods = AnyObject, QueryHelpers = AnyObject>(
    name: string
  ): ModelType<DocType, InstanceMethods, QueryHelpers>;
  model<DocType = any, InstanceMethods = AnyObject, QueryHelpers = AnyObject>(
    name: string,
    schema: Schema<DocType, InstanceMethods>,
    collectionName?: string
  ): ModelType<DocType, InstanceMethods, QueryHelpers>;

  modelNames(): string[];

  // Classes
  Schema: typeof Schema;
  SchemaTypes: typeof SchemaTypes;
  Document: typeof Document;
  Query: typeof Query;

  // Types
  readonly Types: {
    ObjectId: typeof ObjectId;
    String: typeof StringSchemaType;
    Number: typeof NumberSchemaType;
    Boolean: typeof BooleanSchemaType;
    Array: typeof ArraySchemaType;
    Buffer: typeof BufferSchemaType;
    Date: typeof DateSchemaType;
    Mixed: typeof MixedSchemaType;
    Map: typeof MapSchemaType;
  };
  readonly ObjectId: typeof ObjectId;

  // Settings
  set(key: string, value: any): this;
  get(key: string): any;

  // readyState
  readonly readyState: 0 | 1 | 2 | 3;
  STATES: ConnectionStates;

  // Events
  on(event: string, fn: (...args: any[]) => void): this;
  once(event: string, fn: (...args: any[]) => void): this;
  off(event: string, fn: (...args: any[]) => void): this;

  // Transactions
  startSession(options?: AnyObject): Promise<ClientSession>;
  withTransaction<T = any>(fn: (session: ClientSession) => Promise<T>, options?: AnyObject): Promise<T>;

  // Plugins
  plugin(fn: (schema: Schema, opts?: any) => void, opts?: any): this;

  // Helpers
  isValidObjectId(id: any): boolean;
  isObjectIdOrHexString(id: any): boolean;
}

declare const mongoosify: Mongoosify;
export default mongoosify;
export = mongoosify;

// ─── Named exports ────────────────────────────────────────────────────────────
// Allows both import styles:
//   import mongoose from 'varadharajcredopay'
//   import { Schema, model, ObjectId, SchemaTypes, Document, Query } from 'varadharajcredopay'

export { Schema };
export { SchemaTypes };
export { Document };
export { Query };
export { ObjectId };

/** Named model() — same as mongoose.model() */
export declare function model<
  DocType = any,
  InstanceMethods = AnyObject,
  QueryHelpers = AnyObject
>(
  name: string,
  schema?: Schema<DocType, InstanceMethods>,
  collectionName?: string
): ModelType<DocType, InstanceMethods, QueryHelpers>;

/** Named connect() */
export declare function connect(uri: string, options?: AnyObject): Promise<Mongoosify>;

/** Named disconnect() */
export declare function disconnect(): Promise<Connection>;