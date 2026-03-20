'use strict';

const mongoosify = require('../src');
const { Schema } = mongoosify;

// ─── Define Schema ────────────────────────────────────────────────────────────

const studentSchema = new Schema(
  {
    name:  { type: String, required: true, trim: true },
    age:   { type: Number, required: true },
    mark:  { type: Number, required: true },
    place: { type: String, required: true, trim: true },
  },
  {
    collection: 'studenttest',   // exact collection name
    timestamps: true,
  }
);

// ─── Register Model ───────────────────────────────────────────────────────────

const Student = mongoosify.model('Student', studentSchema);

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await mongoosify.connect('mongodb://raja:kBSjis0SK8MK1AwP@10.62.9.142:27017,10.62.9.143:27017,10.62.8.77:27017/mms?replicaSet=myReplicaSet&authSource=admin');
  console.log('Connected to MongoDB\n');

  // Create a student record
  const student = await Student.create({
    name:  'Arun Kumar',
    age:   20,
    mark:  88,
    place: 'Chennai',
  });

  console.log('Student created:');
  console.log(student.toObject());

  // Find all students
  const all = await Student.find();
  console.log(`\nAll students in "studenttest" (${all.length} total):`);
  all.forEach(s => console.log(` - ${s.name} | Age: ${s.age} | Mark: ${s.mark} | Place: ${s.place}`));

  await mongoosify.disconnect();
  console.log('\nDisconnected.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});