'use strict';

const SchemaTypes = require('./schematype');
let ObjectId; try { ({ ObjectId } = require('mongodb')); } catch { ObjectId = class ObjectId {}; }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pluralize(name) {
  // Mongoose's default pluralization (simplified)
  if (name.endsWith('y') && !/[aeiou]y$/i.test(name)) {
    return name.slice(0, -1) + 'ies';
  }
  if (/[sxz]$/i.test(name) || /[^aeiou]ch$/i.test(name) || /sh$/i.test(name)) {
    return name + 'es';
  }
  return name + 's';
}

// ─── Schema ───────────────────────────────────────────────────────────────────

class Schema {
  constructor(definition = {}, options = {}) {
    this.obj        = definition;            // raw definition kept for reference
    this.paths      = {};                    // path → SchemaType instance
    this.subpaths   = {};                    // dotted nested paths
    this.virtuals   = {};                    // virtuals
    this.methods    = {};                    // instance methods
    this.statics    = {};                    // static methods
    this.query      = {};                    // query helpers
    this._hooks     = { pre: {}, post: {} }; // middleware
    this._indexes   = [];                    // index definitions
    this._plugins   = [];                    // plugins
    this.childSchemas = [];                  // nested schemas

    this.options = {
      timestamps  : false,
      versionKey  : '__v',
      id          : true,        // add virtual `id` getter
      strict      : true,
      autoIndex   : true,
      collection  : null,        // override collection name
      ...options,
    };

    // Built-in _id field
    if (this.options._id !== false) {
      this.paths['_id'] = new (SchemaTypes.resolve(ObjectId))('_id', {});
    }

    // Parse definition
    this._parse(definition, '');

    // Timestamps
    if (this.options.timestamps) {
      const tsOpts = this.options.timestamps;
      const createdAt = (tsOpts.createdAt) || 'createdAt';
      const updatedAt = (tsOpts.updatedAt) || 'updatedAt';
      if (createdAt) this.paths[createdAt] = new (SchemaTypes.resolve(Date))(createdAt, {});
      if (updatedAt) this.paths[updatedAt] = new (SchemaTypes.resolve(Date))(updatedAt, {});
      this._timestamps = { createdAt: createdAt || 'createdAt', updatedAt: updatedAt || 'updatedAt' };
    }

    // versionKey
    if (this.options.versionKey) {
      this.paths[this.options.versionKey] = new (SchemaTypes.resolve(Number))(this.options.versionKey, { default: 0 });
    }

    // id virtual
    if (this.options.id) {
      this.virtual('id').get(function () {
        return this._id ? this._id.toString() : undefined;
      });
    }
  }

  // ─── Parsing ────────────────────────────────────────────────────────────────

  _parse(obj, prefix) {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      this._parsePath(path, key, value);
    }
  }

  _parsePath(fullPath, key, value) {
    // Shorthand: { name: String }
    if (this._isTypeConstructor(value)) {
      const TypeClass = SchemaTypes.resolve(value);
      this.paths[fullPath] = new TypeClass(fullPath, {});
      return;
    }

    // Array of type: { tags: [String] }
    if (Array.isArray(value)) {
      const TypeClass = SchemaTypes.resolve(value[0] || 'Mixed');
      this.paths[fullPath] = new (SchemaTypes.resolve('Array'))(fullPath, { of: TypeClass });
      return;
    }

    if (value && typeof value === 'object') {
      // Typed field: { name: { type: String, required: true } }
      if (value.type !== undefined && this._isTypeConstructor(value.type)) {
        const TypeClass = SchemaTypes.resolve(value.type);
        this.paths[fullPath] = new TypeClass(fullPath, value);
        return;
      }

      // Nested schema object: { address: { city: String, zip: String } }
      if (!value.type || typeof value.type === 'object') {
        this._parse(value, fullPath);
        return;
      }
    }

    // Fallback → Mixed
    this.paths[fullPath] = new (SchemaTypes.resolve('Mixed'))(fullPath, {});
  }

  _isTypeConstructor(value) {
    return (
      value === String    || value === Number   ||
      value === Boolean   || value === Date     ||
      value === Array     || value === Buffer   ||
      value === Map       || value === Object   ||
      value === require('mongodb').ObjectId    ||
      value === 'String'  || value === 'Number' ||
      value === 'Boolean' || value === 'Date'   ||
      value === 'Array'   || value === 'Mixed'  ||
      value === 'ObjectId'
    );
  }

  // ─── path() — get/set a SchemaType ──────────────────────────────────────────

  path(path, obj) {
    if (obj === undefined) {
      return this.paths[path] || null;
    }
    this._parsePath(path, path, obj);
    return this;
  }

  // ─── Virtuals ───────────────────────────────────────────────────────────────

  virtual(name) {
    if (!this.virtuals[name]) {
      this.virtuals[name] = { get: null, set: null };
    }
    const self = this;
    return {
      get(fn) { self.virtuals[name].get = fn; return this; },
      set(fn) { self.virtuals[name].set = fn; return this; },
    };
  }

  // ─── Middleware / Hooks ──────────────────────────────────────────────────────

  pre(event, fn) {
    if (!this._hooks.pre[event]) this._hooks.pre[event] = [];
    this._hooks.pre[event].push(fn);
    return this;
  }

  post(event, fn) {
    if (!this._hooks.post[event]) this._hooks.post[event] = [];
    this._hooks.post[event].push(fn);
    return this;
  }

  // ─── Indexes ────────────────────────────────────────────────────────────────

  index(fields, options = {}) {
    this._indexes.push({ fields, options });
    return this;
  }

  /**
   * Returns all indexes defined on this schema as an array of
   * [fields, options] tuples — compatible with mongoose-unique-validator
   * and other plugins that call schema.indexes().
   */
  indexes() {
    const result = [];

    // 1. Collect indexes defined via schema.index(...)
    for (const idx of this._indexes) {
      result.push([idx.fields, idx.options]);
    }

    // 2. Collect indexes declared inline on individual paths
    //    e.g. { email: { type: String, unique: true, index: true } }
    for (const [pathName, schemaType] of Object.entries(this.paths)) {
      const opts = schemaType._options || schemaType.options || {};
      if (opts.unique) {
        const idxFields = { [pathName]: 1 };
        const idxOpts   = { unique: true };
        if (opts.sparse)  idxOpts.sparse  = true;
        result.push([idxFields, idxOpts]);
      } else if (opts.index && typeof opts.index === 'object' && opts.index.unique) {
        const idxFields = { [pathName]: 1 };
        const idxOpts   = { unique: true, ...opts.index };
        result.push([idxFields, idxOpts]);
      }
    }

    return result;
  }

  // ─── Plugins ────────────────────────────────────────────────────────────────

  plugin(fn, opts) {
    this._plugins.push({ fn, opts });
    fn(this, opts);
    return this;
  }

  // ─── Collection name ────────────────────────────────────────────────────────

  collectionName(modelName) {
    if (this.options.collection) return this.options.collection;
    return pluralize(modelName.toLowerCase());
  }

  // ─── Validation ─────────────────────────────────────────────────────────────

  async validate(data, isUpdate = false) {
    const result = {};
    const validationErrors = {};

    // Timestamps
    if (this._timestamps) {
      if (!isUpdate && !data[this._timestamps.createdAt]) {
        result[this._timestamps.createdAt] = new Date();
      }
      result[this._timestamps.updatedAt] = new Date();
    }

    for (const [fieldPath, schemaType] of Object.entries(this.paths)) {
      if (fieldPath === '_id' && data._id) { result._id = data._id; continue; }
      if (fieldPath === this.options.versionKey) { result[fieldPath] = data[fieldPath] ?? 0; continue; }
      if (fieldPath === this._timestamps?.createdAt && isUpdate) continue;

      // Get value (support dot notation)
      let value = this._getNestedValue(data, fieldPath);

      // Apply default
      if ((value === undefined || value === null) && schemaType._defaultValue !== undefined) {
        value = typeof schemaType._defaultValue === 'function'
          ? schemaType._defaultValue()
          : schemaType._defaultValue;
      }

      // Skip undefined on updates
      if (isUpdate && (value === undefined)) continue;

      // Type cast
      try {
        value = schemaType.cast(value);
      } catch (castErr) {
        validationErrors[fieldPath] = castErr;
        continue;
      }

      // Run validators
      let validatorError = null;
      await new Promise((res) => {
        schemaType.doValidate(value, (err) => { if (err) validatorError = err; res(); }, data);
      });

      if (validatorError) {
        validationErrors[fieldPath] = validatorError;
        continue;
      }

      if (value !== undefined) this._setNestedValue(result, fieldPath, value);
    }

    // Strict mode: strip unknown fields
    if (!this.options.strict) {
      for (const key of Object.keys(data)) {
        if (!(key in result)) result[key] = data[key];
      }
    }

    if (Object.keys(validationErrors).length > 0) {
      const err = new Error('Validation failed: ' + Object.values(validationErrors).map(e => e.message).join(', '));
      err.name = 'ValidationError';
      err.errors = validationErrors;
      throw err;
    }

    return result;
  }

  // ─── Nested field helpers ────────────────────────────────────────────────────

  _getNestedValue(obj, path) {
    const parts = path.split('.');
    let cur = obj;
    for (const part of parts) {
      if (cur == null) return undefined;
      cur = cur[part];
    }
    return cur;
  }

  _setNestedValue(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]]) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }
}

// ─── Schema.Types shorthand ───────────────────────────────────────────────────

Schema.Types = SchemaTypes;
Schema.ObjectId = SchemaTypes.ObjectId;

module.exports = Schema;