/**
 * 验证成就规则中的站名是否与 lines.js 匹配
 * 运行: node scripts/verify-achievements.js
 */

const { allLines } = require('../miniprogram/data/lines.js');

const allNames = new Set();
const nameToLines = {};
Object.entries(allLines).forEach(([line, stations]) => {
  stations.forEach(s => {
    allNames.add(s.name);
    if (!nameToLines[s.name]) nameToLines[s.name] = [];
    if (!nameToLines[s.name].includes(line)) nameToLines[s.name].push(line);
  });
});

function stationExists(query) {
  const matches = [...allNames].filter(n => n.includes(query));
  return { found: matches.length > 0, matches };
}

const ruleStations = [
  '人民广场', '陆家嘴', '南京东路', '豫园', '衡山路', '常熟路', '徐家汇', '龙华中路', '云锦路',
  '静安寺', '中潭路', '江宁路', '一大会址·新天地', '一大会址·黄陂南路', '淮海中路', '陕西南路',
  '迪士尼', '松江大学城', '美兰湖', '上海火车站', '上海南站', '虹桥火车站', '虹桥2号航站楼',
  '浦东1号2号航站楼', '花桥', '滴水湖', '中华艺术宫', '西藏南路', '七宝', '朱家角',
  '世博会博物馆', '世博大道', '耀华路', '金沙江路', '紫竹高新区', '东川路', '五角场',
  '江湾体育场', '同济大学', '上海大学', '临港大道', '曹路', '中科路', '张江高科', '金科路',
  '漕河泾开发区', '世纪大道', '商城路', '浦东南路', '浦东南路(原东昌路)', '龙阳路', '汉中路',
  '广兰路', '唐镇', '真如', '东方体育中心', '富锦路', '闵行开发区', '曹杨路', '中山公园', '莘庄',
  '淞虹路', '国家会展中心(2号线)', '龙耀路', '嘉定新城', '安亭', '松江新城', '醉白池'
];

let failed = 0;
function fail(msg) {
  console.error('FAIL:', msg);
  failed++;
}
function ok(msg) {
  console.log('OK:', msg);
}

console.log('=== 站名匹配 ===');
ruleStations.forEach(q => {
  const r = stationExists(q);
  if (!r.found) fail(`站名 "${q}" 在 lines.js 中无匹配`);
  else if (r.matches.length > 1) {
    console.log('WARN:', `"${q}" 匹配多个站名:`, r.matches.join(' | '));
  }
});
if (!failed) ok('所有规则站名均可匹配');

console.log('\n=== 线路 key ===');
['1', '2', '5', '10', '11', 'Special21', 'Special22', 'Special23'].forEach(k => {
  if (!allLines[k]) fail(`线路 ${k} 不存在`);
  else ok(`线路 ${k}: ${allLines[k].length} 站`);
});

console.log('\n=== 换乘枢纽数量 ===');
const hubs2 = Object.entries(nameToLines).filter(([, ls]) => ls.length >= 2);
ok(`2线及以上换乘站共 ${hubs2.length} 个`);
if (hubs2.length < 15) fail('换乘宗师(15站) 不可完成，换乘站不足15个');

console.log('\n=== 里程碑上限 ===');
ok(`唯一站名总数 ${allNames.size}`);
[300, 350].forEach(n => {
  if (n > allNames.size) fail(`count >= ${n} 不可完成（最多 ${allNames.size} 站）`);
  else ok(`count >= ${n} 可完成`);
});

console.log('\n=== 成就90 线路顺序问题 ===');
['南京东路', '人民广场', '陕西南路'].forEach(s => {
  const onLine1 = allLines['1'].some(st => st.name.includes(s));
  console.log(`  ${s}: line1=${onLine1}, lines=${(nameToLines[s] || []).join(',')}`);
  if (s === '南京东路' && onLine1) ok('南京东路在1号线');
  if (s === '南京东路' && !onLine1) {
    console.log('  NOTE: 南京东路不在1号线，成就90描述为1号线三站连穿，但南京东路仅2/10线');
  }
});

console.log('\n=== 成就83 各站所在线路 ===');
['花桥', '徐家汇', '迪士尼'].forEach(s => {
  console.log(`  ${s}: lines=${(nameToLines[s] || []).join(',')}`);
});

console.log('\n=== 子串误匹配风险 ===');
['上海火车站', '上海南站', '上海大学'].forEach(q => {
  const r = stationExists(q);
  if (r.matches.length > 1) console.log('WARN:', q, '->', r.matches.join(' | '));
});

console.log('\n=== 成就描述与规则不一致 ===');
console.log('WARN: 成就91 名称「百站半程」但规则为 count >= 150');

process.exit(failed ? 1 : 0);
