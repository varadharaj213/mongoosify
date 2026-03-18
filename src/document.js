'use strict';

const { ObjectId } = require('mongodb');

class Document {
  constructor(data = {}, schema, model) {
    // Internal props (non-enumerable so they don't appear in toObject())
    Object.defineProperty(this, '$__schema',   { value: schema,  writable: true });
    Object.defineProperty(this, '$__model',    { value: model,   writable: true });
    Object.defineProperty(this, '$__isNew',    { value: !data._id, writable: true });
    Object.defineProperty(this, '$__modified', { value: new Set(), writable: true });
    Object.defineProperty(this, '$__original', { value: {},      writable: true });
    Object.defineProperty(this, 'errors',      { value: {},      writable: true, enumerable: false });

    // Assign _id first
    if (!data._id) {
      this._id = new ObjectId();
    }

    // Assign all data fields
    this._assignData(data);

    // Snapshot for dirty-check
    this.$__original = JSON.parse(JSON.stringify(this._toRaw()));

    // Bind instance methods from schema
    for (const [name, fn] of Object.entries(schema.methods)) {
      Object.defineProperty(this, name, { value: fn.bind(this), writable: true });
    }

    // Apply virtuals via defineProperty
    this._applyVirtuals();
  }

  // ─── Assign data ──────────────────────────────────────────────────────────

  _assignData(data) {
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('$__')) continue;
      this[key] = value;
    }
  }

  // ─── Virtuals ─────────────────────────────────────────────────────────────

  _applyVirtuals() {
    for (const [name, descriptor] of Object.entries(this.$__schema.virtuals)) {
      Object.defineProperty(this, name, {
        get: descriptor.get ? descriptor.get.bind(this) : undefined,
        set: descriptor.set ? descriptor.set.bind(this) : undefined,
        enumerable: false,   // virtuals do NOT appear in toObject() by default
        configurable: true,
      });
    }
  }

  // ─── get / set (Mongoose-style) ─────────────────────────────────────────

  get(path) {
    const parts = path.split('.');
    let cur = this;
    for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
    return cur;
  }

  set(path, value) {
    const parts = path.split('.');
    if (parts.length === 1) {
      this[path] = value;
      this.$__modified.add(path);
      return this;
    }
    let cur = this;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]]) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    this.$__modified.add(parts[0]);
    return this;
  }

  // ─── isModified / markModified ───────────────────────────────────────────

  isModified(path) {
    if (!path) return this.$__modified.size > 0;
    return this.$__modified.has(path);
  }

  markModified(path) {
    this.$__modified.add(path);
    return this;
  }

  isNew() { return this.$__isNew; }

  // ─── validate ────────────────────────────────────────────────────────────

  async validate() {
    const plain = this._toRaw();
    await this.$__schema.validate(plain, false);
    return this;
  }

  // ─── save ────────────────────────────────────────────────────────────────

  async save() {
    // Run pre('save') hooks
    await this._runHooks('pre', 'save');

    const plain = this._toRaw();

    if (this.$__isNew) {
      // Validate
      const validated = await this.$__schema.validate(plain, false);
      Object.assign(this, validated);

      // Insert
      await this.$__model.collection.insertOne(this._toRaw());
      this.$__isNew = false;
    } else {
      // Validate as update
      const validated = await this.$__schema.validate(plain, true);
      Object.assign(this, validated);

      await this.$__model.collection.replaceOne(
        { _id: this._id },
        this._toRaw(),
        { upsert: false }
      );
    }

    this.$__modified.clear();

    // Run post('save') hooks
    await this._runHooks('post', 'save');

    return this;
  }

  // ─── remove / deleteOne ──────────────────────────────────────────────────

  async remove() {
    await this._runHooks('pre', 'remove');
    await this.$__model.collection.deleteOne({ _id: this._id });
    await this._runHooks('post', 'remove');
    return this;
  }

  async deleteOne() { return this.remove(); }

  // ─── populate ────────────────────────────────────────────────────────────

  async populate(path) {
    return this.$__model.populate(this, path);
  }

  // ─── toObject / toJSON ───────────────────────────────────────────────────

  toObject(options = {}) {
    const raw = this._toRaw();
    // Include virtuals if requested
    if (options.virtuals) {
      for (const [name, descriptor] of Object.entries(this.$__schema.virtuals)) {
        if (descriptor.get) {
          try { raw[name] = descriptor.get.call(this); } catch {}
        }
      }
    }
    return raw;
  }

  toJSON() {
    return this.toObject();
  }

  _toRaw() {
    const raw = {};
    for (const key of Object.keys(this)) {
      if (typeof key === 'string' && !key.startsWith('$__')) {
        raw[key] = this[key];
      }
    }
    return raw;
  }

  // ─── toString ────────────────────────────────────────────────────────────

  toString() {
    return JSON.stringify(this.toObject());
  }

  inspect() { return this.toObject(); }

  // ─── Hooks runner ────────────────────────────────────────────────────────

  async _runHooks(type, event) {
    const hooks = (this.$__schema._hooks[type][event]) || [];
    for (const fn of hooks) {
      await new Promise((resolve, reject) => {
        const result = fn.call(this, (err) => { if (err) reject(err); else resolve(); });
        // If it returned a promise, await it
        if (result && typeof result.then === 'function') result.then(resolve).catch(reject);
        // If no next() parameter in signature, auto-resolve
        else if (fn.length === 0) resolve();
      });
    }
  }
}

module.exports = Document;