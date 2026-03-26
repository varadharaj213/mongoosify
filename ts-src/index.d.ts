/// <reference types="node" />

import { EventEmitter } from 'events';
import { ObjectId, ClientSession, Collection, Db, MongoClient } from 'mongodb';

// ─── Utility Types ────────────────────────────────────────────────────────────

export type AnyObject = Record<string, any>;

/** Recursively makes all properties optional */
export type DeepPartial<T> = { [K in keyof T]?: DeepPartial<T[K]> };

/** Strip methods and virtuals to get plain data keys */
export type DocData<T> = Omit<T, keyof MongoosifyDocument<T>>;

/** MongoDB filter type — fully permissive to accept dot-notation, operators, and loose types */
export type FilterQuery<T> = {
  [K in keyof T]?: any;
} & { [key: string]: any };

/**
 * MongoDB update type.
 * The operator sub-documents use `AnyObject` so dot-notation paths like
 * `"exhaustedLimit.transaction_limits.$.daily"` are accepted without error.
 */
export type UpdateQuery<T> = {
  $set?: AnyObject;
  $unset?: AnyObject;
  $inc?: AnyObject;
  $push?: AnyObject;
  $pull?: AnyObject;
  $addToSet?: AnyObject;
  $min?: AnyObject;
  $max?: AnyObject;
  $mul?: AnyObject;
  $rename?: AnyObject;
  $bit?: AnyObject;
  $currentDate?: AnyObject;
  [op: string]: any;
};

/** Projection — accepts both known keys, dot-notation strings, and MongoDB projection operators like $elemMatch */
export type ProjectionType<T> = { [K in keyof T]?: 0 | 1 | AnyObject } & { [key: string]: any };

// ─── SchemaType Classes ───────────────────────────────────────────────────────

export class SchemaType {
  path: string;
  instance: string;
  options: AnyObject;
  validators: Array<{ validator: (v: any) => boolean; message: string; type: string }>;
  _defaultValue: any;

  default(val: any): SchemaType;
  required(required: boolean | [boolean, string], message?: string): SchemaType;
  validate(
    obj: ((v: any) => boolean) | { validator: (v: any) => boolean; message?: string },
    errorMsg?: string,
    type?: string,
  ): SchemaType;
  enum(values: any[] | AnyObject): SchemaType;
  cast(val: any): any;
  doValidate(value: any, fn: (err: Error | null) => void, scope: any): void;
}

export class StringSchemaType extends SchemaType {
  minlength(val: number | [number, string]): StringSchemaType;
  maxlength(val: number | [number, string]): StringSchemaType;
  match(regExp: RegExp | [RegExp, string]): StringSchemaType;
}
export class NumberSchemaType extends SchemaType {
  min(val: number | [number, string]): NumberSchemaType;
  max(val: number | [number, string]): NumberSchemaType;
}
export class BooleanSchemaType extends SchemaType {}
export class DateSchemaType extends SchemaType {
  min(val: Date | string): DateSchemaType;
  max(val: Date | string): DateSchemaType;
}
export class ObjectIdSchemaType extends SchemaType {}
export class ArraySchemaType extends SchemaType {}
export class MixedSchemaType extends SchemaType {}
export class BufferSchemaType extends SchemaType {}
export class MapSchemaType extends SchemaType {}

// ─── SchemaTypes Registry ────────────────────────────────────────────────────

export declare const SchemaTypes: {
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

export type SchemaTypeOpts<T = any> = {
  type?: any;
  required?: boolean | string | [boolean, string];
  default?: T | (() => T);
  unique?: boolean;
  index?: boolean | AnyObject;
  sparse?: boolean;
  enum?: any[];
  validate?: ((v: T) => boolean) | { validator: (v: T) => boolean; message?: string };
  ref?: string;
  trim?: boolean;
  lowercase?: boolean;
  uppercase?: boolean;
  minlength?: number | [number, string];
  maxlength?: number | [number, string];
  match?: RegExp | [RegExp, string];
  min?: number | [number, string];
  max?: number | [number, string];
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
  | SchemaTypeOpts<any>
  | SchemaDefinitionProperty<any>[]
  | SchemaDefinition
  | any;

export type SchemaDefinition<T = any> = {
  [K in keyof T]?: SchemaDefinitionProperty<T[K]>;
} & { [key: string]: any };

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

export declare class Schema<DocType = any, InstanceMethods = AnyObject, StaticMethods = AnyObject> {
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

  constructor(definition?: SchemaDefinition<DocType> | AnyObject, options?: SchemaOptions);

  // Path management
  path(path: string): SchemaType | null;
  path(path: string, obj: any): Schema<DocType, InstanceMethods, StaticMethods>;

  // Virtuals
  virtual(
    name: string,
    options?: { ref: string; localField: string; foreignField: string; justOne?: boolean; [key: string]: any },
  ): {
    get(fn: (...args: any[]) => any): any;
    set(fn: (...args: any[]) => void): any;
  };

  // Middleware / Hooks
  pre(event: string | RegExp, fn: (this: any, ...args: any[]) => void | Promise<void>): Schema<DocType, InstanceMethods, StaticMethods>;
  post(event: string | RegExp, fn: (this: any, ...args: any[]) => void | Promise<void>): Schema<DocType, InstanceMethods, StaticMethods>;
  getHooks(type: 'pre' | 'post', event: string): Function[];

  // Indexes
  index(fields: AnyObject, options?: AnyObject): Schema<DocType, InstanceMethods, StaticMethods>;
  indexes(): Array<[AnyObject, AnyObject]>;

  // Plugins
  plugin(fn: (schema: Schema, opts?: any) => void, opts?: any): Schema<DocType, InstanceMethods, StaticMethods>;

  // Collection
  collectionName(modelName: string): string;

  // Validation
  validate(data: AnyObject, isUpdate?: boolean): Promise<AnyObject>;
}

// Schema namespace — merged with the class declaration above.
// Provides Schema.Types.ObjectId usable both as a value and as a type.
export declare namespace Schema {
  namespace Types {
    type ObjectId = import('mongodb').ObjectId;
    const ObjectId: typeof ObjectIdSchemaType;
    const ObjectID: typeof ObjectIdSchemaType;
    const String: typeof StringSchemaType;
    const Number: typeof NumberSchemaType;
    const Boolean: typeof BooleanSchemaType;
    const Bool: typeof BooleanSchemaType;
    const Date: typeof DateSchemaType;
    const Oid: typeof ObjectIdSchemaType;
    const Array: typeof ArraySchemaType;
    const Mixed: typeof MixedSchemaType;
    const Buffer: typeof BufferSchemaType;
    const Map: typeof MapSchemaType;
    function resolve(type: any): typeof SchemaType;
  }
  type ObjectId = import('mongodb').ObjectId;
}

// ─── Document Class ───────────────────────────────────────────────────────────
// Renamed to MongoosifyDocument internally to avoid clashing with the global
// `Document` interface that TypeScript/DOM provides.

export declare class MongoosifyDocument<DocType = any> {
  _id: ObjectId;
  id?: any;
  errors: Record<string, any>;

  constructor(data?: Partial<DocType>, schema?: Schema, model?: any);

  get(path: string): any;
  set(path: string, value: any): MongoosifyDocument<DocType>;

  isModified(path?: string): boolean;
  markModified(path: string): MongoosifyDocument<DocType>;
  isNew(): boolean;

  validate(): Promise<MongoosifyDocument<DocType> & DocType>;
  save(): Promise<MongoosifyDocument<DocType> & DocType>;
  remove(): Promise<MongoosifyDocument<DocType> & DocType>;
  deleteOne(): Promise<MongoosifyDocument<DocType> & DocType>;

  populate(path: string | PopulateOptions): Promise<MongoosifyDocument<DocType> & DocType>;

  toObject(options?: { virtuals?: boolean; [key: string]: any }): any;
  toJSON(options?: AnyObject): any;
  toString(): string;
  inspect(): AnyObject;
}

// Keep the export name as `Document` for backward-compat with consumer code
// that does `import { Document } from 'varadharajcredopay'`.
export { MongoosifyDocument as Document };

// ─── Query Class ─────────────────────────────────────────────────────────────

export declare class Query<ResultType = any, DocType = any> implements Promise<ResultType> {
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
  select(fields: string | ProjectionType<DocType>): Query<ResultType, DocType>;
  sort(arg: string | AnyObject): Query<ResultType, DocType>;
  limit(n: number): Query<ResultType, DocType>;
  skip(n: number): Query<ResultType, DocType>;
  lean(val?: boolean): Query<any, DocType>;
  hint(h: AnyObject): Query<ResultType, DocType>;
  maxTimeMS(ms: number): Query<ResultType, DocType>;
  comment(c: string): Query<ResultType, DocType>;
  collation(c: AnyObject): Query<ResultType, DocType>;
  where(path: string | AnyObject, val?: any): Query<ResultType, DocType>;
  populate(path: string | PopulateOptions | Array<string | PopulateOptions>, select?: string | AnyObject): Query<ResultType, DocType>;
  distinct(field: string): Query<ResultType, DocType>;
  countDocuments(): Query<number, DocType>;

  // Execution
  exec(): Promise<ResultType>;
  then<TResult1 = ResultType, TResult2 = never>(
    onfulfilled?: ((value: ResultType) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null,
  ): Promise<ResultType | TResult>;
  finally(onfinally?: (() => void) | null): Promise<ResultType>;

  cursor(): any;
}

// ─── Aggregate Class ──────────────────────────────────────────────────────────

export declare class Aggregate<ResultType = any[]> implements Promise<ResultType> {
  readonly [Symbol.toStringTag]: string;

  constructor(model: any, pipeline?: AnyObject[], options?: AnyObject);

  append(...stages: AnyObject[]): Aggregate<ResultType>;
  match(obj: AnyObject): Aggregate<ResultType>;
  group(obj: AnyObject): Aggregate<ResultType>;
  sort(obj: AnyObject): Aggregate<ResultType>;
  project(obj: AnyObject): Aggregate<ResultType>;
  limit(n: number): Aggregate<ResultType>;
  skip(n: number): Aggregate<ResultType>;
  unwind(path: string | AnyObject): Aggregate<ResultType>;
  lookup(obj: AnyObject): Aggregate<ResultType>;
  addFields(obj: AnyObject): Aggregate<ResultType>;
  count(field?: string): Aggregate<ResultType>;
  facet(obj: AnyObject): Aggregate<ResultType>;
  sample(size: number): Aggregate<ResultType>;
  replaceRoot(obj: AnyObject): Aggregate<ResultType>;
  option(key: string | AnyObject, val?: any): Aggregate<ResultType>;
  pipeline(): AnyObject[];

  exec(): Promise<ResultType>;
  then<TResult1 = ResultType, TResult2 = never>(
    onfulfilled?: ((value: ResultType) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null,
  ): Promise<ResultType | TResult>;
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

// ─── Model Type ─────────��─────────────────────────────────────────────────────

export type ModelType<DocType, InstanceMethods = AnyObject, QueryHelpers = AnyObject> = {
  new(data?: Partial<DocType>): MongoosifyDocument<DocType> & DocType & InstanceMethods;

  modelName: string;
  schema: Schema<DocType>;
  base: Connection;
  collection: Collection & { name: string; [key: string]: any };
  db: Db & { name: string; [key: string]: any };

  _waitForConnection(): Promise<void>;
  ensureIndexes(): Promise<void>;

  // CRUD — loosened to accept any object shape for create/insertMany
  create(docs: any): Promise<MongoosifyDocument<DocType> & DocType>;
  create(docs: any[]): Promise<Array<MongoosifyDocument<DocType> & DocType>>;
  insertMany(docs: any | any[], options?: AnyObject): Promise<Array<MongoosifyDocument<DocType> & DocType>>;

  find(
    filter?: FilterQuery<DocType>,
    projection?: ProjectionType<DocType> | string | null,
    options?: AnyObject,
  ): Query<Array<MongoosifyDocument<DocType> & DocType>, DocType> & QueryHelpers;
  findOne(
    filter?: FilterQuery<DocType>,
    projection?: ProjectionType<DocType> | string | null,
  ): Query<(MongoosifyDocument<DocType> & DocType) | null, DocType> & QueryHelpers;
  findById(
    id: any,
    projection?: ProjectionType<DocType> | string | null,
  ): Query<(MongoosifyDocument<DocType> & DocType) | null, DocType>;

  findByIdAndUpdate(
    id: any,
    update: UpdateQuery<DocType>,
    options?: AnyObject,
  ): Query<(MongoosifyDocument<DocType> & DocType) | null, DocType>;
  findOneAndUpdate(
    filter: FilterQuery<DocType>,
    update: UpdateQuery<DocType>,
    options?: AnyObject,
  ): Query<(MongoosifyDocument<DocType> & DocType) | null, DocType>;
  findOneAndReplace(
    filter: FilterQuery<DocType>,
    replacement: Partial<DocType>,
    options?: AnyObject,
  ): Promise<(MongoosifyDocument<DocType> & DocType) | null>;
  findByIdAndDelete(
    id: any,
    options?: AnyObject,
  ): Promise<(MongoosifyDocument<DocType> & DocType) | null>;
  findByIdAndRemove(
    id: any,
    options?: AnyObject,
  ): Promise<(MongoosifyDocument<DocType> & DocType) | null>;
  findOneAndDelete(
    filter: FilterQuery<DocType>,
    options?: AnyObject,
  ): Promise<(MongoosifyDocument<DocType> & DocType) | null>;
  findOneAndRemove(
    filter: FilterQuery<DocType>,
    options?: AnyObject,
  ): Promise<(MongoosifyDocument<DocType> & DocType) | null>;

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
  paginate(
    filter?: FilterQuery<DocType>,
    options?: PaginateOptions,
  ): Promise<PaginateResult<MongoosifyDocument<DocType> & DocType>>;
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

export declare class Connection extends EventEmitter {
  client: MongoClient | null;
  db: Db | null;
  readyState: 0 | 1 | 2 | 3;
  STATES: ConnectionStates;

  readonly name: string;
  readonly host: string;
  readonly port: number;

  connect(uri: string, options?: AnyObject): Promise<Connection>;
  disconnect(): Promise<Connection>;
  close(force?: boolean): Promise<Connection>;

  getDb(): Db;
  collection(name: string): Collection;

  readonly collections: Record<string, Collection>;
  listCollections(filter?: AnyObject): Promise<Collection[]>;

  model<DocType = any>(name: string): ModelType<DocType>;
  model<DocType = any>(name: string, schema: Schema<DocType>, collectionName?: string): ModelType<DocType>;

  createConnection(uri?: string, options?: AnyObject): Connection;
  useDb(dbName: string): Connection;
  dropDatabase(): Promise<any>;
  startSession(options?: AnyObject): Promise<ClientSession>;
  withTransaction<T = any>(fn: (session: ClientSession) => Promise<T>, options?: AnyObject): Promise<T>;
}

// ─── Mongoosify (default export) ──────────────────────────────────────────────

export interface Mongoosify {
  connect(uri: string, options?: AnyObject): Promise<Mongoosify>;
  disconnect(): Promise<Connection>;
  createConnection(uri?: string, options?: AnyObject): Connection;
  readonly connection: Connection;
  readonly connections: Connection[];

  model<DocType = any, InstanceMethods = AnyObject, QueryHelpers = AnyObject>(
    name: string,
  ): ModelType<DocType, InstanceMethods, QueryHelpers>;
  model<DocType = any, InstanceMethods = AnyObject, QueryHelpers = AnyObject>(
    name: string,
    schema: Schema<DocType, InstanceMethods>,
    collectionName?: string,
  ): ModelType<DocType, InstanceMethods, QueryHelpers>;

  modelNames(): string[];

  Schema: typeof Schema;
  SchemaTypes: typeof SchemaTypes;
  Document: typeof MongoosifyDocument;
  Query: typeof Query;

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

  set(key: "debug", value: boolean | ((collectionName: any, method: any, query: any, ...args: any[]) => void)): Mongoosify;
  set(key: string, value: any): Mongoosify;
  get(key: string): any;

  readonly readyState: 0 | 1 | 2 | 3;
  STATES: ConnectionStates;

  on(event: string, fn: (...args: any[]) => void): Mongoosify;
  once(event: string, fn: (...args: any[]) => void): Mongoosify;
  off(event: string, fn: (...args: any[]) => void): Mongoosify;

  startSession(options?: AnyObject): Promise<ClientSession>;
  withTransaction<T = any>(fn: (session: ClientSession) => Promise<T>, options?: AnyObject): Promise<T>;

  plugin(fn: (schema: Schema, opts?: any) => void, opts?: any): Mongoosify;

  isValidObjectId(id: any): boolean;
  isObjectIdOrHexString(id: any): boolean;
}

declare const mongoosify: Mongoosify;
export default mongoosify;

// ─── Named exports ────────────────────────────────────────────────────────────
// Use `export declare function` / `export declare const` exclusively here —
// never re-export a name that was already declared above with `export class`
// or `export const`, which is what caused the TS2323 errors.

export declare function model<
  DocType = any,
  InstanceMethods = AnyObject,
  QueryHelpers = AnyObject
>(
  name: string,
  schema?: Schema<DocType, InstanceMethods>,
  collectionName?: string,
): ModelType<DocType, InstanceMethods, QueryHelpers>;

export declare function connect(uri: string, options?: AnyObject): Promise<Mongoosify>;
export declare function disconnect(): Promise<Connection>;

// Re-export ObjectId from mongodb so consumers can do:
//   import { ObjectId } from 'varadharajcredopay'
export { ObjectId } from 'mongodb';

// ─── Types namespace (mongoose-compat) ────────────────────────────────────────
// Allows: import { Types } from 'varadharajcredopay'
//         new Types.ObjectId(...)           — as a value (constructor)
//         id: string | Types.ObjectId       — as a type
export declare namespace Types {
  type ObjectId = import('mongodb').ObjectId;
  const ObjectId: typeof import('mongodb').ObjectId;
  const String: typeof StringSchemaType;
  const Number: typeof NumberSchemaType;
  const Boolean: typeof BooleanSchemaType;
  const Array: typeof ArraySchemaType;
  const Buffer: typeof BufferSchemaType;
  const Date: typeof DateSchemaType;
  const Mixed: typeof MixedSchemaType;
  const Map: typeof MapSchemaType;
}
