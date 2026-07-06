function dateKey(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isSameMonth(ts, refDate) {
  const d = new Date(ts);
  return d.getFullYear() === refDate.getFullYear()
    && d.getMonth() === refDate.getMonth();
}

function getMonthCheckinCount(records, refDate = new Date()) {
  const names = new Set();
  records.forEach(r => {
    if (isSameMonth(r.checkInTime, refDate)) {
      names.add(r.stationName);
    }
  });
  return names.size;
}

function getLastCheckinStation(records) {
  if (!records.length) return '暂无';
  const latest = records.reduce(
    (max, r) => (r.checkInTime > max.checkInTime ? r : max),
    records[0]
  );
  return latest.stationName;
}

function getExploreStreakDays(records, refDate = new Date()) {
  if (!records.length) return 0;

  const daySet = new Set(records.map(r => dateKey(r.checkInTime)));
  const todayKey = dateKey(refDate.getTime());

  if (!daySet.has(todayKey)) return 0;

  let streak = 0;
  const cursor = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate());

  while (daySet.has(dateKey(cursor.getTime()))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  return streak;
}

function computeProgressStats(records, refDate = new Date()) {
  return {
    monthCheckinCount: getMonthCheckinCount(records, refDate),
    lastCheckinStation: getLastCheckinStation(records),
    exploreStreakDays: getExploreStreakDays(records, refDate)
  };
}

module.exports = {
  computeProgressStats,
  getMonthCheckinCount,
  getLastCheckinStation,
  getExploreStreakDays
};
