'use strict';

const { ObjectId } = require('mongodb');
const { sanitize, isObjectIdLike, toDriverObjectId } = require('./bson-sanitize');

class Query {
  constructor(model, op, filter = {}) {
    this._model      = model;
    this._op         = op;         // 'find' | 'findOne' | 'count' | 'deleteOne' | 'deleteMany' | 'updateOne' | 'updateMany'
    this._filter     = filter;
    this._update     = null;
    this._projection = null;
    this._sort       = null;
    this._limit      = null;
    this._skip       = null;
    this._lean       = false;
    this._populate   = [];
    this._hint       = null;
    this._maxTimeMS  = null;
    this._comment    = null;
    this._distinct   = null;
    this._updateOptions = {};
    this._collation  = null;

    this._executed   = false;
    this._promise    = null;

    // Timing support — for mongoose-monitor style: pre hook sets _startTime, post hook reads it
    this._startTime  = null;

    // mongooseQueryType — Mongoose-compatible property used by some middleware
    this.mongooseQueryType = op;
  }

  // ─── Mongoose-monitor compatibility getters ───────────────────────────────

  /** Returns the database name — mirrors Mongoose's query.model.db.name */
  get _dbName() {
    try { return this._model.db.databaseName || this._model.db.name || ''; } catch { return ''; }
  }

  /** Returns the collection name — mirrors Mongoose's query.model.collection.name */
  get _collectionName() {
    try { return this._model.collection.collectionName || this._model.collection.name || ''; } catch { return ''; }
  }

  // ─── Mongoose-compatible property accessors ───────────────────────────────

  /** mongoose.Query compatibility: this.model gives the Model */
  get model() {
    return this._model;
  }

  /** mongoose.Query compatibility: this.op gives the operation name */
  get op() {
    return this._op;
  }

  // ─── getQuery() / getFilter() — Mongoose compatibility ───────────────────

  /** Returns the current filter/query conditions (Mongoose-compatible) */
  getQuery() {
    return this._filter;
  }

  /** Alias for getQuery() */
  getFilter() {
    return this._filter;
  }

  // ─── Chainable methods ────────────────────────────────────────────────────

  select(fields) {
    if (!fields) return this;
    if (typeof fields === 'string') {
      this._projection = {};
      for (const f of fields.trim().split(/\s+/)) {
        if (!f) continue;
        if (f.startsWith('-')) this._projection[f.slice(1)] = 0;
        else this._projection[f] = 1;
      }
    } else if (fields && typeof fields === 'object') {
      this._projection = fields;
    }
    return this;
  }

  sort(arg) {
    if (!arg) return this;
    if (typeof arg === 'string') {
      this._sort = {};
      for (const f of arg.trim().split(/\s+/)) {
        if (!f) continue;
        if (f.startsWith('-')) this._sort[f.slice(1)] = -1;
        else this._sort[f] = 1;
      }
    } else {
      this._sort = arg;
    }
    return this;
  }

  limit(n) { this._limit = n; return this; }
  skip(n)  { this._skip  = n; return this; }

  lean(val = true) { this._lean = val; return this; }

  hint(h) { this._hint = h; return this; }

  maxTimeMS(ms) { this._maxTimeMS = ms; return this; }

  comment(c) { this._comment = c; return this; }

  collation(c) { this._collation = c; return this; }

  where(path, val) {
    if (typeof path === 'object') {
      Object.assign(this._filter, path);
    } else if (val !== undefined) {
      this._filter[path] = val;
    }
    return this;
  }

  populate(path, select) {
    if (typeof path === 'string') {
      this._populate.push({ path, select });
    } else if (Array.isArray(path)) {
      for (const p of path) {
        if (typeof p === 'string') this._populate.push({ path: p });
        else if (p && typeof p === 'object') this._populate.push(p);
      }
    } else if (path && typeof path === 'object') {
      this._populate.push(path);
    }
    return this;
  }

  distinct(field) { this._distinct = field; return this; }

  /**
   * Chain .countDocuments() on a find query — like Mongoose allows:
   *   Model.find(query).countDocuments()
   */
  countDocuments() {
    this._op = 'countDocuments';
    // Reset promise so it re-executes with new op
    this._promise = null;
    return this;
  }

  // ─── Update-query helpers ──────────────────������─────────────────────────────

  setUpdate(update, options = {}) {
    this._update = update;
    this._updateOptions = options;
    return this;
  }

  // ─── exec() ──────────────────────────────────────────────────────────────

  exec() {
    if (!this._promise) this._promise = this._execute();
    return this._promise;
  }

  then(resolve, reject) { return this.exec().then(resolve, reject); }
  catch(fn) { return this.exec().catch(fn); }
  finally(fn) { return this.exec().finally(fn); }

  // Symbol.toPrimitive and async iterator not needed but adding toJSON for safety
  toJSON() { return this.exec(); }

  async _execute() {
    // Buffer: wait for connection if not yet connected
    await this._model._waitForConnection();

    // Run pre-query hooks (schema.pre('find', fn), schema.pre(/.*/, fn), etc.)
    await this._runQueryHooks('pre', this._op);

    let result;
    switch (this._op) {
      case 'find':           result = await this._execFind(); break;
      case 'findOne':        result = await this._execFindOne(); break;
      case 'count':
      case 'countDocuments': result = await this._execCount(); break;
      case 'deleteOne':      result = await this._model.collection.deleteOne(this._filter); break;
      case 'deleteMany':     result = await this._model.collection.deleteMany(this._filter); break;
      case 'updateOne':      result = await this._model.collection.updateOne(this._filter, this._update, this._updateOptions); break;
      case 'updateMany':     result = await this._model.collection.updateMany(this._filter, this._update, this._updateOptions); break;
      case 'distinct':       result = await this._model.collection.distinct(this._distinct, this._filter); break;
      default: throw new Error(`Unknown query operation: ${this._op}`);
    }

    // Run post-query hooks — result is passed as first arg (Mongoose-compatible)
    await this._runQueryHooks('post', this._op, result);

    return result;
  }

  // ─── Query-level hook runner ──────────────────────────────────────────────
  // Runs schema pre/post hooks with `this` set to the Query instance.
  // Supports both exact-match and regex hooks (getHooks).

  async _runQueryHooks(type, event, result) {
    const schema = this._model && this._model.schema;
    if (!schema) return;

    const hooks = schema.getHooks
      ? schema.getHooks(type, event)
      : (schema._hooks[type][event] || []);

    for (const fn of hooks) {
      await new Promise((resolve, reject) => {
        // post hooks receive result as first arg; pre hooks receive only next
        const args = type === 'post'
          ? [result, (err) => { if (err) reject(err); else resolve(); }]
          : [(err) => { if (err) reject(err); else resolve(); }];
        const ret = fn.apply(this, args);
        if (ret && typeof ret.then === 'function') ret.then(resolve).catch(reject);
        else if (fn.length === 0) resolve();
      });
    }
  }

  async _execFind() {
    let cursor = this._model.collection.find(this._filter);
    if (this._projection) cursor = cursor.project(this._projection);
    if (this._sort)       cursor = cursor.sort(this._sort);
    if (this._skip)       cursor = cursor.skip(this._skip);
    if (this._limit)      cursor = cursor.limit(this._limit);
    if (this._hint)       cursor = cursor.hint(this._hint);
    if (this._maxTimeMS)  cursor = cursor.maxTimeMS(this._maxTimeMS);
    if (this._comment)    cursor = cursor.comment(this._comment);
    if (this._collation)  cursor = cursor.collation(this._collation);

    const docs = await cursor.toArray();

    if (this._lean) return docs;

    const Document = require('./document');
    const results = docs.map(d => new Document(d, this._model.schema, this._model));

    // Populate
    for (const pop of this._populate) {
      for (const doc of results) {
        await this._model._populateDoc(doc, pop);
      }
    }

    return results;
  }

  async _execFindOne() {
    const opts = {};
    if (this._projection) opts.projection = this._projection;
    if (this._sort)       opts.sort = this._sort;
    if (this._skip)       opts.skip = this._skip;
    if (this._collation)  opts.collation = this._collation;

    const doc = await this._model.collection.findOne(this._filter, opts);
    if (!doc) return null;

    if (this._lean) return doc;

    const Document = require('./document');
    const result = new Document(doc, this._model.schema, this._model);

    for (const pop of this._populate) {
      await this._model._populateDoc(result, pop);
    }

    return result;
  }

  async _execCount() {
    return this._model.collection.countDocuments(this._filter);
  }

  // ─── Cursor-based iteration ───────────────────────────────────────────────

  cursor() {
    return this._model.collection.find(this._filter);
  }
}

module.exports = Query;