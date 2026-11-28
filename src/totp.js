'use strict';
const { generateSecret, generate, verify: otpVerify } = require('otplib');
const { createDigest, createRandomBytes } = require('@otplib/plugin-crypto-node');
const { generateTOTP } = require('@otplib/uri');

const ISSUER = 'Grade Portal';

async function newSecret() {
  return generateSecret({ createRandomBytes });
}

async function tokenFor(secret) {
  return generate({ secret, createDigest });
}

async function verifyToken(secret, token) {
  if (!/^\d{6}$/.test(String(token || ''))) return false;
  try {
    const result = await otpVerify({ secret, token: String(token), createDigest, window: 1 });
    return !!result.valid;
  } catch { return false; }
}

function provisioningUri(secret, username) {
  return generateTOTP({ issuer: ISSUER, label: username, secret, digits: 6, period: 30 });
}

module.exports = { newSecret, tokenFor, verifyToken, provisioningUri, ISSUER };
