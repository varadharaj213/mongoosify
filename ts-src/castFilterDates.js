// Cast Date values in filter objects based on schema types
// This is needed because MongoDB doesn't auto-cast string dates to Date objects
const { ObjectId } = require('mongodb');

function castFilterDates(filter, schema) {
  if (!filter || !schema) return filter;
  try {
    var keys = Object.keys(filter);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key[0] === '\x24') continue; // skip $ operators
      var val = filter[key];
      if (val == null) continue;
      var st = schema.paths[key];
      if (!st || st.instance !== 'Date') continue;
      if (typeof val === 'object' && !(val instanceof Date) && !(val instanceof ObjectId)) {
        var ops = Object.keys(val);
        for (var j = 0; j < ops.length; j++) {
          var op = ops[j];
          if (op[0] === '\x24' && val[op] != null && !(val[op] instanceof Date)) {
            var d = new Date(val[op]);
            if (!isNaN(d.getTime())) val[op] = d;
          }
        }
      } else if (!(val instanceof Date)) {
        var d2 = new Date(val);
        if (!isNaN(d2.getTime())) filter[key] = d2;
      }
    }
  } catch (_) {}
  return filter;
}

module.exports = castFilterDates;
