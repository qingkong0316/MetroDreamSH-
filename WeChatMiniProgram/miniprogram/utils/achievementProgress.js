const { allLines } = require('../data/lines.js');
const metroMapState = require('./metroMapState.js');
const stationGraph = require('./stationGraph.js');

const COUNT_THRESHOLDS = {
  41: 1,
  42: 20,
  43: 50,
  44: 100,
  45: 300,
  91: 150,
  92: 200,
  93: 250,
  100: 350
};

const LINE_ACHIEVEMENT_MAP = {
  51: '1',
  52: '2',
  53: '10',
  54: '11',
  55: '5',
  56: 'Special21',
  84: 'Special22',
  85: 'Special23'
};

function countUncheckedOnLine(checkedSet, lineKey) {
  const stations = allLines[lineKey];
  if (!stations || !stations.length) return 0;
  return stationGraph.countUncheckedUniqueOnLine(checkedSet, stations);
}

function getRemainingHint(achievementId, ctx) {
  if (COUNT_THRESHOLDS[achievementId] !== undefined) {
    const need = COUNT_THRESHOLDS[achievementId] - ctx.count;
    if (need <= 0) return '';
    return `还差 ${need} 站`;
  }

  const lineKey = LINE_ACHIEVEMENT_MAP[achievementId];
  if (lineKey) {
    const checkedSet = new Set(ctx.records.map(r => r.stationName));
    const remaining = countUncheckedOnLine(checkedSet, lineKey);
    if (remaining <= 0) return '';
    const label = metroMapState.formatLineLabel(lineKey);
    return `${label}还差 ${remaining} 站`;
  }

  return '';
}

function attachRemainingHints(achievementList, ctx) {
  return achievementList.map(a => {
    if (a.unlocked) {
      return { ...a, remainingHint: '' };
    }
    return {
      ...a,
      remainingHint: getRemainingHint(a.id, ctx)
    };
  });
}

module.exports = {
  getRemainingHint,
  attachRemainingHints
};
