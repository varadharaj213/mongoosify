'use strict';

const Schema = require('../src/schema');
const SchemaTypes = require('../src/schematype');
const mongoose = require('../src');

describe('Schema definition', () => {
  test('registers paths correctly', () => {
    const s = new Schema({ name: String, age: Number });
    expect(s.paths.name.instance).toBe('String');
    expect(s.paths.age.instance).toBe('Number');
  });

  test('handles { type: String } syntax', () => {
    const s = new Schema({ email: { type: String, required: true } });
    expect(s.paths.email.instance).toBe('String');
  });

  test('adds _id path by default', () => {
    const s = new Schema({ name: String });
    expect(s.paths._id).toBeDefined();
  });

  test('adds timestamps when option set', () => {
    const s = new Schema({ name: String }, { timestamps: true });
    expect(s.paths.createdAt).toBeDefined();
    expect(s.paths.updatedAt).toBeDefined();
  });

  test('adds __v versionKey by default', () => {
    const s = new Schema({ name: String });
    expect(s.paths.__v).toBeDefined();
  });

  test('can disable versionKey', () => {
    const s = new Schema({ name: String }, { versionKey: false });
    expect(s.paths.__v).toBeUndefined();
  });

  test('registers indexes', () => {
    const s = new Schema({ email: String });
    s.index({ email: 1 }, { unique: true });
    expect(s._indexes.length).toBe(1);
    expect(s._indexes[0].options.unique).toBe(true);
  });

  test('registers pre/post hooks', () => {
    const s = new Schema({ name: String });
    const fn = () => {};
    s.pre('save', fn);
    s.post('save', fn);
    expect(s._hooks.pre.save).toContain(fn);
    expect(s._hooks.post.save).toContain(fn);
  });

  test('registers virtuals', () => {
    const s = new Schema({ first: String, last: String });
    s.virtual('full').get(function () { return `${this.first} ${this.last}`; });
    expect(s.virtuals.full.get).toBeDefined();
  });

  test('registers methods and statics', () => {
    const s = new Schema({ name: String });
    s.methods.greet = function () { return `Hi ${this.name}`; };
    s.statics.findAll = function () { return this.find({}); };
    expect(typeof s.methods.greet).toBe('function');
    expect(typeof s.statics.findAll).toBe('function');
  });

  test('collectionName pluralizes correctly', () => {
    const s = new Schema({});
    expect(s.collectionName('User')).toBe('users');
    expect(s.collectionName('Category')).toBe('categories');
    expect(s.collectionName('Box')).toBe('boxes');
  });
});

describe('Schema validation', () => {
  test('validates required field', async () => {
    const s = new Schema({ name: { type: String, required: true } });
    await expect(s.validate({})).rejects.toThrow('required');
  });

  test('applies default value', async () => {
    const s = new Schema({ role: { type: String, default: 'user' } });
    const result = await s.validate({});
    expect(result.role).toBe('user');
  });

  test('applies function default', async () => {
    const s = new Schema({ code: { type: Number, default: () => 42 } });
    const result = await s.validate({});
    expect(result.code).toBe(42);
  });

  test('enforces enum', async () => {
    const s = new Schema({ role: { type: String, enum: ['admin', 'user'] } });
    await expect(s.validate({ role: 'superadmin' })).rejects.toThrow();
  });

  test('passes valid enum', async () => {
    const s = new Schema({ role: { type: String, enum: ['admin', 'user'] } });
    const r = await s.validate({ role: 'admin' });
    expect(r.role).toBe('admin');
  });

  test('casts number from string', async () => {
    const s = new Schema({ age: Number });
    const r = await s.validate({ age: '25' });
    expect(r.age).toBe(25);
  });

  test('trims strings', async () => {
    const s = new Schema({ name: { type: String, trim: true } });
    const r = await s.validate({ name: '  Alice  ' });
    expect(r.name).toBe('Alice');
  });

  test('lowercases strings', async () => {
    const s = new Schema({ email: { type: String, lowercase: true } });
    const r = await s.validate({ email: 'ALICE@TEST.COM' });
    expect(r.email).toBe('alice@test.com');
  });

  test('uppercases strings', async () => {
    const s = new Schema({ code: { type: String, uppercase: true } });
    const r = await s.validate({ code: 'abc' });
    expect(r.code).toBe('ABC');
  });

  test('validates minlength', async () => {
    const s = new Schema({ name: { type: String, minlength: 3 } });
    await expect(s.validate({ name: 'ab' })).rejects.toThrow();
  });

  test('validates maxlength', async () => {
    const s = new Schema({ name: { type: String, maxlength: 3 } });
    await expect(s.validate({ name: 'abcd' })).rejects.toThrow();
  });

  test('validates min number', async () => {
    const s = new Schema({ age: { type: Number, min: 18 } });
    await expect(s.validate({ age: 10 })).rejects.toThrow();
  });

  test('validates max number', async () => {
    const s = new Schema({ score: { type: Number, max: 100 } });
    await expect(s.validate({ score: 200 })).rejects.toThrow();
  });

  test('validates match regex', async () => {
    const s = new Schema({ email: { type: String, match: /^[\w.]+@\w+\.\w+$/ } });
    await expect(s.validate({ email: 'notanemail' })).rejects.toThrow();
  });

  test('validates custom validator', async () => {
    const s = new Schema({
      age: { type: Number, validate: { validator: v => v % 2 === 0, message: 'Must be even' } },
    });
    await expect(s.validate({ age: 3 })).rejects.toThrow('Must be even');
  });

  test('timestamps: adds createdAt and updatedAt', async () => {
    const s = new Schema({ name: String }, { timestamps: true });
    const r = await s.validate({ name: 'test' });
    expect(r.createdAt).toBeInstanceOf(Date);
    expect(r.updatedAt).toBeInstanceOf(Date);
  });
});

describe('SchemaTypes', () => {
  test('Boolean casts "true"', () => {
    const T = new SchemaTypes.Boolean('x', {});
    expect(T.cast('true')).toBe(true);
    expect(T.cast('false')).toBe(false);
    expect(T.cast(1)).toBe(true);
    expect(T.cast(0)).toBe(false);
  });

  test('Date casts ISO string', () => {
    const T = new SchemaTypes.Date('x', {});
    const d = T.cast('2024-01-01');
    expect(d).toBeInstanceOf(Date);
  });

  test('Number throws on NaN', () => {
    const T = new SchemaTypes.Number('x', {});
    expect(() => T.cast('not a number')).toThrow();
  });
});

describe('mongoosify.model()', () => {
  test('registers a model', () => {
    const s = new Schema({ name: String });
    const M = mongoose.model('TestModelA', s);
    expect(M.modelName).toBe('TestModelA');
  });

  test('retrieves registered model', () => {
    const s = new Schema({ name: String });
    mongoose.model('TestModelB', s);
    const M = mongoose.model('TestModelB');
    expect(M.modelName).toBe('TestModelB');
  });

  test('throws when retrieving unknown model', () => {
    expect(() => mongoose.model('NoSuchModel')).toThrow();
  });
});