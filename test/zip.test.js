/**
 * 测试：极简 ZIP 读写（server/utils/zip.js）
 *
 * 覆盖：CRC32 已知值、写入→读回一致、Unix 权限位写入、zip-slip 路径拒绝、
 *       CRC/尺寸/压缩方法篡改检测、非 ZIP 输入拒绝。全部在内存中完成。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { crc32, createZip, readZip, isZip, assertSafeEntryName } from '../server/utils/zip.js';

/** 本地头 / 中央目录 / EOCD 的固定偏移常量（与 zip.js 内一致）。 */
const SIG_EOCD = 0x06054b50;
const EOCD_BYTES = 22;
const CENTRAL_HEADER_BYTES = 46;

/**
 * 从缓冲区尾部定位中央目录起始偏移。
 * @param {Buffer} buffer
 * @returns {number}
 */
function centralOffset(buffer) {
  for (let i = buffer.length - EOCD_BYTES; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) return buffer.readUInt32LE(i + 16);
  }
  throw new Error('EOCD 未找到');
}

test('crc32: 与 PKZIP 标准校验值一致', () => {
  assert.equal(crc32(Buffer.from('')), 0x00000000);
  assert.equal(crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926);
  assert.equal(crc32(Buffer.from('hello', 'ascii')), 0x3610a686);
  // 标准向量的补码性质：crc32(x) ^ 0xffffffff 等于按位取反。
  assert.equal(crc32(Buffer.from('hello', 'ascii')) ^ 0xffffffff, ~0x3610a686 & 0xffffffff);
});

test('createZip + readZip: 单条目往返一致', () => {
  const data = Buffer.from('SQLite format 3\0 plus binary payload ✓', 'utf8');
  const archive = createZip([{ name: 'juju.db', data }]);

  const entries = readZip(archive);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'juju.db');
  assert.ok(entries[0].data.equals(data));
});

test('createZip + readZip: 多条目（含隐藏的 .juju-secrets）往返一致', () => {
  const db = Buffer.from('db-bytes-0123456789');
  const secrets = Buffer.from('DB_ENCRYPTION_KEY=aa\nJUJU_SM4_KEY=bb\nSESSION_SECRET=cc\n');
  const archive = createZip([
    { name: 'juju.db', data: db, mode: 0o100644 },
    { name: '.juju-secrets', data: secrets, mode: 0o100600 },
  ]);

  const entries = readZip(archive);
  assert.deepEqual(entries.map((entry) => entry.name), ['juju.db', '.juju-secrets']);
  assert.ok(entries[0].data.equals(db));
  assert.ok(entries[1].data.equals(secrets));
});

test('createZip: 默认权限 0644，密钥文件 0600（写入外部属性）', () => {
  const archive = createZip([
    { name: 'a.txt', data: Buffer.from('a') },
    { name: '.juju-secrets', data: Buffer.from('b'), mode: 0o100600 },
  ]);

  let cursor = centralOffset(archive);
  const modes = [];
  for (let i = 0; i < 2; i++) {
    modes.push(archive.readUInt32LE(cursor + 38) >>> 16);
    cursor += CENTRAL_HEADER_BYTES + archive.readUInt16LE(cursor + 28);
  }

  assert.equal(modes[0], 0o100644, '普通条目应为 0644 常规文件');
  assert.equal(modes[1], 0o100600, '密钥文件必须为 0600');
});

test('createZip: 空条目列表抛错', () => {
  assert.throws(() => createZip([]), /At least one entry is required/);
  assert.throws(() => createZip(null), /At least one entry is required/);
});

test('readZip: zip-slip 路径被拒绝', () => {
  for (const evil of ['../secrets', 'sub/secret.txt', '..\\windows\\secret', '.ssh/authorized_keys', '/etc/passwd']) {
    const archive = createZip([{ name: evil, data: Buffer.from('x') }]);
    assert.throws(() => readZip(archive), /must not contain path separators|Unexpected hidden entry/, `应拒绝：${evil}`);
  }
});

test('readZip: 盘符、控制字符、过长文件名、隐藏文件（非白名单）被拒绝', () => {
  assert.throws(() => readZip(createZip([{ name: 'C:evil', data: Buffer.from('x') }])), /drive letter/);
  assert.throws(() => readZip(createZip([{ name: 'a\u0001b', data: Buffer.from('x') }])), /control characters/);
  assert.throws(() => readZip(createZip([{ name: 'x'.repeat(256), data: Buffer.from('x') }])), /name is too long/);
  assert.throws(() => readZip(createZip([{ name: '.env', data: Buffer.from('x') }])), /Unexpected hidden entry/);
  assert.throws(() => readZip(createZip([{ name: '', data: Buffer.from('x') }])), /without a name/);
});

test('assertSafeEntryName: 合法名字放行，非法名字抛错', () => {
  assert.doesNotThrow(() => assertSafeEntryName('juju.db'));
  assert.doesNotThrow(() => assertSafeEntryName('.juju-secrets'), '密钥文件是唯一允许的隐藏条目');
  assert.throws(() => assertSafeEntryName('..'), /Illegal entry name/);
  assert.throws(() => assertSafeEntryName('.'), /Illegal entry name/);
  assert.throws(() => assertSafeEntryName('a/b'), /path separators/);
});

test('readZip: 内容被篡改 → CRC 校验失败', () => {
  const archive = createZip([{ name: 'juju.db', data: Buffer.from('ORIGINAL-CONTENT') }]);
  const offset = centralOffset(archive);
  const localOffset = archive.readUInt32LE(offset + 42);
  const dataStart = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);

  const tampered = Buffer.from(archive);
  tampered[dataStart] = tampered[dataStart] ^ 0xff;

  assert.throws(() => readZip(tampered), /failed its checksum/);
});

test('readZip: 压缩尺寸与实际不符 → 拒绝', () => {
  const archive = createZip([{ name: 'juju.db', data: Buffer.from('payload') }]);
  const offset = centralOffset(archive);

  const broken = Buffer.from(archive);
  broken.writeUInt32LE(999, offset + 20); // compressedSize

  assert.throws(() => readZip(broken), /inconsistent sizes/);
});

test('readZip: 非 Store 压缩方法 → 拒绝', () => {
  const archive = createZip([{ name: 'juju.db', data: Buffer.from('payload') }]);
  const offset = centralOffset(archive);

  const deflated = Buffer.from(archive);
  deflated.writeUInt16LE(8, offset + 10); // method = deflate

  assert.throws(() => readZip(deflated), /Only stored \(uncompressed\) entries are supported/);
});

test('readZip: 非 ZIP / 非法输入 → 拒绝', () => {
  assert.throws(() => readZip(Buffer.from('this is definitely not a zip archive')), /no end-of-central-directory/);
  assert.throws(() => readZip('a string'), /Input must be a buffer/);
  assert.throws(() => readZip(null), /Input must be a buffer/);
});

test('isZip: 只认 ZIP 签名', () => {
  assert.equal(isZip(createZip([{ name: 'a', data: Buffer.from('x') }])), true);
  assert.equal(isZip(Buffer.from('PK\u0003\u0004 whatever')), true); // 只有本地头签名也认作 ZIP
  assert.equal(isZip(Buffer.from('not a zip at all')), false);
  assert.equal(isZip(Buffer.from([1, 2])), false);
  assert.equal(isZip(null), false);
  assert.equal(isZip('string'), false);
});

test('边界：空内容与 UTF-8 内容都能无损往返', () => {
  const archive = createZip([
    { name: 'empty.txt', data: Buffer.alloc(0) },
    { name: 'utf8.txt', data: Buffer.from('中文 emoji 🎉', 'utf8') },
  ]);

  const entries = readZip(archive);
  assert.equal(entries[0].data.length, 0);
  assert.equal(entries[1].data.toString('utf8'), '中文 emoji 🎉');
});
