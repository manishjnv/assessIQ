// Post-deploy: submit every sitemap URL to IndexNow. Usage: node scripts/indexnow-submit.mjs [--dry-run]
const KEY = '51c5d2964f070d2482eecaaa2ef236e7';
const HOST = 'assessiq.in';
const dryRun = process.argv.includes('--dry-run');

const xml = await (await fetch(`https://${HOST}/sitemap-0.xml`)).text();
const urlList = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
if (!urlList.length) {
  console.error('indexnow: no <loc> URLs found in sitemap-0.xml');
  process.exit(1);
}

const payload = { host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList };
if (dryRun) {
  console.log(JSON.stringify(payload, null, 2));
  console.log(`indexnow: dry run, ${urlList.length} URLs`);
  process.exit(0);
}

const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(payload),
});
console.log(`indexnow: HTTP ${res.status}, ${urlList.length} URLs`);
process.exit(res.ok ? 0 : 1);
