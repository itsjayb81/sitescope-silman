/**
 * SiteScope office sync. Paste into a Google Sheet: Extensions > Apps Script.
 * Deploy > New deployment > Web app > Execute as: Me, Access: Anyone. Copy the link into the app.
 * Tabs it creates: Jobs, Materials (office edits these, phones pull them), Photos, Measures, Quotes (phones push).
 * Photos land in Drive: SiteScope / <Job> / Photos.
 */
const HEAD = {
  Jobs: ['id', 'name', 'site'],
  Materials: ['id', 'name', 'density', 'compaction', 'rate', 'unit'],
  Photos: ['received', 'who', 'job', 'name', 'location', 'taken', 'lat', 'lng', 'map', 'drive link'],
  Measures: ['received', 'who', 'job', 'name', 'length m', 'width m', 'depth mm', 'area m2'],
  Quotes: ['received', 'who', 'job', 'material', 'length m', 'width m', 'depth mm', 'waste %', 'rate', 'order qty', 'unit', 'cost ex GST'],
};
const SEED_MATERIALS = [
  ['asphalt', 'Asphalt (AC14)', 2.4, 1.0, 180, 't'], ['concrete', 'Concrete (25 MPa)', 2.4, 1.0, 300, 'm3'],
  ['crushed', 'Crushed rock (20mm FCR)', 1.6, 1.3, 45, 't'], ['topsoil', 'Topsoil', 1.3, 1.2, 60, 't'],
  ['gravel', 'Gravel (20mm)', 1.6, 1.1, 70, 't'], ['sand', 'Sand (washed)', 1.6, 1.15, 55, 't'],
];
function tab(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(HEAD[name]); sh.setFrozenRows(1); sh.getRange(1, 1, 1, HEAD[name].length).setFontWeight('bold');
    if (name === 'Materials') SEED_MATERIALS.forEach(r => sh.appendRow(r));
  }
  return sh;
}
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function rows(name) {
  const v = tab(name).getDataRange().getValues(), h = v.shift();
  return v.filter(r => r[0] !== '').map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}
function doGet(e) {
  if ((e.parameter.action || '') !== 'pull') return out({ ok: false, error: 'bad action' });
  return out({
    ok: true,
    jobs: rows('Jobs').map(j => ({ id: String(j.id), name: j.name, site: j.site || '' })),
    materials: rows('Materials').map(m => ({ id: String(m.id), name: m.name, density: +m.density, compaction: +m.compaction, rate: +m.rate, unit: m.unit })),
  });
}
function doPost(e) {
  try {
    const b = JSON.parse(e.postData.contents), it = b.item, d = it.data, now = new Date(), who = b.who || '';
    if (it.kind === 'job') {
      const sh = tab('Jobs'); if (!rows('Jobs').some(j => String(j.id) === d.id)) sh.appendRow([d.id, d.name, d.site || '']);
    } else if (it.kind === 'measure') {
      tab('Measures').appendRow([now, who, d.jobName, d.name, d.l, d.w, d.d, d.l * d.w]);
    } else if (it.kind === 'calc') {
      tab('Quotes').appendRow([now, who, d.jobName, d.material, d.l, d.w, d.d, d.waste, d.rate, d.order, d.unit, d.cost]);
    } else if (it.kind === 'photo') {
      const blob = Utilities.newBlob(Utilities.base64Decode(it.b64), 'image/jpeg', d.name + '.jpg');
      const file = jobFolder(d.jobName).createFile(blob);
      const map = d.lat ? 'https://maps.google.com/?q=' + d.lat + ',' + d.lng : '';
      tab('Photos').appendRow([now, who, d.jobName, d.name, d.loc, new Date(d.t), d.lat || '', d.lng || '', map, file.getUrl()]);
    }
    return out({ ok: true });
  } catch (err) { return out({ ok: false, error: String(err) }); }
}
function jobFolder(job) {
  const root = sub(DriveApp.getRootFolder(), 'SiteScope');
  return sub(sub(root, job), 'Photos');
}
function sub(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function setup() { tab('Jobs'); tab('Materials'); tab('Photos'); tab('Measures'); tab('Quotes'); jobFolder('Setup check'); }
