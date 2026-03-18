'use strict';

const { ObjectId } = require('mongodb');

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

    this._executed   = false;
    this._promise    = null;
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
    } else {
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

  where(path, val) {
    if (val !== undefined) this._filter[path] = val;
    return this;
  }

  populate(path, select) {
    if (typeof path === 'string') {
      this._populate.push({ path, select });
    } else if (path && typeof path === 'object') {
      this._populate.push(path);
    }
    return this;
  }

  distinct(field) { this._distinct = field; return this; }

  // ─── Update-query helpers ─────────────────────────────────────────────────

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

  async _execute() {
    // Buffer: wait for connection if not yet connected
    await this._model._waitForConnection();

    switch (this._op) {
      case 'find':       return this._execFind();
      case 'findOne':    return this._execFindOne();
      case 'count':
      case 'countDocuments': return this._execCount();
      case 'deleteOne':  return this._model.collection.deleteOne(this._filter);
      case 'deleteMany': return this._model.collection.deleteMany(this._filter);
      case 'updateOne':  return this._model.collection.updateOne(this._filter, this._update, this._updateOptions);
      case 'updateMany': return this._model.collection.updateMany(this._filter, this._update, this._updateOptions);
      case 'distinct':   return this._model.collection.distinct(this._distinct, this._filter);
      default: throw new Error(`Unknown query operation: ${this._op}`);
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