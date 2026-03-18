'use strict';

/**
 * mongoosify — A Mongoose-like ODM for MongoDB
 *
 * Drop-in compatible API:
 *   const mongoose = require('mongoosify');
 *   ↓
 *   const mongoose = require('mongoosify');
 */

const connection  = require('./connection');
const Schema      = require('./schema');
const SchemaTypes = require('./schematype');
const createModel = require('./model');
const Document    = require('./document');

// ─── Global settings (mongoose.set / mongoose.get) ────────────────────────────

const _settings = {
  debug           : false,
  strict          : true,
  strictQuery     : false,
  bufferCommands  : true,
  bufferTimeoutMS : 10000,
};

// ─── mongoosify object ────────────────────────────────────────────────────────

const mongoosify = {

  // ─── Connection ─────────────────────────────────────────────────────────

  connect(uri, options = {}) {
    return connection.connect(uri, options);
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
  model(name, schema) {
    if (!schema) {
      // Retrieve
      if (connection._models[name]) return connection._models[name];
      throw new Error(
        `Mongoosify: Schema hasn't been registered for model "${name}".\n` +
        `Use mongoosify.model(name, schema) to register it first.`
      );
    }

    // Warn if already registered (matches Mongoose behaviour)
    if (connection._models[name]) {
      return connection._models[name];
    }

    const Model = createModel(name, schema);
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

  // ─── Schema & Types ─────────────────────────────────────────────────────

  Schema,
  SchemaTypes,
  Document,

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
  get ObjectId() { return require('mongodb').ObjectId; },

  // ─── Global settings ────────────────────────────────────────────────────

  set(key, value) {
    _settings[key] = value;
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
};

module.exports = mongoosify;