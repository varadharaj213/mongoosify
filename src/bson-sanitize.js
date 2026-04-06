'use strict';

/**
 * bson-sanitize.js
 *
 * Recursively walks any value and replaces ObjectId-like objects from ANY
 * bson version (4.x, 5.x, 6.x) with the mongodb driver's own ObjectId.
 *
 * This is the single source of truth — import this everywhere instead of
 * duplicating duck-type logic across files.
 *
 * Why this is needed:
 *   - Your project has bson 4.x installed
 *   - mongodb driver v6 bundles bson 6.x internally
 *   - The driver does a strict `instanceof` check inside its BSON serializer
 *   - An ObjectId created by bson 4 fails that check → "Unsupported BSON version"
 *   - Solution: convert ALL foreign ObjectIds to the driver's own ObjectId
 *     before they ever reach the driver, using the hex string as the bridge.
 */

const { ObjectId } = require('mongodb');

/**
 * Returns true if val is an ObjectId-like object from ANY bson version.
 * Works for bson 4, 5, 6, and any other version that sets _bsontype.
 */
function isObjectIdLike(val) {
  if (!val || typeof val !== 'object') return false;
  if (val instanceof ObjectId) return true;  // already the correct version
  if (val._bsontype === 'ObjectId' || val._bsontype === 'ObjectID') return true;
  return false;
}

/**
 * Converts a foreign bson ObjectId to the driver's own ObjectId.
 * Uses toHexString() as the version-agnostic bridge.
 */
function toDriverObjectId(val) {
  if (val instanceof ObjectId) return val;  // already correct, no-op
  try {
    const hex = val.toHexString ? val.toHexString() : val.toString();
    return new ObjectId(hex);
  } catch {
    return val;  // can't convert — return as-is and let driver error naturally
  }
}

/**
 * Recursively sanitize any value:
 *   - ObjectId-like objects → driver's ObjectId
 *   - Arrays → each element sanitized
 *   - Plain objects → each value sanitized (preserves special objects like Date, Buffer, RegExp)
 *   - Primitives → returned as-is
 */
function sanitize(val) {
  // null / undefined / primitives
  if (val === null || val === undefined) return val;

  // Foreign bson ObjectId — convert it
  if (isObjectIdLike(val)) return toDriverObjectId(val);

  // Array — recurse into each element
  if (Array.isArray(val)) return val.map(sanitize);

  // Skip special objects that should never be walked: Date, Buffer, RegExp, driver's own types
  if (
    val instanceof Date   ||
    Buffer.isBuffer(val)  ||
    val instanceof RegExp
  ) return val;

  // Skip non-plain objects (class instances other than plain {}):
  // Check constructor — only walk plain objects (constructor === Object or null proto)
  if (typeof val === 'object') {
    const proto = Object.getPrototypeOf(val);
    if (proto !== null && proto !== Object.prototype) {
      // It's a class instance — only convert if it's ObjectId-like (already handled above)
      // Otherwise return as-is to avoid breaking things like Map, Set, etc.
      return val;
    }

    // Plain object — recurse into values
    const out = {};
    for (const key of Object.keys(val)) {
      out[key] = sanitize(val[key]);
    }
    return out;
  }

  return val;
}

/**
 * Sanitize a list of arguments (for wrapping collection methods).
 * Only sanitizes args that are plain objects or arrays (i.e. filters/docs).
 * Strings, numbers, booleans are passed through as-is.
 */
function sanitizeArgs(args) {
  return args.map(arg => {
    if (arg === null || arg === undefined) return arg;
    if (typeof arg !== 'object') return arg;      // string, number, boolean — skip
    return sanitize(arg);
  });
}

module.exports = { sanitize, sanitizeArgs, isObjectIdLike, toDriverObjectId };