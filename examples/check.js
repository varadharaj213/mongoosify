'use strict';

const mongoosify = require('../src');
const { Schema } = mongoosify;


// ─── Schema ───────────────────────────────────────────────────────────────────

const studentSchema = new Schema(
  {
    name:  { type: String, required: true, trim: true },
    age:   { type: Number, required: true },
    mark:  { type: Number, required: true },
    place: { type: String, required: true, trim: true },
    grade: { type: String, default: 'N/A' },
  },
  {
    collection : 'studenttest',
    timestamps : true,
  }
);

// ─── Instance Method ──────────────────────────────────────────────────────────

studentSchema.methods.getInfo = function () {
  return `${this.name} | Age: ${this.age} | Mark: ${this.mark} | Place: ${this.place}`;
};

// ─── Static Method ────────────────────────────────────────────────────────────

studentSchema.statics.findByPlace = function (place) {
  return this.find({ place });
};

// ─── Virtual ─────────────────────────────────────────────────────────────────

studentSchema.virtual('summary').get(function () {
  return `${this.name} scored ${this.mark} marks`;
});

// ─── Hooks ───────────────────────────────────────────────────────────────────

studentSchema.pre('save', function (next) {
  console.log(`  [hook] pre-save triggered for: ${this.name}`);
  next();
});

studentSchema.post('save', function (next) {
  console.log(`  [hook] post-save triggered for: ${this.name}`);
  next();
});

// ─── Model ───────────────────────────────────────────────────────────────────

const Student = mongoosify.model('Student', studentSchema);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sep(title) {
  console.log('\n' + '─'.repeat(60));
  console.log(` ${title}`);
  console.log('─'.repeat(60));
}

function printDoc(doc) {
  if (!doc) return console.log('  (null)');
  if (doc.toObject) console.log(' ', doc.toObject());
  else console.log(' ', doc);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {

  await mongoosify.connect('mongodb://raja:kBSjis0SK8MK1AwP@10.62.9.142:27017,10.62.9.143:27017,10.62.8.77:27017/mms?replicaSet=myReplicaSet&authSource=admin');
  console.log('Connected to MongoDB');

  // ── Clean slate ─────────────────────────────────────────────────────────────
  sep('0. deleteMany — clear collection before starting');
  const cleared = await Student.deleteMany({});
  console.log('  Cleared:', cleared);

  // ══════════════════════════════════════════════════════════════════════════════
  // 1. create()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('1. create() — single document');
  const arun = await Student.create({
    name: 'Arun Kumar', age: 20, mark: 88, place: 'Chennai',
  });
  console.log('  Created:');
  printDoc(arun);
  console.log('  Instance method getInfo():', arun.getInfo());

  // ══════════════════════════════════════════════════════════════════════════════
  // 2. insertMany()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('2. insertMany() — multiple documents');
  const inserted = await Student.insertMany([
    { name: 'Priya S',   age: 21, mark: 92, place: 'Coimbatore' },
    { name: 'Ravi M',    age: 19, mark: 74, place: 'Madurai'    },
    { name: 'Divya R',   age: 22, mark: 65, place: 'Chennai'    },
    { name: 'Karthik V', age: 20, mark: 55, place: 'Salem'      },
  ]);
  console.log(`  Inserted ${inserted.length} documents`);
  inserted.forEach(d => console.log('  -', d.toObject()));

  // ══════════════════════════════════════════════════════════════════════════════
  // 3. find()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('3. find() — all documents');
  const all = await Student.find();
  console.log(`  Total: ${all.length}`);
  all.forEach(d => console.log('  -', d.getInfo()));

  // ── find() with filter ───────────────────────────────────────────────────────
  sep('3a. find() — filter by place = Chennai');
  const chennaiStudents = await Student.find({ place: 'Chennai' });
  console.log(`  Found ${chennaiStudents.length} student(s)`);
  chennaiStudents.forEach(d => console.log('  -', d.getInfo()));

  // ── find() with sort, limit, skip ───────────────────────────────────────────
  sep('3b. find() — sort by mark DESC, limit 3, skip 1');
  const paged = await Student.find().sort({ mark: -1 }).skip(1).limit(3);
  console.log('  Results:');
  paged.forEach(d => console.log(`  - ${d.name}: ${d.mark}`));

  // ── find() with select (projection) ─────────────────────────────────────────
  sep('3c. find() — select only name and mark');
  const projected = await Student.find().select('name mark');
  projected.forEach(d => console.log('  -', d.toObject()));

  // ── find() with lean() ───────────────────────────────────────────────────────
  sep('3d. find() — lean() returns plain objects');
  const lean = await Student.find({ place: 'Chennai' }).lean();
  lean.forEach(d => console.log('  -', d));

  // ══════════════════════════════════════════════════════════════════════════════
  // 4. findOne()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('4. findOne()');
  const one = await Student.findOne({ name: 'Ravi M' });
  console.log('  Found:');
  printDoc(one);

  // ══════════════════════════════════════════════════════════════════════════════
  // 5. findById()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('5. findById()');
  const byId = await Student.findById(arun._id);
  console.log('  Found by ID:');
  printDoc(byId);

  // ══════════════════════════════════════════════════════════════════════════════
  // 6. updateOne()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('6. updateOne() — update Ravi M mark to 80');
  const upOne = await Student.updateOne({ name: 'Ravi M' }, { $set: { mark: 80 } });
  console.log('  Result:', upOne);

  const raviUpdated = await Student.findOne({ name: 'Ravi M' });
  console.log('  Updated mark:', raviUpdated.mark);

  // ══════════════════════════════════════════════════════════════════════════════
  // 7. updateMany()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('7. updateMany() — set grade = "B" for mark >= 70');
  const upMany = await Student.updateMany({ mark: { $gte: 70 } }, { $set: { grade: 'B' } });
  console.log('  Result:', upMany);

  // ══════════════════════════════════════════════════════════════════════════════
  // 8. findOneAndUpdate()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('8. findOneAndUpdate() — return updated document');
  const foundAndUpdated = await Student.findOneAndUpdate(
    { name: 'Priya S' },
    { $set: { grade: 'A' } },
    { new: true }
  );
  console.log('  Updated doc:');
  printDoc(foundAndUpdated);

  // ══════════════════════════════════════════════════════════════════════════════
  // 9. findByIdAndUpdate()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('9. findByIdAndUpdate()');
  const fidUpdated = await Student.findByIdAndUpdate(
    arun._id,
    { $set: { mark: 95, grade: 'A+' } },
    { new: true }
  );
  console.log('  Updated doc:');
  printDoc(fidUpdated);

  // ══════════════════════════════════════════════════════════════════════════════
  // 10. findOneAndReplace()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('10. findOneAndReplace()');
  const replaced = await Student.findOneAndReplace(
    { name: 'Karthik V' },
    { name: 'Karthik V', age: 21, mark: 60, place: 'Salem', grade: 'C' },
    { new: true }
  );
  console.log('  Replaced doc:');
  printDoc(replaced);

  // ══════════════════════════════════════════════════════════════════════════════
  // 11. replaceOne()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('11. replaceOne()');
  const repOne = await Student.replaceOne(
    { name: 'Divya R' },
    { name: 'Divya R', age: 22, mark: 70, place: 'Chennai', grade: 'B' }
  );
  console.log('  Result:', repOne);

  // ══════════════════════════════════════════════════════════════════════════════
  // 12. countDocuments()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('12. countDocuments()');
  const totalCount   = await Student.countDocuments();
  const chennaiCount = await Student.countDocuments({ place: 'Chennai' });
  console.log('  Total students  :', totalCount);
  console.log('  Chennai students:', chennaiCount);

  // ══════════════════════════════════════════════════════════════════════════════
  // 13. estimatedDocumentCount()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('13. estimatedDocumentCount()');
  const est = await Student.estimatedDocumentCount();
  console.log('  Estimated count:', est);

  // ══════════════════════════════════════════════════════════════════════════════
  // 14. exists()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('14. exists()');
  const existsArun  = await Student.exists({ name: 'Arun Kumar' });
  const existsGhost = await Student.exists({ name: 'Ghost' });
  console.log('  Arun exists? ', existsArun);
  console.log('  Ghost exists?', existsGhost);

  // ══════════════════════════════════════════════════════════════════════════════
  // 15. distinct()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('15. distinct() — distinct places');
  const places = await Student.distinct('place');
  console.log('  Distinct places:', places);

  // ══════════════════════════════════════════════════════════════════════════════
  // 16. aggregate()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('16. aggregate() — average mark by place');
  const agg = await Student.aggregate([
    { $group: { _id: '$place', avgMark: { $avg: '$mark' }, count: { $sum: 1 } } },
    { $sort: { avgMark: -1 } },
  ]);
  console.log('  Aggregation result:');
  agg.forEach(r => console.log(`  - ${r._id}: avg mark = ${r.avgMark.toFixed(1)}, count = ${r.count}`));

  // ══════════════════════════════════════════════════════════════════════════════
  // 17. bulkWrite()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('17. bulkWrite()');
  const bulkResult = await Student.bulkWrite([
    { updateOne: { filter: { name: 'Ravi M'    }, update: { $set: { grade: 'B+' } } } },
    { updateOne: { filter: { name: 'Karthik V' }, update: { $set: { mark: 62   } } } },
  ]);
  console.log('  bulkWrite result:', bulkResult);

  // ══════════════════════════════════════════════════════════════════════════════
  // 18. Custom static method (schema.statics)
  // ══════════════════════════════════════════════════════════════════════════════
  sep('18. Custom static — findByPlace("Chennai")');
  const chennai = await Student.findByPlace('Chennai');
  console.log(`  Found ${chennai.length} student(s) in Chennai:`);
  chennai.forEach(d => console.log('  -', d.getInfo()));

  // ══════════════════════════════════════════════════════════════════════════════
  // 19. new Student() + doc.save()  (create & update)
  // ══════════════════════════════════════════════════════════════════════════════
  sep('19. new Student() + doc.save()');
  const newDoc = new Student({ name: 'Meena T', age: 20, mark: 78, place: 'Trichy' });
  await newDoc.save();
  console.log('  Saved new doc:', newDoc.toObject());

  newDoc.mark = 85;
  newDoc.markModified('mark');
  await newDoc.save();
  console.log('  After update save, mark:', newDoc.mark);

  // ══════════════════════════════════════════════════════════════════════════════
  // 20. doc.validate()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('20. doc.validate() — bad data triggers error');
  try {
    const badDoc = new Student({ name: 'Bad', age: 'notanumber', mark: 50, place: 'X' });
    await badDoc.validate();
    console.log('  Validation passed (unexpected)');
  } catch (err) {
    console.log('  Validation error caught (expected):', err.message);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 21. toObject() / toJSON() / toString()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('21. toObject() / toJSON() / toString()');
  const sample = await Student.findOne({ name: 'Meena T' });
  console.log('  toObject():', sample.toObject());
  console.log('  toJSON()  :', sample.toJSON());
  console.log('  toString():', sample.toString());

  // ══════════════════════════════════════════════════════════════════════════════
  // 22. Virtual
  // ══════════════════════════════════════════════════════════════════════════════
  sep('22. Virtual — summary (via toObject({ virtuals: true }))');
  console.log('  summary:', sample.toObject({ virtuals: true }).summary);

  // ══════════════════════════════════════════════════════════════════════════════
  // 23. isNew / isModified / markModified / get / set
  // ══════════════════════════════════════════════════════════════════════════════
  sep('23. isNew / isModified / markModified / get / set');
  const docCheck = await Student.findOne({ name: 'Arun Kumar' });
  console.log('  isNew()         :', docCheck.isNew());
  console.log('  isModified()    :', docCheck.isModified());
  docCheck.set('mark', 99);
  console.log('  After set mark=99, get("mark"):', docCheck.get('mark'));
  console.log('  isModified("mark"):', docCheck.isModified('mark'));

  // ══════════════════════════════════════════════════════════════════════════════
  // 24. doc.deleteOne()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('24. doc.deleteOne() — delete Meena T');
  const toDelete = await Student.findOne({ name: 'Meena T' });
  if (toDelete) {
    await toDelete.deleteOne();
    console.log('  Deleted Meena T');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 25. findOneAndDelete()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('25. findOneAndDelete()');
  const deleted = await Student.findOneAndDelete({ name: 'Karthik V' });
  console.log('  Deleted doc:');
  printDoc(deleted);

  // ══════════════════════════════════════════════════════════════════════════════
  // 26. findByIdAndDelete()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('26. findByIdAndDelete()');
  const ravi = await Student.findOne({ name: 'Ravi M' });
  if (ravi) {
    const deletedById = await Student.findByIdAndDelete(ravi._id);
    console.log('  Deleted by ID:', deletedById ? deletedById.name : null);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 27. deleteOne() — static
  // ══════════════════════════════════════════════════════════════════════════════
  sep('27. deleteOne() — static');
  const delOneResult = await Student.deleteOne({ name: 'Divya R' });
  console.log('  Result:', delOneResult);

  // ══════════════════════════════════════════════════════════════════════════════
  // 28. remove() — alias for deleteMany (Mongoose legacy)
  // ══════════════════════════════════════════════════════════════════════════════
  sep('28. remove() — legacy alias for deleteMany');
  // Insert a temp doc first so we have something to remove
  await Student.create({ name: 'Temp X', age: 18, mark: 40, place: 'Temp' });
  const removeResult = await Student.remove({ name: 'Temp X' });
  console.log('  Result:', removeResult);

  // ══════════════════════════════════════════════════════════════════════════════
  // 29. findByIdAndRemove() — alias for findByIdAndDelete
  // ══════════════════════════════════════════════════════════════════════════════
  sep('29. findByIdAndRemove() — alias for findByIdAndDelete');
  const tempDoc = await Student.create({ name: 'Temp Y', age: 19, mark: 45, place: 'Temp' });
  const removedById = await Student.findByIdAndRemove(tempDoc._id);
  console.log('  Removed:', removedById ? removedById.name : null);

  // ══════════════════════════════════════════════════════════════════════════════
  // 30. findOneAndRemove() — alias for findOneAndDelete
  // ══════════════════════════════════════════════════════════════════════════════
  sep('30. findOneAndRemove() — alias for findOneAndDelete');
  await Student.create({ name: 'Temp Z', age: 20, mark: 50, place: 'Temp' });
  const removedOne = await Student.findOneAndRemove({ name: 'Temp Z' });
  console.log('  Removed:', removedOne ? removedOne.name : null);

  // ══════════════════════════════════════════════════════════════════════════════
  // 31. mongoosify.modelNames()
  // ══════════════════════════════════════════════════════════════════════════════
  sep('31. mongoosify.modelNames()');
  console.log('  Registered models:', mongoosify.modelNames());

  // ══════════════════════════════════════════════════════════════════════════════
  // 32. Final find() — remaining docs
  // ══════════════════════════════════════════════════════════════════════════════
  sep('32. Final find() — remaining documents');
  const remaining = await Student.find().sort({ mark: -1 });
  console.log(`  ${remaining.length} student(s) remaining:`);
  remaining.forEach(d =>
    console.log(`  - ${d.getInfo()} | Grade: ${d.grade}`)
  );

  // ── Disconnect ──────────────────────────────────────────────────────────────
  sep('Done');
  await mongoosify.disconnect();
  console.log('  Disconnected from MongoDB');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});