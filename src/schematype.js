'use strict';

// Lazy-load ObjectId so the package works even before `npm install`
let ObjectId;
try { ({ ObjectId } = require('mongodb')); } catch { ObjectId = class ObjectId {}; }

// ─── Base SchemaType ──────────────────────────────────────────────────────────

class SchemaType {
  constructor(key, options, instance) {
    this.path = key;
    this.instance = instance;
    this.options = options || {};
    this.validators = [];
    this._defaultValue = undefined;

    if (options && options.required) this.required(options.required);
    if (options && options.default !== undefined) this.default(options.default);
    if (options && options.validate) this.validate(options.validate);
    if (options && options.enum) this.enum(options.enum);
  }

  default(val) {
    this._defaultValue = val;
    return this;
  }

  required(required, message) {
    const msg = Array.isArray(required)
      ? required[1]
      : (message || `Path \`${this.path}\` is required.`);
    const isRequired = Array.isArray(required) ? required[0] : required;
    if (isRequired) {
      this.validators.unshift({
        validator: (v) => v !== null && v !== undefined && v !== '',
        message: msg,
        type: 'required',
      });
    }
    return this;
  }

  validate(obj, errorMsg, type) {
    if (typeof obj === 'function') {
      this.validators.push({ validator: obj, message: errorMsg || `Validator failed for path \`${this.path}\``, type: type || 'user defined' });
    } else if (obj && typeof obj.validator === 'function') {
      this.validators.push({ validator: obj.validator, message: obj.message || `Validator failed for path \`${this.path}\``, type: type || 'user defined' });
    }
    return this;
  }

  enum(values) {
    const list = Array.isArray(values) ? values : Object.values(values);
    this.validators.push({
      validator: (v) => v === null || v === undefined || list.includes(v),
      message: `\`{VALUE}\` is not a valid enum value for path \`${this.path}\`.`,
      type: 'enum',
    });
    return this;
  }

  cast(val) { return val; }

  doValidate(value, fn, scope) {
    const errors = [];
    for (const { validator, message } of this.validators) {
      if (!validator.call(scope, value)) {
        errors.push(message.replace('{VALUE}', value).replace('{PATH}', this.path));
      }
    }
    if (errors.length) fn(new Error(errors.join(', ')));
    else fn(null);
  }
}

// ─── String ───────────────────────────────────────────────────────────────────

class StringSchemaType extends SchemaType {
  constructor(key, options) {
    super(key, options, 'String');
    if (options && options.minlength) this.minlength(options.minlength);
    if (options && options.maxlength) this.maxlength(options.maxlength);
    if (options && options.match) this.match(options.match);
    if (options && options.trim) this._trim = true;
    if (options && options.lowercase) this._lowercase = true;
    if (options && options.uppercase) this._uppercase = true;
  }

  minlength(val) {
    const min = Array.isArray(val) ? val[0] : val;
    const msg = Array.isArray(val) ? val[1] : `Path \`${this.path}\` (\`{VALUE}\`) is shorter than the minimum allowed length (${min}).`;
    this.validators.push({ validator: (v) => v === null || v === undefined || v.length >= min, message: msg, type: 'minlength' });
    return this;
  }

  maxlength(val) {
    const max = Array.isArray(val) ? val[0] : val;
    const msg = Array.isArray(val) ? val[1] : `Path \`${this.path}\` (\`{VALUE}\`) is longer than the maximum allowed length (${max}).`;
    this.validators.push({ validator: (v) => v === null || v === undefined || v.length <= max, message: msg, type: 'maxlength' });
    return this;
  }

  match(regExp) {
    const re = Array.isArray(regExp) ? regExp[0] : regExp;
    const msg = Array.isArray(regExp) ? regExp[1] : `Path \`${this.path}\` is invalid (\`{VALUE}\`).`;
    this.validators.push({ validator: (v) => v === null || v === undefined || re.test(v), message: msg, type: 'regexp' });
    return this;
  }

  cast(val) {
    if (val === null || val === undefined) return val;
    let str = String(val);
    if (this._trim) str = str.trim();
    if (this._lowercase) str = str.toLowerCase();
    if (this._uppercase) str = str.toUpperCase();
    return str;
  }
}

// ─── Number ───────────────────────────────────────────────────────────────────

class NumberSchemaType extends SchemaType {
  constructor(key, options) {
    super(key, options, 'Number');
    if (options && options.min !== undefined) this.min(options.min);
    if (options && options.max !== undefined) this.max(options.max);
  }

  min(val) {
    const min = Array.isArray(val) ? val[0] : val;
    const msg = Array.isArray(val) ? val[1] : `Path \`${this.path}\` (${min}) is less than minimum allowed value (${min}).`;
    this.validators.push({ validator: (v) => v === null || v === undefined || v >= min, message: msg, type: 'min' });
    return this;
  }

  max(val) {
    const max = Array.isArray(val) ? val[0] : val;
    const msg = Array.isArray(val) ? val[1] : `Path \`${this.path}\` (${max}) is more than maximum allowed value (${max}).`;
    this.validators.push({ validator: (v) => v === null || v === undefined || v <= max, message: msg, type: 'max' });
    return this;
  }

  cast(val) {
    if (val === null || val === undefined) return val;
    const n = Number(val);
    if (isNaN(n)) throw new Error(`Cast to Number failed for value "${val}" at path "${this.path}"`);
    return n;
  }
}

// ─── Boolean ──────────────────────────────────────────────────────────────────

class BooleanSchemaType extends SchemaType {
  constructor(key, options) { super(key, options, 'Boolean'); }
  cast(val) {
    if (val === null || val === undefined) return val;
    if (val === 'true' || val === '1' || val === 1) return true;
    if (val === 'false' || val === '0' || val === 0) return false;
    return Boolean(val);
  }
}

// ─── Date ─────────────────────────────────────────────────────────────────────

class DateSchemaType extends SchemaType {
  constructor(key, options) {
    super(key, options, 'Date');
    if (options && options.min) this.min(options.min);
    if (options && options.max) this.max(options.max);
  }
  min(val) {
    const min = val instanceof Date ? val : new Date(val);
    this.validators.push({ validator: (v) => !v || v >= min, message: `Path \`${this.path}\` is before minimum date.`, type: 'min' });
    return this;
  }
  max(val) {
    const max = val instanceof Date ? val : new Date(val);
    this.validators.push({ validator: (v) => !v || v <= max, message: `Path \`${this.path}\` is after maximum date.`, type: 'max' });
    return this;
  }
  cast(val) {
    if (val === null || val === undefined) return val;
    if (val instanceof Date) return val;
    const d = new Date(val);
    if (isNaN(d.getTime())) throw new Error(`Cast to Date failed for value "${val}" at path "${this.path}"`);
    return d;
  }
}

// ─── ObjectId ─────────────────────────────────────────────────────────────────

class ObjectIdSchemaType extends SchemaType {
  constructor(key, options) { super(key, options, 'ObjectId'); }
  cast(val) {
    if (val === null || val === undefined) return val;
    const { isObjectIdLike, toDriverObjectId } = require('./bson-sanitize');
    if (isObjectIdLike(val)) return toDriverObjectId(val);
    try { return new ObjectId(val); }
    catch { throw new Error(`Cast to ObjectId failed for value "${val}" at path "${this.path}"`); }
  }
}

// ─── Array ────────────────────────────────────────────────────────────────────

class ArraySchemaType extends SchemaType {
  constructor(key, options) { super(key, options, 'Array'); }
  cast(val) {
    if (val === null || val === undefined) return val;
    return Array.isArray(val) ? val : [val];
  }
}

// ─── Mixed ────────────────────────────────────────────────────────────────────

class MixedSchemaType extends SchemaType {
  constructor(key, options) { super(key, options, 'Mixed'); }
  cast(val) { return val; }
}

// ─── Buffer ───────────────────────────────────────────────────────────────────

class BufferSchemaType extends SchemaType {
  constructor(key, options) { super(key, options, 'Buffer'); }
  cast(val) {
    if (val === null || val === undefined) return val;
    if (Buffer.isBuffer(val)) return val;
    return Buffer.from(val);
  }
}

// ─── Map ──────────────────────────────────────────────────────────────────────

class MapSchemaType extends SchemaType {
  constructor(key, options) { super(key, options, 'Map'); }
  cast(val) {
    if (val === null || val === undefined) return val;
    if (val instanceof Map) return val;
    if (typeof val === 'object') return new Map(Object.entries(val));
    return val;
  }
}

// ─── SchemaTypes registry ─────────────────────────────────────────────────────

const SchemaTypes = {
  String: StringSchemaType,
  Number: NumberSchemaType,
  Boolean: BooleanSchemaType,
  Bool: BooleanSchemaType,
  Date: DateSchemaType,
  ObjectId: ObjectIdSchemaType,
  ObjectID: ObjectIdSchemaType,
  Oid: ObjectIdSchemaType,
  Array: ArraySchemaType,
  Mixed: MixedSchemaType,
  Object: MixedSchemaType,
  Buffer: BufferSchemaType,
  Map: MapSchemaType,

  // Resolve a JS constructor or string to a SchemaType class
  resolve(type) {
    if (!type) return MixedSchemaType;
    if (type === String || type === 'String') return StringSchemaType;
    if (type === Number || type === 'Number') return NumberSchemaType;
    if (type === Boolean || type === 'Boolean') return BooleanSchemaType;
    if (type === Date || type === 'Date') return DateSchemaType;
    if (type === Array || type === 'Array') return ArraySchemaType;
    if (type === Buffer || type === 'Buffer') return BufferSchemaType;
    if (type === Map || type === 'Map') return MapSchemaType;
    if (type === Object || type === 'Mixed' || type === 'Object') return MixedSchemaType;
    // MongoDB ObjectId
    if (type === ObjectId || type === 'ObjectId' || type === 'ObjectID') return ObjectIdSchemaType;
    if (type instanceof SchemaType || (type && type.prototype instanceof SchemaType)) return type;
    return MixedSchemaType;
  },
};

module.exports = SchemaTypes;
module.exports.SchemaType = SchemaType;