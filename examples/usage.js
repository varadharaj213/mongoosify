'use strict';

/**
 * Usage example — every line works exactly like Mongoose.
 * Replace: const mongoose = require('mongoose')
 * With:    const mongoose = require('mongoosify')
 */

const mongoose = require('../src');

mongoose.on('connected',    () => console.log('[event] connected'));
mongoose.on('disconnected', () => console.log('[event] disconnected'));
mongoose.on('error', (err) => console.error('[event] error:', err.message));

async function main() {

  // ── 1. Connect ────────────────────────────────────────────────────────────
  await mongoose.connect('mongodb://127.0.0.1:27017/mongoosify_test', {
    serverSelectionTimeoutMS: 5000,
  });

  // ── 2. Schema ─────────────────────────────────────────────────────────────
  const addressSchema = new mongoose.Schema({
    city    : { type: String, required: true },
    country : { type: String, default: 'India' },
  });

  const userSchema = new mongoose.Schema({
    name: {
      type      : String,
      required  : [true, 'Name is required'],
      trim      : true,
      minlength : 2,
      maxlength : 50,
    },
    email: {
      type      : String,
      required  : true,
      lowercase : true,
      match     : /^[\w.-]+@[\w.-]+\.\w+$/,
      unique    : true,
    },
    age: {
      type    : Number,
      min     : 0,
      max     : 120,
      default : 18,
    },
    role: {
      type    : String,
      enum    : ['admin', 'user', 'moderator'],
      default : 'user',
    },
    isActive : { type: Boolean, default: true },
    tags     : { type: Array,   default: [] },
    score    : { type: Number,  default: 0 },
    address  : addressSchema,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  }, {
    timestamps : true,       // adds createdAt, updatedAt
    versionKey : '__v',      // version field
    strict     : true,
  });

  // ── 3. Virtuals ───────────────────────────────────────────────────────────
  userSchema.virtual('info').get(function () {
    return `${this.name} <${this.email}>`;
  });

  // ── 4. Instance methods ───────────────────────────────────────────────────
  userSchema.methods.greet = function () {
    return `Hello! I'm ${this.name} and my role is ${this.role}.`;
  };

  userSchema.methods.promote = async function () {
    this.role = 'admin';
    return this.save();
  };

  // ── 5. Static methods ─────────────────────────────────────────────────────
  userSchema.statics.findAdmins = function () {
    return this.find({ role: 'admin' });
  };

  userSchema.statics.findByEmail = function (email) {
    return this.findOne({ email: email.toLowerCase() });
  };

  // ── 6. Middleware (hooks) ─────────────────────────────────────────────────
  userSchema.pre('save', function (next) {
    console.log(`  [pre save] ${this.isNew() ? 'inserting' : 'updating'}: ${this.name}`);
    next();
  });

  userSchema.post('save', function (doc) {
    console.log(`  [post save] saved: ${doc.name} (_id: ${doc._id})`);
  });

  userSchema.pre('remove', function (next) {
    console.log(`  [pre remove] removing: ${this.name}`);
    next();
  });

  // ── 7. Indexes ────────────────────────────────────────────────────────────
  userSchema.index({ email: 1 }, { unique: true });
  userSchema.index({ role: 1, createdAt: -1 });

  // ── 8. Register model ─────────────────────────────────────────────────────
  const User = mongoose.model('User', userSchema);

  // Clean slate
  await User.deleteMany({});

  // ── 9. new Model() + save() ───────────────────────────────────────────────
  console.log('\n── new User() + save() ──');
  const alice = new User({ name: 'Alice', email: 'alice@example.com', age: 28, role: 'admin' });
  await alice.save();
  console.log('  saved:', alice.toObject());
  console.log('  virtual info:', alice.info);
  console.log('  method greet:', alice.greet());

  // ── 10. Model.create() ────────────────────────────────────────────────────
  console.log('\n── Model.create() ──');
  const bob = await User.create({ name: 'Bob', email: 'bob@example.com', age: 30 });
  console.log('  created:', bob.name, bob.email);

  // ── 11. Model.insertMany() ────────────────────────────────────────────────
  console.log('\n── insertMany() ──');
  await User.insertMany([
    { name: 'Charlie', email: 'charlie@example.com', age: 22 },
    { name: 'Diana',   email: 'diana@example.com',   age: 35, role: 'moderator' },
  ]);
  console.log('  inserted 2 users');

  // ── 12. find() with chaining ──────────────────────────────────────────────
  console.log('\n── find().sort().limit().select() ──');
  const users = await User.find({ isActive: true })
    .sort('-createdAt')
    .limit(10)
    .select('name email age role');
  console.log('  found:', users.map(u => u.name));

  // ── 13. findOne() ─────────────────────────────────────────────────────────
  console.log('\n── findOne() ──');
  const found = await User.findOne({ email: 'alice@example.com' });
  console.log('  found one:', found?.name);

  // ── 14. findById() ────────────────────────────────────────────────────────
  console.log('\n── findById() ──');
  const byId = await User.findById(alice._id);
  console.log('  found by id:', byId?.name);

  // ── 15. findByIdAndUpdate() ───────────────────────────────────────────────
  console.log('\n── findByIdAndUpdate() ──');
  const updated = await User.findByIdAndUpdate(
    alice._id,
    { $set: { score: 100 } },
    { new: true }
  );
  console.log('  updated alice score:', updated?.score);

  // ── 16. updateOne() ───────────────────────────────────────────────────────
  console.log('\n── updateOne() ──');
  const res = await User.updateOne({ email: 'bob@example.com' }, { $set: { age: 31 } });
  console.log('  updateOne result:', res.modifiedCount);

  // ── 17. updateMany() ──────────────────────────────────────────────────────
  console.log('\n── updateMany() ──');
  const res2 = await User.updateMany({ role: 'user' }, { $set: { isActive: true } });
  console.log('  updateMany result:', res2.modifiedCount);

  // ── 18. countDocuments() ──────────────────────────────────────────────────
  console.log('\n── countDocuments() ──');
  const count = await User.countDocuments({ isActive: true });
  console.log('  active count:', count);

  // ── 19. exists() ──────────────────────────────────────────────────────────
  console.log('\n── exists() ──');
  const ex = await User.exists({ email: 'alice@example.com' });
  console.log('  alice exists:', !!ex);

  // ── 20. lean() ────────────────────────────────────────────────────────────
  console.log('\n── find().lean() ──');
  const leanUsers = await User.find({}).lean();
  console.log('  lean (plain objects):', leanUsers.map(u => u.name));

  // ── 21. Static methods ────────────────────────────────────────────────────
  console.log('\n── schema.statics ──');
  const admins = await User.findAdmins();
  console.log('  admins:', admins.map(a => a.name));

  const byEmail = await User.findByEmail('bob@example.com');
  console.log('  findByEmail:', byEmail?.name);

  // ── 22. aggregate() ───────────────────────────────────────────────────────
  console.log('\n── aggregate() ──');
  const agg = await User.aggregate([
    { $match: { isActive: true } },
    { $group: { _id: '$role', count: { $sum: 1 } } },
    { $sort:  { count: -1 } },
  ]);
  console.log('  aggregation:', agg);

  // ── 23. distinct() ────────────────────────────────────────────────────────
  console.log('\n── distinct() ──');
  const roles = await User.distinct('role');
  console.log('  distinct roles:', roles);

  // ── 24. Instance promote() method ────────────────────────────────────────
  console.log('\n── instance method promote() ──');
  const bobDoc = await User.findOne({ email: 'bob@example.com' });
  await bobDoc.promote();
  console.log('  bob promoted to:', bobDoc.role);

  // ── 25. isModified / markModified ────────────────────────────────────────
  console.log('\n── isModified / markModified ──');
  const charlie = await User.findOne({ email: 'charlie@example.com' });
  charlie.score = 50;
  charlie.markModified('score');
  console.log('  isModified(score):', charlie.isModified('score'));
  await charlie.save();

  // ── 26. toObject / toJSON ─────────────────────────────────────────────────
  console.log('\n── toObject() / toJSON() ──');
  const plain = alice.toObject();
  console.log('  type:', typeof plain, '| _id:', plain._id.toString());

  // ── 27. deleteOne() on instance ───────────────────────────────────────────
  console.log('\n── instance.remove() ──');
  const diana = await User.findOne({ email: 'diana@example.com' });
  await diana.remove();
  console.log('  diana removed');

  // ── 28. Model.deleteMany() ────────────────────────────────────────────────
  console.log('\n── deleteMany() ──');
  await User.deleteMany({});
  const remaining = await User.countDocuments();
  console.log('  remaining after deleteMany:', remaining);

  // ── 29. Validation error ──────────────────────────────────────────────────
  console.log('\n── Validation error ──');
  try {
    await User.create({ email: 'no-name@example.com' }); // missing required name
  } catch (err) {
    console.log('  caught:', err.name, '-', err.message);
  }

  // Done
  await mongoose.disconnect();
  console.log('\nAll done!');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});