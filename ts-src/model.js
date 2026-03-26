'use strict';

const { ObjectId } = require('mongodb');
const Query    = require('./query');
const Document = require('./document');
const connection = require('./connection');

// ─── Aggregate helper class ───────────────────────────────────────────────────
// Provides a thenable Aggregate object similar to Mongoose's Aggregate class.
// Supports .exec(), .then(), .catch(), .finally(), and pipeline append methods.

class Aggregate {
  constructor(model, pipeline = [], options = {}) {
    this._model    = model;
    this._pipeline = Array.isArray(pipeline) ? [...pipeline] : [];
    this._options  = options;
    this._promise  = null;
  }

  // Pipeline stage methods
  append(...stages) {
    for (const s of stages) {
      if (Array.isArray(s)) this._pipeline.push(...s);
      else this._pipeline.push(s);
    }
    return this;
  }

  match(obj)    { this._pipeline.push({ $match: obj }); return this; }
  group(obj)    { this._pipeline.push({ $group: obj }); return this; }
  sort(obj)     { this._pipeline.push({ $sort: obj }); return this; }
  project(obj)  { this._pipeline.push({ $project: obj }); return this; }
  limit(n)      { this._pipeline.push({ $limit: n }); return this; }
  skip(n)       { this._pipeline.push({ $skip: n }); return this; }
  unwind(path)  { this._pipeline.push({ $unwind: path }); return this; }
  lookup(obj)   { this._pipeline.push({ $lookup: obj }); return this; }
  addFields(obj){ this._pipeline.push({ $addFields: obj }); return this; }
  count(field)  { this._pipeline.push({ $count: field || 'count' }); return this; }
  facet(obj)    { this._pipeline.push({ $facet: obj }); return this; }
  sample(size)  { this._pipeline.push({ $sample: { size } }); return this; }
  replaceRoot(obj) { this._pipeline.push({ $replaceRoot: obj }); return this; }

  option(key, val) {
    if (typeof key === 'object') Object.assign(this._options, key);
    else this._options[key] = val;
    return this;
  }

  // Get the pipeline
  pipeline() {
    return this._pipeline;
  }

  exec() {
    if (!this._promise) {
      this._promise = (async () => {
        await this._model._waitForConnection();
        return this._model.collection.aggregate(this._pipeline, this._options).toArray();
      })();
    }
    return this._promise;
  }

  then(resolve, reject) { return this.exec().then(resolve, reject); }
  catch(fn) { return this.exec().catch(fn); }
  finally(fn) { return this.exec().finally(fn); }
}

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
    get() {
      const col = modelConnection.getDb().collection(collectionName);
      // Add .name property for Mongoose compatibility (used in mongoose-monitor)
      if (!col._collectionName) {
        Object.defineProperty(col, 'name', {
          get() { return collectionName; },
          configurable: true
        });
      }
      return col;
    },
  });

  Object.defineProperty(Model, 'db', {
    get() {
      const db = modelConnection.getDb();
      // Ensure db.name is available (MongoDB driver uses databaseName)
      if (!db.name && db.databaseName) {
        Object.defineProperty(db, 'name', {
          get() { return this.databaseName; },
          configurable: true
        });
      }
      return db;
    },
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
    await Model._waitForConnection();
    const isArray = Array.isArray(docs);
    const arr = isArray ? docs : [docs];

    const results = [];
    for (const data of arr) {
      const copy = _applyDefaults({ ...data }, schema);
      if (!copy._id) copy._id = new ObjectId();
      // Add timestamps if schema has them
      if (schema._timestamps) {
        if (!copy[schema._timestamps.createdAt]) copy[schema._timestamps.createdAt] = new Date();
        copy[schema._timestamps.updatedAt] = new Date();
      }
      // Add version key
      if (schema.options.versionKey && copy[schema.options.versionKey] === undefined) {
        copy[schema.options.versionKey] = 0;
      }

      // Run pre('save') hooks — Mongoose's Model.create() runs save middleware
      const preHooks = schema.getHooks ? schema.getHooks('pre', 'save') : (schema._hooks && schema._hooks.pre && schema._hooks.pre.save || []);
      if (preHooks.length > 0) {
        const tempDoc = new Document(copy, schema, Model);
        for (const fn of preHooks) {
          await new Promise((resolve, reject) => {
            const result = fn.call(tempDoc, (err) => { if (err) reject(err); else resolve(); });
            if (result && typeof result.then === 'function') result.then(resolve).catch(reject);
            else if (fn.length === 0) resolve();
          });
        }
        // Copy any fields that hooks may have set back to copy
        for (const key of Object.keys(tempDoc)) {
          if (!key.startsWith('$__')) {
            copy[key] = tempDoc[key];
          }
        }
      }

      await Model.collection.insertOne(copy);
      const doc = new Document(copy, schema, Model);
      results.push(doc);
    }
    return isArray ? results : results[0];
  };

  // ─── insertMany() ───────────────────────────────────────────────────────

  Model.insertMany = async function (docs, options = {}) {
    await Model._waitForConnection();
    const arr = Array.isArray(docs) ? docs : [docs];
    const prepared = [];
    for (const d of arr) {
      const copy = _applyDefaults({ ...d }, schema);
      if (!copy._id) copy._id = new ObjectId();
      // Add timestamps if schema has them
      if (schema._timestamps) {
        if (!copy[schema._timestamps.createdAt]) copy[schema._timestamps.createdAt] = new Date();
        copy[schema._timestamps.updatedAt] = new Date();
      }
      prepared.push(copy);
    }
    const result = await Model.collection.insertMany(prepared, options);
    return prepared.map(d => new Document(d, schema, Model));
  };

  // ─── find() ─────────────────────────────────────────────────────────────

  Model.find = function (filter = {}, projection = null, options = {}) {
    const q = new Query(Model, 'find', _normalizeFilter(filter));
    if (projection) q.select(projection);
    return q;
  };

  // ─── findOne() ─────────────────────────────────────────────────────���──��─

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

  Model.findOneAndUpdate = function (filter, update, options = {}) {
    const state = { lean: false, _promise: null };

    const _exec = () => {
      if (!state._promise) {
        state._promise = (async () => {
          await Model._waitForConnection();
          const { new: returnNew = false, upsert = false, runValidators = false, projection,
                  returnNewDocument = false } = options;
          const shouldReturnNew = returnNew || returnNewDocument;

          // Wrap plain objects in $set if needed (Mongoose compatibility)
          let upd = _wrapInSetIfNeeded(update);

          // Add timestamps updatedAt
          if (schema._timestamps) {
            const key = schema._timestamps.updatedAt;
            if (upd.$set) upd.$set[key] = new Date();
            else upd = { ...upd, $set: { ...(upd.$set || {}), [key]: new Date() } };
          }

          const nFilter = _castFilterDates(_normalizeFilter(filter), schema);
          const mongoOpts = { returnDocument: shouldReturnNew ? 'after' : 'before', upsert };
          if (projection) mongoOpts.projection = projection;

          const result = await Model.collection.findOneAndUpdate(
            nFilter,
            upd,
            mongoOpts
          );
          if (!result) return null;
          if (state.lean) return result;
          return new Document(result, schema, Model);
        })();
      }
      return state._promise;
    };

    const thenable = {
      lean() { state.lean = true; return thenable; },
      exec() { return _exec(); },
      then(resolve, reject) { return _exec().then(resolve, reject); },
      catch(fn) { return _exec().catch(fn); },
      finally(fn) { return _exec().finally(fn); },
    };
    return thenable;
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

  // ─── updateMany() ───────────────────────────���──��────────────────────────

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

  // ─── deleteMany() ──────────────────────────────────────────────────────���

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
  // Returns an Aggregate object (thenable) — compatible with Mongoose's aggregate

  Model.aggregate = function (pipeline, options = {}) {
    if (Array.isArray(pipeline)) {
      return new Aggregate(Model, pipeline, options);
    }
    // No pipeline — return empty Aggregate for chaining
    return new Aggregate(Model, [], options);
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
  // Supports both direct ref populate AND virtual populate (like Mongoose).
  // Virtual populate: schema.virtual('name', { ref, localField, foreignField, justOne })

  Model.populate = async function (docs, options) {
    if (!docs) return docs;
    const arr = Array.isArray(docs) ? docs : [docs];
    const opts = typeof options === 'string' ? { path: options } : options;
    const popPath = opts.path;
    const popModel = opts.model; // explicit model override (Mongoose-style)
    const popSelect = opts.select;
    const nestedPopulate = opts.populate; // nested populate

    // 1. Try direct ref on schema path
    const schemaDef = schema.paths[popPath];
    const directRef = schemaDef && schemaDef.options && schemaDef.options.ref;

    if (directRef || popModel) {
      const refModelName = popModel || directRef;
      const refModel = _resolveModel(refModelName);
      if (refModel) {
        const ids = arr.map(d => _getNestedValue(d, popPath)).filter(Boolean);
        if (ids.length) {
          const findFilter = { _id: { $in: ids } };
          let refDocs;
          if (popSelect) {
            refDocs = await refModel.collection.find(findFilter).project(typeof popSelect === 'string' ? _parseSelect(popSelect) : popSelect).toArray();
          } else {
            refDocs = await refModel.collection.find(findFilter).toArray();
          }
          const map = {};
          for (const ref of refDocs) map[ref._id.toString()] = ref;
          for (const doc of arr) {
            const val = _getNestedValue(doc, popPath);
            if (val) {
              const resolved = map[val.toString()] || val;
              _setNestedValue(doc, popPath, resolved);
              // Handle nested populate on the resolved doc
              if (nestedPopulate && resolved && typeof resolved === 'object') {
                const nestedPops = Array.isArray(nestedPopulate) ? nestedPopulate : [nestedPopulate];
                for (const np of nestedPops) {
                  const npOpts = typeof np === 'string' ? { path: np } : np;
                  if (npOpts.model) {
                    const nestedRefModel = _resolveModel(npOpts.model);
                    if (nestedRefModel) {
                      await _populateSingleDoc(resolved, npOpts, nestedRefModel);
                    }
                  }
                }
              }
            }
          }
        }
        return docs;
      }
    }

    // 2. Try virtual populate — search all virtuals on this schema AND nested sub-schemas
    const virtualPopResult = _findVirtualPopulate(schema, popPath);
    if (virtualPopResult) {
      const { ref, localField, foreignField, justOne } = virtualPopResult;
      const pathParts = popPath.split('.');
      const prefix = pathParts.slice(0, pathParts.length - 1).join('.');
      const fullLocalField = prefix ? `${prefix}.${localField}` : localField;

      const refModel = _resolveModel(ref);
      if (refModel) {
        const localValues = arr.map(d => _getNestedValue(d, fullLocalField)).filter(v => v != null);
        if (localValues.length) {
          let refDocs;
          if (popSelect) {
            refDocs = await refModel.collection.find({ [foreignField]: { $in: localValues } })
              .project(typeof popSelect === 'string' ? _parseSelect(popSelect) : popSelect).toArray();
          } else {
            refDocs = await refModel.collection.find({ [foreignField]: { $in: localValues } }).toArray();
          }
          const map = {};
          for (const ref of refDocs) {
            const key = ref[foreignField] ? ref[foreignField].toString() : '';
            if (justOne) {
              if (!map[key]) map[key] = ref;
            } else {
              if (!map[key]) map[key] = [];
              map[key].push(ref);
            }
          }
          for (const doc of arr) {
            const localVal = _getNestedValue(doc, fullLocalField);
            if (localVal != null) {
              const key = localVal.toString();
              const resolved = map[key] || (justOne ? null : []);
              _setNestedValue(doc, popPath, resolved);
              if (nestedPopulate && resolved && typeof resolved === 'object') {
                const resolvedArr = Array.isArray(resolved) ? resolved : [resolved];
                const nestedPops = Array.isArray(nestedPopulate) ? nestedPopulate : [nestedPopulate];
                for (const rDoc of resolvedArr) {
                  if (!rDoc) continue;
                  for (const np of nestedPops) {
                    const npOpts = typeof np === 'string' ? { path: np } : np;
                    if (npOpts.model) {
                      const nestedRefModel = _resolveModel(npOpts.model);
                      if (nestedRefModel) {
                        await _populateSingleDoc(rDoc, npOpts, nestedRefModel);
                      }
                    }
                  }
                }
              }
            }
          }
        }
        return docs;
      }
    }

    return docs;
  };

  Model._populateDoc = async function (doc, pop) {
    await Model.populate(doc, pop);
  };

  // ─── Virtual populate helpers ───────────────────────────────────────────

  function _findVirtualPopulate(schemaObj, path) {
    if (!schemaObj || !path) return null;

    if (schemaObj.virtuals[path] && schemaObj.virtuals[path].options && schemaObj.virtuals[path].options.ref) {
      return schemaObj.virtuals[path].options;
    }

    const parts = path.split('.');
    const leafName = parts[parts.length - 1];

    const allSubSchemas = [];
    _collectAllSubSchemas(schemaObj, allSubSchemas);
    for (const subSchema of allSubSchemas) {
      if (subSchema.virtuals[leafName] && subSchema.virtuals[leafName].options && subSchema.virtuals[leafName].options.ref) {
        return subSchema.virtuals[leafName].options;
      }
    }

    const allModels = { ...modelConnection._models, ...connection._models };
    for (const mName of Object.keys(allModels)) {
      const m = allModels[mName];
      if (!m.schema) continue;
      if (m.schema.virtuals[leafName] && m.schema.virtuals[leafName].options && m.schema.virtuals[leafName].options.ref) {
        return m.schema.virtuals[leafName].options;
      }
      const modelSubSchemas = [];
      _collectAllSubSchemas(m.schema, modelSubSchemas);
      for (const subSchema of modelSubSchemas) {
        if (subSchema.virtuals[leafName] && subSchema.virtuals[leafName].options && subSchema.virtuals[leafName].options.ref) {
          return subSchema.virtuals[leafName].options;
        }
      }
    }

    return null;
  }

  function _collectAllSubSchemas(schemaObj, result, visited) {
    if (!schemaObj) return;
    if (!visited) visited = new Set();
    if (visited.has(schemaObj)) return;
    visited.add(schemaObj);

    if (schemaObj.childSchemas) {
      for (const child of schemaObj.childSchemas) {
        if (child.schema) {
          result.push(child.schema);
          _collectAllSubSchemas(child.schema, result, visited);
        }
      }
    }
  }

  function _resolveModel(nameOrModel) {
    if (!nameOrModel) return null;
    if (typeof nameOrModel === 'function' && nameOrModel.modelName) return nameOrModel;
    if (typeof nameOrModel === 'string') {
      return modelConnection._models[nameOrModel] || connection._models[nameOrModel] || null;
    }
    return null;
  }

  async function _populateSingleDoc(doc, opts, refModel) {
    const val = _getNestedValue(doc, opts.path);
    if (!val) return;
    const findFilter = { _id: val };
    let refDoc;
    if (opts.select) {
      refDoc = await refModel.collection.findOne(findFilter, {
        projection: typeof opts.select === 'string' ? _parseSelect(opts.select) : opts.select
      });
    } else {
      refDoc = await refModel.collection.findOne(findFilter);
    }
    if (refDoc) {
      _setNestedValue(doc, opts.path, refDoc);
      if (opts.populate) {
        const nestedPops = Array.isArray(opts.populate) ? opts.populate : [opts.populate];
        for (const np of nestedPops) {
          const npOpts = typeof np === 'string' ? { path: np } : np;
          if (npOpts.model) {
            const nestedRefModel = _resolveModel(npOpts.model);
            if (nestedRefModel) {
              await _populateSingleDoc(refDoc, npOpts, nestedRefModel);
            }
          }
        }
      }
    }
  }

  // ─── paginate() — Built-in mongoose-paginate-v2 compatible ──────────────

  Model.paginate = async function (query = {}, options = {}) {
    await Model._waitForConnection();

    const {
      select,
      sort,
      populate: populateOpt,
      lean = false,
      leanWithId = true,
      offset,
      page = 1,
      limit = 10,
      customLabels = {},
      pagination = true,
      projection,
      options: queryOptions,
      allowDiskUse = false,
      forceCountFn = false,
      useEstimatedCount = false,
      useCustomCountFn,
      collation,
      read,
    } = options;

    const labelDocs       = customLabels.docs       || 'docs';
    const labelTotalDocs  = customLabels.totalDocs  || 'totalDocs';
    const labelLimit      = customLabels.limit      || 'limit';
    const labelPage       = customLabels.page       || 'page';
    const labelTotalPages = customLabels.totalPages || 'totalPages';
    const labelHasNextPage     = customLabels.hasNextPage     || 'hasNextPage';
    const labelHasPrevPage     = customLabels.hasPrevPage     || 'hasPrevPage';
    const labelNextPage        = customLabels.nextPage        || 'nextPage';
    const labelPrevPage        = customLabels.prevPage        || 'prevPage';
    const labelPagingCounter   = customLabels.pagingCounter   || 'pagingCounter';
    const labelMeta            = customLabels.meta;

    const normalizedFilter = _normalizeFilter(query);
    const skip = offset !== undefined ? offset : (page - 1) * limit;

    let countPromise;
    if (useEstimatedCount) {
      countPromise = Model.collection.estimatedDocumentCount();
    } else if (typeof useCustomCountFn === 'function') {
      countPromise = useCustomCountFn(normalizedFilter);
    } else {
      const countOpts = {};
      if (collation) countOpts.collation = collation;
      countPromise = Model.collection.countDocuments(normalizedFilter, countOpts);
    }

    let cursor = Model.collection.find(normalizedFilter);
    const proj = projection || (select ? _parseSelect(select) : null);
    if (proj) cursor = cursor.project(proj);
    if (sort) cursor = cursor.sort(typeof sort === 'string' ? _parseSortString(sort) : sort);
    if (collation) cursor = cursor.collation(collation);

    if (pagination !== false) {
      cursor = cursor.skip(skip).limit(limit);
    }

    const [totalDocs, rawDocs] = await Promise.all([countPromise, cursor.toArray()]);

    let docs;
    if (lean) {
      docs = rawDocs;
      if (leanWithId) {
        docs = rawDocs.map(d => {
          if (d._id && !d.id) d.id = d._id.toString();
          return d;
        });
      }
    } else {
      docs = rawDocs.map(d => new Document(d, schema, Model));
    }

    if (populateOpt) {
      const pops = Array.isArray(populateOpt) ? populateOpt : [populateOpt];
      for (const pop of pops) {
        for (const doc of docs) {
          await Model._populateDoc(doc, typeof pop === 'string' ? { path: pop } : pop);
        }
      }
    }

    const totalPages = limit > 0 ? Math.ceil(totalDocs / limit) : 1;
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    const meta = {
      [labelTotalDocs]: totalDocs,
      [labelLimit]: limit,
      [labelTotalPages]: totalPages,
      [labelPage]: page,
      [labelHasPrevPage]: hasPrevPage,
      [labelHasNextPage]: hasNextPage,
      [labelPrevPage]: hasPrevPage ? page - 1 : null,
      [labelNextPage]: hasNextPage ? page + 1 : null,
      [labelPagingCounter]: (page - 1) * limit + 1,
    };

    if (labelMeta) {
      return { [labelDocs]: docs, [labelMeta]: meta };
    }

    return { [labelDocs]: docs, ...meta };
  };

  // ─── aggregatePaginate() — Built-in mongoose-aggregate-paginate-v2 compatible ─

  Model.aggregatePaginate = async function (aggregate, options = {}) {
    await Model._waitForConnection();

    const {
      page = 1,
      limit = 10,
      sort: sortOpt,
      customLabels = {},
      allowDiskUse = false,
      countQuery,
    } = options;

    const labelDocs       = customLabels.docs       || 'docs';
    const labelTotalDocs  = customLabels.totalDocs  || 'totalDocs';
    const labelLimit      = customLabels.limit      || 'limit';
    const labelPage       = customLabels.page       || 'page';
    const labelTotalPages = customLabels.totalPages || 'totalPages';
    const labelHasNextPage     = customLabels.hasNextPage     || 'hasNextPage';
    const labelHasPrevPage     = customLabels.hasPrevPage     || 'hasPrevPage';
    const labelNextPage        = customLabels.nextPage        || 'nextPage';
    const labelPrevPage        = customLabels.prevPage        || 'prevPage';
    const labelPagingCounter   = customLabels.pagingCounter   || 'pagingCounter';

    let pipeline;
    if (aggregate && typeof aggregate.pipeline === 'function') {
      pipeline = [...aggregate.pipeline()];
    } else if (Array.isArray(aggregate)) {
      pipeline = [...aggregate];
    } else {
      pipeline = [];
    }

    const skip = (page - 1) * limit;

    const countPipeline = [...pipeline, { $count: 'totalCount' }];

    const dataPipeline = [...pipeline];
    if (sortOpt) dataPipeline.push({ $sort: typeof sortOpt === 'string' ? _parseSortString(sortOpt) : sortOpt });
    dataPipeline.push({ $skip: skip });
    dataPipeline.push({ $limit: limit });

    const aggOpts = {};
    if (allowDiskUse) aggOpts.allowDiskUse = true;

    const [countResult, docs] = await Promise.all([
      countQuery
        ? (typeof countQuery === 'function' ? countQuery() : countQuery)
        : Model.collection.aggregate(countPipeline, aggOpts).toArray(),
      Model.collection.aggregate(dataPipeline, aggOpts).toArray(),
    ]);

    let totalDocs;
    if (typeof countResult === 'number') {
      totalDocs = countResult;
    } else if (Array.isArray(countResult) && countResult.length > 0) {
      totalDocs = countResult[0].totalCount || 0;
    } else {
      totalDocs = 0;
    }

    const totalPages = limit > 0 ? Math.ceil(totalDocs / limit) : 1;
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    return {
      [labelDocs]: docs,
      [labelTotalDocs]: totalDocs,
      [labelLimit]: limit,
      [labelPage]: page,
      [labelTotalPages]: totalPages,
      [labelHasPrevPage]: hasPrevPage,
      [labelHasNextPage]: hasNextPage,
      [labelPrevPage]: hasPrevPage ? page - 1 : null,
      [labelNextPage]: hasNextPage ? page + 1 : null,
      [labelPagingCounter]: (page - 1) * limit + 1,
    };
  };

  // ─── schema statics ──────────────────────────────────────────────────────

  for (const [name, fn] of Object.entries(schema.statics)) {
    Model[name] = fn.bind(Model);
  }

  // ─── query helpers ──────────────────────────────────────────────────────

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

var _castFilterDates = require('./castFilterDates');

/**
 * Check if an update object contains any MongoDB atomic/update operators.
 * Mongoose auto-wraps plain objects in $set if no operators are found.
 */
function _hasAtomicOperators(update) {
  if (!update || typeof update !== 'object') return false;
  const keys = Object.keys(update);
  return keys.some(function(key) { return key.charAt(0) === '$'; });
}

/**
 * Wrap a plain update object in $set if it doesn't contain any atomic operators.
 * This matches Mongoose's behavior where Model.updateOne(filter, { status: "success" })
 * is automatically treated as Model.updateOne(filter, { $set: { status: "success" } }).
 */
function _wrapInSetIfNeeded(update) {
  if (!update || typeof update !== 'object') return update;
  if (_hasAtomicOperators(update)) return update;
  // Plain object without operators — wrap in $set (Mongoose-compatible behavior)
  return { $set: update };
}

function _addTimestamps(update, schema) {
  // First, wrap plain objects in $set if needed (Mongoose compatibility)
  update = _wrapInSetIfNeeded(update);
  if (!schema._timestamps) return update;
  const key = schema._timestamps.updatedAt;
  if (!key) return update;
  if (update.$set) { return { ...update, $set: { ...update.$set, [key]: new Date() } }; }
  return { ...update, $set: { [key]: new Date() } };
}

function _getNestedValue(obj, path) {
  if (!obj || !path) return undefined;
  const parts = path.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    // Support both Document instances (with toObject) and plain objects
    if (typeof cur.toObject === 'function' && typeof cur[part] === 'undefined') {
      cur = cur.toObject()[part];
    } else {
      cur = cur[part];
    }
  }
  return cur;
}

function _setNestedValue(obj, path, value) {
  if (!obj || !path) return;
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function _parseSelect(select) {
  if (typeof select === 'object' && !Array.isArray(select)) return select;
  if (typeof select === 'string') {
    const proj = {};
    for (const f of select.trim().split(/\s+/)) {
      if (!f) continue;
      if (f.startsWith('-')) proj[f.slice(1)] = 0;
      else proj[f] = 1;
    }
    return proj;
  }
  return null;
}

function _parseSortString(sort) {
  if (typeof sort !== 'string') return sort;
  const result = {};
  for (const f of sort.trim().split(/\s+/)) {
    if (!f) continue;
    if (f.startsWith('-')) result[f.slice(1)] = -1;
    else result[f] = 1;
  }
  return result;
}

/**
 * Apply schema defaults to a data object.
 * Walks all schema paths and applies default values for missing fields.
 * This matches Mongoose's behavior where schema defaults are applied on insert.
 */
function _applyDefaults(data, schema) {
  try {
    for (const [fieldPath, schemaType] of Object.entries(schema.paths)) {
      if (fieldPath === '_id') continue;
      if (fieldPath === schema.options.versionKey) continue;
      if (schema._timestamps && (fieldPath === schema._timestamps.createdAt || fieldPath === schema._timestamps.updatedAt)) continue;

      const parts = fieldPath.split('.');
      let cur = data;
      let exists = true;
      for (const part of parts) {
        if (cur == null || typeof cur !== 'object') { exists = false; break; }
        if (!(part in cur)) { exists = false; break; }
        cur = cur[part];
      }

      if (!exists) {
        // Apply default if value doesn't exist
        if (schemaType._defaultValue !== undefined) {
          const defaultVal = typeof schemaType._defaultValue === 'function'
            ? schemaType._defaultValue()
            : schemaType._defaultValue;
          let obj = data;
          for (let i = 0; i < parts.length - 1; i++) {
            if (obj[parts[i]] == null || typeof obj[parts[i]] !== 'object') {
              obj[parts[i]] = {};
            }
            obj = obj[parts[i]];
          }
          obj[parts[parts.length - 1]] = defaultVal;
        }
      } else if (cur !== undefined && cur !== null) {
        // Cast Date strings to Date objects (Mongoose compatibility)
        // This ensures $gte/$lt date range queries work correctly
        try {
          if (schemaType.instance === 'Date' && !(cur instanceof Date)) {
            const d = new Date(cur);
            if (!isNaN(d.getTime())) {
              let obj = data;
              for (let i = 0; i < parts.length - 1; i++) { obj = obj[parts[i]]; }
              obj[parts[parts.length - 1]] = d;
            }
          }
        } catch (_) { /* ignore cast errors */ }
      }
    }
  } catch (e) {
    // Don't let defaults/casting break the insert
  }
  return data;
}

module.exports = createModel;
