'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('packaged client uses the production STEENY origin by default', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main.js'),
    'utf8',
  );

  assert.match(
    source,
    /const DEFAULT_APP_URL = 'https:\/\/music\.steeny\.fun\/'/,
  );
  assert.doesNotMatch(
    source,
    /const DEFAULT_APP_URL = 'http:\/\/127\.0\.0\.1:/,
  );
});
