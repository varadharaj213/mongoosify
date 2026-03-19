'use strict';

const { ObjectId } = require('mongodb');
const Query    = require('./query');
const Document = require('./document');
const connection = require('./connection');

// ─── Model factory ────────────────────────────────────────────────────────────
// Returns a Model class — exactly how Mongoose does it.

function createModel(modelName, schema, conn, explicitCollectionName) {

  // Use the provided connection, or fall back to the default singleton
  const modelConnection = conn || connection;

  // The Model constructor doubles as Document constructor (like Mongoose)
  class Model {
    constructor(data = {}) {
      return new Document(data, schema, Model);
    }
  }

  // ─── Static properties ──────────────────────────────────────────────────

  Model.modelName = modelName;
  Model.schema    = schema;
  Model.base      = modelConnection;   // reference to the connection this model belongs to

  // Collection name resolution (priority order):
  // 1. Explicit third argument to conn.model(name, schema, collectionName)
  // 2. schema.options.collection
  // 3. The model name itself (lowercased) — Mongoose uses the model name as-is
  //    when it already looks like a collection name
  const collectionName = explicitCollectionName
    || schema.options.collection
    || modelName.toLowerCase();

  Object.defineProperty(Model, 'collection', {
    get() { return modelConnection.getDb().collection(collectionName); },
  });

  Object.defineProperty(Model, 'db', {
    get() { return modelConnection.getDb(); },
  });

  // ─── Connection buffering ───────────────────────────────────────────────
  // Like Mongoose: queue operations until connected.

  Model._waitForConnection = function () {
    if (modelConnection.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = schema.options.bufferTimeoutMS || 10000;
      const timer = setTimeout(() => {
        reject(new Error(
          `Mongoosify: Operation on model "${modelName}" buffered for ${timeout}ms without connecting.`
        ));
      }, timeout);
      modelConnection.once('connected', () => { clearTimeout(timer); resolve(); });
      modelConnection.once('error',     (e) => { clearTimeout(timer); reject(e); });
    });
  };

  // ─── ensureIndexes ──────────────────────────────────────────────────────

  Model.ensureIndexes = async function () {
    if (!schema._indexes.length) return;
    for (const { fields, options } of schema._indexes) {
      await Model.collection.createIndex(fields, options);
    }
  };

  // ─── create() ───────────────────────────────────────────────────────────

  Model.create = async function (docs) {
    const isArray = Array.isArray(docs);
    const arr = isArray ? docs : [docs];

    const results = [];
    for (const data of arr) {
      const doc = new Document(data, schema, Model);
      await doc.save();
      results.push(doc);
    }
    return isArray ? results : results[0];
  };

  // ─── insertMany() ───────────────────────────────────────────────────────

  Model.insertMany = async function (docs, options = {}) {
    await Model._waitForConnection();
    const validated = [];
    for (const d of docs) {
      const v = await schema.validate(d, false);
      if (!v._id) v._id = new ObjectId();
      validated.push(v);
    }
    const result = await Model.collection.insertMany(validated, options);
    return validated.map(d => new Document(d, schema, Model));
  };

  // ─── find() ─────────────────────────────────────────────────────────────

  Model.find = function (filter = {}, projection = null, options = {}) {
    const q = new Query(Model, 'find', _normalizeFilter(filter));
    if (projection) q.select(projection);
    return q;
  };

  // ─── findOne() ──────────────────────────────────────────────────────────

  Model.findOne = function (filter = {}, projection = null) {
    const q = new Query(Model, 'findOne', _normalizeFilter(filter));
    if (projection) q.select(projection);
    return q;
  };

  // ─── findById() ─────────────────────────────────────────────────────────

  Model.findById = function (id, projection = null) {
    if (id === null || id === undefined) return Model.findOne({ _id: null });
    return Model.findOne({ _id: _castId(id) }, projection);
  };

  // ─── findByIdAndUpdate() ────────────────────────────────────────────────

  Model.findByIdAndUpdate = function (id, update, options = {}) {
    return Model.findOneAndUpdate({ _id: _castId(id) }, update, options);
  };

  // ─── findOneAndUpdate() ─────────────────────────────────────────────────

  Model.findOneAndUpdate = async function (filter, update, options = {}) {
    await Model._waitForConnection();
    const { new: returnNew = false, upsert = false, runValidators = false, projection } = options;

    // Add timestamps updatedAt
    let upd = update;
    if (schema._timestamps) {
      const key = schema._timestamps.updatedAt;
      if (upd.$set) upd.$set[key] = new Date();
      else upd = { ...upd, $set: { ...(upd.$set || {}), [key]: new Date() } };
    }

    const result = await Model.collection.findOneAndUpdate(
      _normalizeFilter(filter),
      upd,
      { returnDocument: returnNew ? 'after' : 'before', upsert, projection }
    );
    if (!result) return null;
    return new Document(result, schema, Model);
  };

  // ─── findOneAndReplace() ────────────────────────────────────────────────

  Model.findOneAndReplace = async function (filter, replacement, options = {}) {
    await Model._waitForConnection();
    const { new: returnNew = false, upsert = false } = options;
    const result = await Model.collection.findOneAndReplace(
      _normalizeFilter(filter),
      replacement,
      { returnDocument: returnNew ? 'after' : 'before', upsert }
    );
    if (!result) return null;
    return new Document(result, schema, Model);
  };

  // ─── findByIdAndDelete() / findByIdAndRemove() ──────────────────────────

  Model.findByIdAndDelete = async function (id, options = {}) {
    return Model.findOneAndDelete({ _id: _castId(id) }, options);
  };
  Model.findByIdAndRemove = Model.findByIdAndDelete;

  // ─── findOneAndDelete() / findOneAndRemove() ────────────────────────────

  Model.findOneAndDelete = async function (filter, options = {}) {
    await Model._waitForConnection();
    const result = await Model.collection.findOneAndDelete(_normalizeFilter(filter), options);
    if (!result) return null;
    return new Document(result, schema, Model);
  };
  Model.findOneAndRemove = Model.findOneAndDelete;

  // ─── updateOne() ────────────────────────────────────────────────────────

  Model.updateOne = function (filter, update, options = {}) {
    const upd = _addTimestamps(update, schema);
    return new Query(Model, 'updateOne', _normalizeFilter(filter)).setUpdate(upd, options);
  };

  // ─── updateMany() ───────────────────────────────────────────────────────

  Model.updateMany = function (filter, update, options = {}) {
    const upd = _addTimestamps(update, schema);
    return new Query(Model, 'updateMany', _normalizeFilter(filter)).setUpdate(upd, options);
  };

  // ─── replaceOne() ───────────────────────────────────────────────────────

  Model.replaceOne = async function (filter, replacement, options = {}) {
    await Model._waitForConnection();
    return Model.collection.replaceOne(_normalizeFilter(filter), replacement, options);
  };

  // ─── deleteOne() ────────────────────────────────────────────────────────

  Model.deleteOne = function (filter = {}) {
    return new Query(Model, 'deleteOne', _normalizeFilter(filter));
  };

  // ─── deleteMany() ───────────────────────────────────────────────────────

  Model.deleteMany = function (filter = {}) {
    return new Query(Model, 'deleteMany', _normalizeFilter(filter));
  };

  // ─── remove() (alias for deleteMany, Mongoose legacy) ───────────────────

  Model.remove = function (filter = {}) {
    return Model.deleteMany(filter);
  };

  // ─── countDocuments() ───────────────────────────────────────────────────

  Model.countDocuments = function (filter = {}) {
    return new Query(Model, 'countDocuments', _normalizeFilter(filter));
  };

  // ─── estimatedDocumentCount() ───────────────────────────────────────────

  Model.estimatedDocumentCount = async function () {
    await Model._waitForConnection();
    return Model.collection.estimatedDocumentCount();
  };

  // ─── exists() ───────────────────────────────────────────────────────────

  Model.exists = async function (filter) {
    await Model._waitForConnection();
    const doc = await Model.collection.findOne(_normalizeFilter(filter), { projection: { _id: 1 } });
    return doc ? { _id: doc._id } : null;
  };

  // ─── distinct() ─────────────────────────────────────────────────────────

  Model.distinct = function (field, filter = {}) {
    const q = new Query(Model, 'distinct', _normalizeFilter(filter));
    q._distinct = field;
    return q;
  };

  // ─── aggregate() ────────────────────────────────────────────────────────

  Model.aggregate = async function (pipeline, options = {}) {
    await Model._waitForConnection();
    return Model.collection.aggregate(pipeline, options).toArray();
  };

  // ─── watch() ────────────────────────────────────────────────────────────

  Model.watch = function (pipeline = [], options = {}) {
    return Model.collection.watch(pipeline, options);
  };

  // ─── bulkWrite() ────────────────────────────────────────────────────────

  Model.bulkWrite = async function (ops, options = {}) {
    await Model._waitForConnection();
    return Model.collection.bulkWrite(ops, options);
  };

  // ─── populate() — static ────────────────────────────────────────────────

  Model.populate = async function (docs, options) {
    if (!docs) return docs;
    const arr = Array.isArray(docs) ? docs : [docs];
    const opts = typeof options === 'string' ? { path: options } : options;

    // Get the referenced model
    const schemaDef = schema.paths[opts.path];
    const refModelName = schemaDef && schemaDef.options && schemaDef.options.ref;
    if (!refModelName) return docs;

    const refModel = connection._models[refModelName];
    if (!refModel) return docs;

    const ids = arr.map(d => d[opts.path]).filter(Boolean);
    if (!ids.length) return docs;

    const refDocs = await refModel.find({ _id: { $in: ids } });
    const map = {};
    for (const ref of refDocs) map[ref._id.toString()] = ref;

    for (const doc of arr) {
      if (doc[opts.path]) {
        doc[opts.path] = map[doc[opts.path].toString()] || doc[opts.path];
      }
    }

    return docs;
  };

  Model._populateDoc = async function (doc, pop) {
    await Model.populate(doc, pop);
  };

  // ─── schema statics ──────────────────────────────────────────────────────

  for (const [name, fn] of Object.entries(schema.statics)) {
    Model[name] = fn.bind(Model);
  }

  // ─── query helpers ───────────────────────────────────────────────────────

  for (const [name, fn] of Object.entries(schema.query)) {
    Query.prototype[name] = fn;
  }

  return Model;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _castId(id) {
  if (!id) return id;
  if (id instanceof ObjectId) return id;
  try { return new ObjectId(id); }
  catch { return id; }
}

function _normalizeFilter(filter) {
  if (!filter) return {};
  // Cast _id if present
  if (filter._id && !(filter._id instanceof ObjectId) && typeof filter._id === 'string') {
    try { filter = { ...filter, _id: new ObjectId(filter._id) }; } catch {}
  }
  return filter;
}

function _addTimestamps(update, schema) {
  if (!schema._timestamps) return update;
  const key = schema._timestamps.updatedAt;
  if (!key) return update;
  if (update.$set) { return { ...update, $set: { ...update.$set, [key]: new Date() } }; }
  return { ...update, $set: { [key]: new Date() } };
}

module.exports = createModel;
