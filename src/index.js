'use strict';

/**
 * varadharajcredopay — A Mongoose-compatible ODM for MongoDB
 *
 * Drop-in replacement:
 *   const mongoose = require('mongoose');
 *   →
 *   const mongoose = require('varadharajcredopay');
 */

const connection  = require('./connection');
const Schema      = require('./schema');
const SchemaTypes = require('./schematype');
const createModel = require('./model');
const Document    = require('./document');
const Query       = require('./query');

// ─── Global settings (mongoose.set / mongoose.get) ────────────────────────────

const _settings = {
  debug           : false,
  strict          : true,
  strictQuery     : false,
  bufferCommands  : true,
  bufferTimeoutMS : 10000,
};

// ─── Debug callback support ───────────────────────────────────────────────────
// mongoose.set("debug", fn) — stores the callback for debug logging

let _debugCallback = null;

// ─── mongoosify object ────────────────────────────────────────────────────────

const mongoosify = {

  // ─── Connection ─────────────────────────────────────────────────────────

  /**
   * connect() — Mongoose-compatible.
   * Returns a thenable that resolves to `this` (the mongoosify object).
   * `this.connection` gives the default connection — matching Mongoose's
   * `mongoose.connect(uri).then(db => db.connection.collection(...))`
   */
  connect(uri, options = {}) {
    return connection.connect(uri, options).then(() => mongoosify);
  },

  disconnect() {
    return connection.disconnect();
  },

  /** Create an additional connection (not the default one) */
  createConnection(uri, options = {}) {
    return connection.createConnection(uri, options);
  },

  /** The default connection (mongoose.connection) */
  get connection() { return connection; },

  /** Alias: mongoose.connections is an array in real Mongoose */
  get connections() { return [connection]; },

  // ─── Model registry ─────────────────────────────────────────────────────

  /**
   * mongoose.model(name, schema) — register + return Model
   * mongoose.model(name)         — retrieve existing Model
   */
  model(name, schema, collectionName) {
    if (!schema) {
      // Retrieve
      if (connection._models[name]) return connection._models[name];
      throw new Error(
        `Schema hasn't been registered for model "${name}".\n` +
        `Use mongoose.model(name, schema) to register it first.`
      );
    }

    // Warn if already registered (matches Mongoose behaviour)
    if (connection._models[name]) {
      return connection._models[name];
    }

    const Model = createModel(name, schema, connection, collectionName);
    connection._models[name] = Model;

    // Auto-index on next tick (like Mongoose's autoIndex)
    if (schema.options.autoIndex !== false && _settings.bufferCommands !== false) {
      setImmediate(() => {
        if (connection.readyState === 1) {
          Model.ensureIndexes().catch(() => {});
        } else {
          connection.once('connected', () => {
            Model.ensureIndexes().catch(() => {});
          });
        }
      });
    }

    return Model;
  },

  /** Returns all registered model names */
  modelNames() {
    return Object.keys(connection._models);
  },

  // ─── Schema & Types ─────────����──────────────────────────────────────────

  Schema,
  SchemaTypes,
  Document,
  Query,

  /** mongoose.Types — ObjectId, etc. */
  get Types() {
    return {
      ObjectId  : require('mongodb').ObjectId,
      String    : SchemaTypes.String,
      Number    : SchemaTypes.Number,
      Boolean   : SchemaTypes.Boolean,
      Array     : SchemaTypes.Array,
      Buffer    : SchemaTypes.Buffer,
      Date      : SchemaTypes.Date,
      Mixed     : SchemaTypes.Mixed,
      Map       : SchemaTypes.Map,
    };
  },

  /** Shorthand: mongoosify.ObjectId */
  ObjectId: require('mongodb').ObjectId,

  // ─── Global settings ────────────────────────────────────────────────────

  /**
   * mongoose.set(key, value)
   * Supports:
   *   mongoose.set("debug", true)
   *   mongoose.set("debug", function(collectionName, method, query) { ... })
   */
  set(key, value) {
    _settings[key] = value;

    // Special handling for "debug" — support callback function
    if (key === 'debug') {
      if (typeof value === 'function') {
        _debugCallback = value;
      } else {
        _debugCallback = value ? _defaultDebugLogger : null;
      }
    }

    return this;
  },

  get(key) {
    return _settings[key];
  },

  // ─── readyState ─────────────────────────────────────────────────────────

  get readyState() { return connection.readyState; },
  STATES: connection.STATES,

  // ─── Event forwarding ───────────────────────────────────────────────────

  on(event, fn) { connection.on(event, fn); return this; },
  once(event, fn) { connection.once(event, fn); return this; },
  off(event, fn) { connection.off(event, fn); return this; },

  // ─── Transactions ───────────────────────────────────────────────────────

  startSession(options) { return connection.startSession(options); },

  withTransaction(fn, options) { return connection.withTransaction(fn, options); },

  // ─── Plugin (global) ────────────────────────────────────────────────────

  plugin(fn, opts) {
    // Apply to all future schemas (simplified global plugin)
    this._globalPlugins = this._globalPlugins || [];
    this._globalPlugins.push({ fn, opts });
    return this;
  },

  // ─── isValidObjectId / isObjectIdOrHexString ────────────────────────────

  isValidObjectId(id) {
    if (!id) return false;
    const { ObjectId } = require('mongodb');
    if (id instanceof ObjectId) return true;
    if (typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id)) return true;
    return false;
  },

  isObjectIdOrHexString(id) {
    return this.isValidObjectId(id);
  },
};

// ─── Default debug logger ─────────────────────────────────────────────────────

function _defaultDebugLogger(collectionName, method, query) {
  console.log(`Mongoose: ${collectionName}.${method}(${JSON.stringify(query)})`);
}

// ─── Named exports — so both styles work: ────────────────────────────────────
//   import mongoose from 'varadharajcredopay'           (default)
//   import { Schema, model, ObjectId } from '...'       (named)
//   const { Schema, model } = require('...')            (CJS destructure)

mongoosify.Schema      = Schema;
mongoosify.SchemaTypes = SchemaTypes;
mongoosify.Document    = Document;
mongoosify.Query       = Query;

// Named export helpers — bound to the mongoosify context
mongoosify.model = function (name, schema, collectionName) {
  if (!schema) {
    if (connection._models[name]) return connection._models[name];
    throw new Error(
      `Schema hasn't been registered for model "${name}".\n` +
      `Use mongoose.model(name, schema) to register it first.`
    );
  }
  if (connection._models[name]) return connection._models[name];
  const Model = createModel(name, schema, connection, collectionName);
  connection._models[name] = Model;
  if (schema.options.autoIndex !== false && _settings.bufferCommands !== false) {
    setImmediate(() => {
      if (connection.readyState === 1) {
        Model.ensureIndexes().catch(() => {});
      } else {
        connection.once('connected', () => { Model.ensureIndexes().catch(() => {}); });
      }
    });
  }
  return Model;
};

// ObjectId as a named export shorthand
mongoosify.ObjectId = require('mongodb').ObjectId;

// Allow: const { Schema, model, ObjectId, SchemaTypes, Document, Query } = require('varadharajcredopay')
// This works because module.exports IS the mongoosify object which now has all these as own props.

module.exports = mongoosify;

// Named ES module-style exports for TypeScript / ESM interop
// These must be explicit properties on module.exports for CJS named-import to work
module.exports.Schema      = Schema;
module.exports.SchemaTypes = SchemaTypes;
module.exports.Document    = Document;
module.exports.Query       = Query;
module.exports.ObjectId    = require('mongodb').ObjectId;
module.exports.model       = mongoosify.model;
module.exports.connect     = (uri, opts) => connection.connect(uri, opts).then(() => mongoosify);
module.exports.disconnect  = () => connection.disconnect();
module.exports.default     = mongoosify;   // for ESM interop: import mongoose from '...'