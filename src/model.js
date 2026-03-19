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

  // ─── Connection buffering ────────────────────────────────────���──────────
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

  // ─���─ findOne() ──────────────────────────────────────────────────────────

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
    const { new: returnNew = false, upsert = false, runValidators = false, projection,
            returnNewDocument = false } = options;
    const shouldReturnNew = returnNew || returnNewDocument;

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
      { returnDocument: shouldReturnNew ? 'after' : 'before', upsert, projection }
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
      // Compute the full localField path by using the populate path's prefix
      // e.g. popPath = "finalDetails.salesInformation.payFacFinal"
      //      localField from virtual = "aggregator"
      //      fullLocalField = "finalDetails.salesInformation.aggregator"
      const pathParts = popPath.split('.');
      const prefix = pathParts.slice(0, pathParts.length - 1).join('.');
      const fullLocalField = prefix ? `${prefix}.${localField}` : localField;

      const refModel = _resolveModel(ref);
      if (refModel) {
        // Collect all local field values from docs using the full path
        const localValues = arr.map(d => _getNestedValue(d, fullLocalField)).filter(v => v != null);
        if (localValues.length) {
          let refDocs;
          if (popSelect) {
            refDocs = await refModel.collection.find({ [foreignField]: { $in: localValues } })
              .project(typeof popSelect === 'string' ? _parseSelect(popSelect) : popSelect).toArray();
          } else {
            refDocs = await refModel.collection.find({ [foreignField]: { $in: localValues } }).toArray();
          }
          // Build map: foreignField value → doc(s)
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
              // Handle nested populate
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

  /**
   * Recursively search schema and nested sub-schemas for a virtual populate
   * definition matching the given dot-notation path.
   * e.g. path = "finalDetails.salesInformation.payFacFinal"
   */
  function _findVirtualPopulate(schemaObj, path) {
    if (!schemaObj || !path) return null;

    // Direct match on this schema's virtuals
    if (schemaObj.virtuals[path] && schemaObj.virtuals[path].options && schemaObj.virtuals[path].options.ref) {
      return schemaObj.virtuals[path].options;
    }

    // Extract the leaf name (last segment of dot-notation path)
    // e.g. "finalDetails.salesInformation.payFacFinal" → "payFacFinal"
    const parts = path.split('.');
    const leafName = parts[parts.length - 1];

    // 1. Recursively collect ALL Schema instances from the entire schema tree
    //    and check each one's virtuals for the leaf name
    const allSubSchemas = [];
    _collectAllSubSchemas(schemaObj, allSubSchemas);
    for (const subSchema of allSubSchemas) {
      if (subSchema.virtuals[leafName] && subSchema.virtuals[leafName].options && subSchema.virtuals[leafName].options.ref) {
        return subSchema.virtuals[leafName].options;
      }
    }

    // 2. Also scan ALL registered models' schemas (covers cross-model virtuals)
    const allModels = { ...modelConnection._models, ...connection._models };
    for (const mName of Object.keys(allModels)) {
      const m = allModels[mName];
      if (!m.schema) continue;
      // Check the model schema itself
      if (m.schema.virtuals[leafName] && m.schema.virtuals[leafName].options && m.schema.virtuals[leafName].options.ref) {
        return m.schema.virtuals[leafName].options;
      }
      // Check all sub-schemas of this model
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

  /**
   * Recursively collect all Schema instances from a schema's childSchemas tree.
   * This walks the entire nested schema hierarchy.
   */
  function _collectAllSubSchemas(schemaObj, result, visited) {
    if (!schemaObj) return;
    if (!visited) visited = new Set();
    if (visited.has(schemaObj)) return; // prevent infinite loops
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

  /**
   * Resolve a model by name or by Model class reference.
   */
  function _resolveModel(nameOrModel) {
    if (!nameOrModel) return null;
    if (typeof nameOrModel === 'function' && nameOrModel.modelName) return nameOrModel;
    if (typeof nameOrModel === 'string') {
      return modelConnection._models[nameOrModel] || connection._models[nameOrModel] || null;
    }
    return null;
  }

  /**
   * Populate a single plain doc (not a Document instance) with a ref field.
   */
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
      // Recurse for nested populate
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
  // This is a built-in implementation so the external plugin is optional.
  // API: Model.paginate(query, options) → { docs, totalDocs, limit, page, totalPages, ... }

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

    // Labels
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

    // Count
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

    // Build find cursor
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

    // Populate
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

    // Labels
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

    // Get the pipeline from the Aggregate object or array
    let pipeline;
    if (aggregate && typeof aggregate.pipeline === 'function') {
      pipeline = [...aggregate.pipeline()];
    } else if (Array.isArray(aggregate)) {
      pipeline = [...aggregate];
    } else {
      pipeline = [];
    }

    const skip = (page - 1) * limit;

    // Count pipeline: same pipeline but ending with $count
    const countPipeline = [...pipeline, { $count: 'totalCount' }];

    // Data pipeline: add sort, skip, limit
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

  // ─── query helpers ──────────────────────────────────────────��────────────

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

module.exports = createModel;
