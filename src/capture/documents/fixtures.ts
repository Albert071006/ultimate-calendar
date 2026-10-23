import { deflateSync, deflateRawSync } from 'node:zlib';
import { crc32 } from './zip';

function pngChunk(type: string, data: Buffer): Buffer {
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4), content = Buffer.concat([Buffer.from(type), data]);
  size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(content)); return Buffer.concat([size, content, checksum]);
}
const pngHeader = Buffer.alloc(13); pngHeader.writeUInt32BE(2); pngHeader.writeUInt32BE(2, 4); pngHeader[8] = 8; pngHeader[9] = 2;
export const PIXEL_PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', pngHeader), pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255, 0, 0, 0, 0, 255, 0, 0, 255, 255, 255]))), pngChunk('IEND', Buffer.alloc(0))]);
export function fixtureZip(files: Record<string, string | Buffer>, stored = false): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value), compressed = stored ? bytes : deflateRawSync(bytes), filename = Buffer.from(name), local = Buffer.alloc(30), directory = Buffer.alloc(46), crc = crc32(bytes);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(stored ? 0 : 8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(stored ? 0 : 8, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    const current = Buffer.concat([local, filename, compressed]); locals.push(current); central.push(directory, filename); offset += current.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const CONTENT_TYPES = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export function fixtureDocx(): Buffer {
  return fixtureZip({ '[Content_Types].xml': CONTENT_TYPES,
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${REL}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body><w:p><w:r><w:t>周五提交报告 &amp; 实验记录</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>奖励</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2 学分</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:drawing><a:blip r:embed="image1"/></w:drawing></w:r></w:p></w:body></w:document>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image1" Type="${REL}/image" Target="media/image.png"/><Relationship Id="header1" Type="${REL}/header" Target="header1.xml"/></Relationships>`,
    'word/header1.xml': '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>课程通知</w:t></w:r></w:p></w:hdr>',
    'word/media/image.png': PIXEL_PNG,
  });
}
export function fixtureXlsx(missingCache = false): Buffer {
  return fixtureZip({ '[Content_Types].xml': CONTENT_TYPES,
    'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="课程" sheetId="1" r:id="s2"/><sheet name="奖金" sheetId="2" r:id="s1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="s1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="s2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
    'xl/styles.xml': '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    'xl/sharedStrings.xml': '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>交报告</t></si></sst>',
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>1+1</f>${missingCache ? '' : '<v>2</v>'}</c><c r="B1" s="1"><v>46318</v></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="3"><c r="C3" t="s"><v>0</v></c><c r="D3" t="inlineStr"><is><t>周五</t></is></c></row></sheetData></worksheet>',
  });
}
export function fixturePptx(): Buffer {
  const slide = (text: string) => `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  return fixtureZip({ '[Content_Types].xml': CONTENT_TYPES,
    'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${REL}"><p:sldIdLst><p:sldId id="256" r:id="r2"/><p:sldId id="257" r:id="r1"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="${REL}/slide" Target="slides/slide1.xml"/><Relationship Id="r2" Type="${REL}/slide" Target="slides/slide2.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': slide('第二张：周五报名'), 'ppt/slides/slide2.xml': slide('第一张：竞赛通知'),
    'ppt/slides/_rels/slide2.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="n1" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
    'ppt/notesSlides/notesSlide1.xml': slide('备注：获奖可加学分'),
  });
}

/** Actual PDF objects, xref and binary image stream, useful in both unit and packaged Electron smoke tests. */
export function fixturePdf(kind: 'text' | 'scan' | 'mixed' = 'text'): Buffer {
  const image = deflateSync(Buffer.from([255, 255, 255, 0, 0, 0, 255, 0, 0, 255, 255, 255]));
  const text = kind === 'scan' ? '' : 'BT /F1 18 Tf 40 200 Td (Submit report Friday) Tj ET\n';
  const imageCommand = kind === 'text' ? '' : 'q 100 0 0 100 40 40 cm /Im1 Do Q\n';
  const stream = Buffer.from(text + imageCommand), objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')]),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')]),
  ];
  const blocks = [Buffer.from('%PDF-1.7\n')], offsets = [0]; let size = blocks[0]!.length;
  for (let i = 0; i < objects.length; i++) { offsets.push(size); const block = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), objects[i]!, Buffer.from('\nendobj\n')]); blocks.push(block); size += block.length; }
  const table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF`;
  return Buffer.concat([...blocks, Buffer.from(table)]);
}
