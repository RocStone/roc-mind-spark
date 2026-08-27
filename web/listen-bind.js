'use strict';

const LISTEN_HOST = '127.0.0.1';
const PRODUCT_NAME = 'roc-mind-spark';

function allowedOrigin(port) {
  return 'http://127.0.0.1:' + String(port);
}

function isAllowedOrigin(origin, port) {
  return origin === allowedOrigin(port);
}

function isAllowedHost(hostHeader, port) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  const p = String(port);
  return raw === '127.0.0.1' || raw === '127.0.0.1:' + p;
}

module.exports = {
  LISTEN_HOST,
  PRODUCT_NAME,
  allowedOrigin,
  isAllowedOrigin,
  isAllowedHost,
};
