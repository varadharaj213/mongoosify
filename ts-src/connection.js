'use strict';

const { MongoClient } = require('mongodb');
const EventEmitter = require('events');

// Connection ready states — identical to Mongoose
const STATES = {
  disconnected  : 0,
  connected     : 1,
  connecting    : 2,
  disconnecting : 3,
};

class Connection extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this.client     = null;
    this.db         = null;
    this.readyState = STATES.disconnected;
    this._uri       = null;
    this._dbName    = null;
    this._models    = {};   // model registry (name → Model class)
    this.STATES     = STATES;
  }

  // ─── name property (Mongoose compatibility: connection.name / db.name) ────

  get name() {
    return this._dbName || '';
  }

  // ─── host property ────────────────────────────────────────────────────

  get host() {
    if (!this._uri) return '';
    try {
      const url = new URL(this._uri);
      return url.hostname;
    } catch {
      return '';
    }
  }

  // ─── port property ─────────────���──────────────────────────────────────

  get port() {
    if (!this._uri) return 0;
    try {
      const url = new URL(this._uri);
      return parseInt(url.port) || 27017;
    } catch {
      return 27017;
    }
  }

  // ─── connect() ────────────────────────────────────────────────────────

  async connect(uri, options = {}) {
    // Already connected — return immediately
    if (this.readyState === STATES.connected) return this;

    // Already connecting — wait for it
    if (this.readyState === STATES.connecting) {
      return new Promise((resolve, reject) => {
        this.once('connected', () => resolve(this));
        this.once('error',     reject);
      });
    }

    this.readyState = STATES.connecting;
    this._uri = uri;
    this.emit('connecting');

    // Extract Mongoose-specific options before passing rest to driver
    const {
      dbName,
      bufferCommands,
      bufferTimeoutMS,
      autoIndex,
      user,
      pass,
      ...driverOptions
    } = options;

    // Support user/pass options (Mongoose-style)
    if (user && pass) {
      driverOptions.auth = { username: user, password: pass };
    }

    try {
      this.client = new MongoClient(uri, driverOptions);
      await this.client.connect();

      const db = dbName || this._extractDbName(uri);
      this.db = this.client.db(db);
      this._dbName = db;

      this.readyState = STATES.connected;
      this.emit('connected');
      this.emit('open');

      return this;
    } catch (err) {
      this.readyState = STATES.disconnected;
      this.emit('error', err);
      throw err;
    }
  }

  // ─── disconnect() / close() ───────────────────────────────────────────

  async disconnect() {
    if (this.readyState === STATES.disconnected) return this;
    this.readyState = STATES.disconnecting;
    this.emit('disconnecting');
    await this.client?.close();
    this.db     = null;
    this.client = null;
    this.readyState = STATES.disconnected;
    this.emit('disconnected');
    this.emit('close');
    return this;
  }

  async close(force = false) { return this.disconnect(); }

  // ─── getDb ────────────────────────────────────────────────────────────

  getDb() {
    if (!this.db || this.readyState !== STATES.connected) {
      throw new Error('Mongoosify: No database connected. Call connect() first.');
    }
    return this.db;
  }

  collection(name) {
    return this.getDb().collection(name);
  }

  // ─── model() (on connection, like conn.model()) ───────────────────────

  model(name, schema, collectionName) {
    if (!schema) {
      if (this._models[name]) return this._models[name];
      throw new Error(`Mongoosify: Model "${name}" not found on this connection.`);
    }
    if (this._models[name]) return this._models[name];
    const createModel = require('./model');
    const Model = createModel(name, schema, this, collectionName);
    this._models[name] = Model;
    return Model;
  }

  // ─── createConnection() (returns a new Connection) ────────────────────

  createConnection(uri, options = {}) {
    const conn = new Connection();
    if (uri) conn.connect(uri, options);
    return conn;
  }

  // ─── useDb() — switch database on same client ─────────────────────────

  useDb(dbName) {
    if (!this.client) throw new Error('Mongoosify: Not connected.');
    this.db = this.client.db(dbName);
    this._dbName = dbName;
    return this;
  }

  // ─── collections (Mongoose compatibility) ────────────────────────────────
  // Returns a Proxy map of { collectionName → Collection } for all model-registered
  // collections on the DB. Matches Mongoose's connection.collections behaviour:
  //
  //   const cols = mongoose.connection.collections;
  //   for (const key in cols) { await cols[key].deleteMany({}); }

  get collections() {
    if (!this.db || this.readyState !== STATES.connected) return {};
    const db    = this.db;
    const conn  = this;
    return new Proxy({}, {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        return db.collection(prop);
      },
      ownKeys() {
        // Enumerate all model-registered collection names
        return Object.values(conn._models).map(M => {
          try { return M.collection.collectionName || M.collection.name || ''; } catch { return ''; }
        }).filter(Boolean);
      },
      getOwnPropertyDescriptor(_target, prop) {
        return { enumerable: true, configurable: true, value: db.collection(String(prop)) };
      },
      has(_target, prop) {
        return typeof prop === 'string';
      },
    });
  }

  // ─── listCollections() — async helper for test teardown ──────────────────
  // Async counterpart of collections. Returns actual Collection objects from
  // the DB so tests can iterate and wipe every collection:
  //
  //   for (const col of await mongoose.connection.listCollections()) {
  //     await col.deleteMany({});
  //   }

  async listCollections(filter = {}) {
    const db   = this.getDb();
    const list = await db.listCollections(filter).toArray();
    return list.map(info => db.collection(info.name));
  }

  // ─── dropDatabase() ───────────────────────────────────────────────────

  async dropDatabase() {
    return this.getDb().dropDatabase();
  }

  // ─── startSession() ───────────────────────────────────────────────────

  async startSession(options = {}) {
    if (!this.client) throw new Error('Mongoosify: Not connected.');
    return this.client.startSession(options);
  }

  // ─── withTransaction() ────────────────────────────────────────────────

  async withTransaction(fn, options = {}) {
    const session = await this.startSession();
    let result;
    await session.withTransaction(async () => { result = await fn(session); }, options);
    await session.endSession();
    return result;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  _extractDbName(uri) {
    try {
      const url = new URL(uri);
      const name = url.pathname.replace(/^\//, '');
      return name || 'test';
    } catch {
      // Fallback for non-standard URIs
      const match = uri.match(/\/([^/?]+)(\?|$)/);
      return (match && match[1]) || 'test';
    }
  }
}

// Export singleton — this is what `mongoosify.connection` is
module.exports = new Connection();