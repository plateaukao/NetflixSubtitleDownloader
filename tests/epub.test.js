const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const JSZip = require('../lib/jszip.min.js');

test('EPUB exports compress content and preserve the uncompressed mimetype', async () => {
  const context = vm.createContext({ JSZip, crypto: { randomUUID } });
  vm.runInContext(fs.readFileSync(require.resolve('../epub.js'), 'utf8'), context);
  const book = context.generateEPUB('Test', [{
    title: 'Chapter', html: '<h3>你好 Hello world</h3>\n'.repeat(1000)
  }], null);
  const bytes = await book.generateAsync({ type: 'nodebuffer' });
  assert.equal(bytes.readUInt16LE(8), 0);
  assert.equal(bytes.subarray(30, 38).toString(), 'mimetype');
  const restored = await JSZip.loadAsync(bytes, { checkCRC32: true });
  for (const [name, file] of Object.entries(book.files)) {
    if (file.dir) continue;
    assert.deepEqual(await restored.file(name).async('nodebuffer'), await file.async('nodebuffer'));
    if (name !== 'mimetype') {
      assert.equal(file.options.compressionOptions.level, 6);
      assert.equal(restored.file(name)._data.compression.magic, '\x08\x00');
    }
  }
  assert.ok(bytes.length < (await book.file('OEBPS/chapter1.xhtml').async('nodebuffer')).length / 2);
});
