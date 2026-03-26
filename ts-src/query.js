'use strict';

const { ObjectId } = require('mongodb');

class Query {
  constructor(model, op, filter = {}) {
    this._model      = model;
    this._op         = op;
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
    this._startTime  = null;
    this.mongooseQueryType = op;
  }

  get _dbName() {
    try { return this._model.db.databaseName || this._model.db.name || ''; } catch { return ''; }
  }
  get _collectionName() {
    try { return this._model.collection.collectionName || this._model.collection.name || ''; } catch { return ''; }
  }
  get model() { return this._model; }
  get op() { return this._op; }
  getQuery() { return this._filter; }
  getFilter() { return this._filter; }

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
    } else { this._sort = arg; }
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
    if (typeof path === 'object') Object.assign(this._filter, path);
    else if (val !== undefined) this._filter[path] = val;
    return this;
  }

  populate(path, select) {
    if (typeof path === 'string') this._populate.push({ path, select });
    else if (Array.isArray(path)) {
      for (const p of path) {
        if (typeof p === 'string') this._populate.push({ path: p });
        else if (p && typeof p === 'object') this._populate.push(p);
      }
    } else if (path && typeof path === 'object') this._populate.push(path);
    return this;
  }

  distinct(field) { this._distinct = field; return this; }

  countDocuments() {
    this._op = 'countDocuments';
    this._promise = null;
    return this;
  }

  setUpdate(update, options = {}) {
    this._update = update;
    this._updateOptions = options;
    return this;
  }

  exec() {
    if (!this._promise) this._promise = this._execute();
    return this._promise;
  }

  then(resolve, reject) { return this.exec().then(resolve, reject); }
  catch(fn) { return this.exec().catch(fn); }
  finally(fn) { return this.exec().finally(fn); }
  toJSON() { return this.exec(); }

  // Cast filter values based on schema types (like Mongoose does)
  _castFilter() {
    const schema = this._model && this._model.schema;
    if (!schema || !this._filter) return;
    try {
      for (const key of Object.keys(this._filter)) {
        if (key.charAt(0) === '$') continue; // skip top-level operators like $or, $and
        const val = this._filter[key];
        if (val === null || val === undefined) continue;

        const schemaType = schema.paths[key];
        if (!schemaType) continue;

        if (typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date) && !(val instanceof ObjectId)) {
          // Nested operators: { field: { $gte: x, $lt: y } }
          for (const op of Object.keys(val)) {
            if (op.charAt(0) === '$' && val[op] != null) {
              val[op] = this._castVal(val[op], schemaType);
            }
          }
        } else {
          this._filter[key] = this._castVal(val, schemaType);
        }
      }
    } catch (_) { /* ignore */ }
  }

  _castVal(val, schemaType) {
    if (val === null || val === undefined) return val;
    if (schemaType.instance === 'Date' && !(val instanceof Date)) {
      const d = new Date(val);
      if (!isNaN(d.getTime())) return d;
    }
    return val;
  }

  async _execute() {
    await this._model._waitForConnection();
    this._castFilter();
    await this._runQueryHooks('pre', this._op);

    let result;
    switch (this._op) {
      case 'find':           result = await this._execFind(); break;
      case 'findOne':        result = await this._execFindOne(); break;
      case 'count':
      case 'countDocuments': result = await this._execCount(); break;
      case 'deleteOne':      result = await this._model.collection.deleteOne(this._filter); break;
      case 'deleteMany':     result = await this._model.collection.deleteMany(this._filter); break;
      case 'updateOne':      result = await this._safeUpdate('updateOne'); break;
      case 'updateMany':     result = await this._safeUpdate('updateMany'); break;
      case 'distinct':       result = await this._model.collection.distinct(this._distinct, this._filter); break;
      default: throw new Error('Unknown query operation: ' + this._op);
    }

    await this._runQueryHooks('post', this._op, result);
    return result;
  }

  async _runQueryHooks(type, event, result) {
    const schema = this._model && this._model.schema;
    if (!schema) return;
    const hooks = schema.getHooks ? schema.getHooks(type, event) : (schema._hooks[type][event] || []);
    for (const fn of hooks) {
      await new Promise((resolve, reject) => {
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
    for (const pop of this._populate) {
      for (const doc of results) { await this._model._populateDoc(doc, pop); }
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
    for (const pop of this._populate) { await this._model._populateDoc(result, pop); }
    return result;
  }

  async _execCount() {
    return this._model.collection.countDocuments(this._filter);
  }

  async _safeUpdate(method) {
    try {
      return await this._model.collection[method](this._filter, this._update, this._updateOptions);
    } catch (err) {
      console.error('[_safeUpdate] Error:', err.message, 'Retrying...');
      // If update fails (e.g. $[] on non-array field), retry without ALL $[] paths
      if (this._update && this._update['$set']) {
        var setObj = this._update['$set'];
        var cleanSet = {};
        var hasArrayPaths = false;
        for (var k in setObj) {
          if (k.indexOf('.$[].') !== -1 || k.indexOf('.$[]') !== -1) {
            hasArrayPaths = true;
          }
        }
        if (hasArrayPaths) {
          // First retry: keep only array paths that target actual arrays
          for (var k2 in setObj) {
            if (k2.indexOf('.$[].') === -1 && k2.indexOf('.$[]') === -1) {
              cleanSet[k2] = setObj[k2];
            } else if (!this._isNonArrayPath(k2)) {
              cleanSet[k2] = setObj[k2];
            }
          }
          var cleanUpdate = Object.assign({}, this._update, { '$set': cleanSet });
          try {
            return await this._model.collection[method](this._filter, cleanUpdate, this._updateOptions);
          } catch (_) {
            // Second retry: remove ALL $[] paths
            var safeSet = {};
            for (var k3 in setObj) {
              if (k3.indexOf('.$[') === -1) {
                safeSet[k3] = setObj[k3];
              }
            }
            if (Object.keys(safeSet).length > 0) {
              var safeUpdate = Object.assign({}, this._update, { '$set': safeSet });
              try {
                return await this._model.collection[method](this._filter, safeUpdate, this._updateOptions);
              } catch (__) {}
            }
          }
        }
      }
      return { acknowledged: true, modifiedCount: 0, matchedCount: 0 };
    }
  }

  _isNonArrayPath(path) {
    // Check if a $[] path targets a non-array field in the schema
    var schema = this._model && this._model.schema;
    if (!schema) return false;
    var parts = path.split('.$[].');
    if (parts.length < 2) return false;
    var basePath = parts[0];
    var st = schema.paths[basePath];
    // If the base path is not an Array type in schema, it's a non-array path
    if (st && st.instance !== 'Array') return true;
    // If no schema path found, check if it's a known nested object
    if (!st) return true;
    return false;
  }

  cursor() {
    return this._model.collection.find(this._filter);
  }
}

module.exports = Query;
