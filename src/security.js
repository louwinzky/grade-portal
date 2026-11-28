'use strict';
// Shared one-way token/code hashing for recovery links, backup codes and login challenges.
const crypto = require('crypto');

const hashToken = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function randomCode(bytes = 18) {
  // Unambiguous alphabet: the code may be typed from a printed sheet.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < bytes; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

module.exports = { hashToken, randomCode };
