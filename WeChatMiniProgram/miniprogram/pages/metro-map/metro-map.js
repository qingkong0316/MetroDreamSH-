const {
  schematicLines,
  schematicStations
} = require('../../data/metroSchematic.js');
const checkin = require('../../utils/checkin.js');
const metroMapState = require('../../utils/metroMapState.js');
const renderer = require('../../utils/metroMapRenderer.js');

const ALL_VIEW_INITIAL_SCALE_FACTOR = 3.24;
const LINE_FIT_SCALE_FACTOR = 1.83;
const MIN_SCALE_FACTOR = 0.88;
const MAX_SCALE_MULTIPLIER = 5.5;
const LINE_LABEL_SCALE_FACTOR = 1.06;
const HIT_RADIUS = 32;
const INIT_RETRY_MS = 80;
const MAX_INIT_RETRIES = 8;

const FILTER_DIM_ALPHA = 0.15;

function getWeekStartMonday(refDate = new Date()) {
  const d = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate());
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function buildWeekNewSet(records) {
  const start = getWeekStartMonday();
  const set = new Set();
  records.forEach(r => {
    if (r.checkInTime >= start) set.add(r.stationName);
  });
  return set;
}

function sortLineKeys(keys) {
  return keys.sort((a, b) => {
    const aNum = parseInt(a, 10);
    const bNum = parseInt(b, 10);
    const aIsNum = !isNaN(aNum);
    const bIsNum = !isNaN(bNum);
    if (aIsNum && bIsNum) return aNum - bNum;
    if (aIsNum) return -1;
    if (bIsNum) return 1;
    return a.localeCompare(b);
  });
}

function touchDistance(t1, t2) {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function computeContentBounds() {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  schematicStations.forEach(s => {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x);
    maxY = Math.max(maxY, s.y);
  });
  const pad = 60;
  return {
    minX: minX - pad,
    minY: minY - pad,
    maxX: maxX + pad,
    maxY: maxY + pad
  };
}

const CONTENT_BOUNDS = computeContentBounds();

function computeGlobalProgress() {
  const names = new Set();
  schematicStations.forEach(s => names.add(s.name));
  const checked = metroMapState.buildCheckedNameSet(checkin.getRecords());
  const globalTotalCount = names.size;
  const globalCheckedCount = checked.size;
  return { globalCheckedCount, globalTotalCount };
}

Page({
  data: {
    filterLine: '',
    filterLineKeys: [],
    filterLabels: {},
    filterTags: {
      unchecked: false,
      transfer: false,
      weekNew: false
    },
    showStationSheet: false,
    stationSheetData: null,
    globalCheckedCount: 0,
    globalTotalCount: 0
  },

  onLoad(options) {
    this._pendingFocus = options.focus ? decodeURIComponent(options.focus) : '';
    this._pendingFocusLine = options.line ? decodeURIComponent(options.line) : '';
    const keys = [];
    const seen = new Set();
    schematicLines.forEach(l => {
      if (!seen.has(l.key)) {
        seen.add(l.key);
        keys.push(l.key);
      }
    });
    const filterLineKeys = sortLineKeys(keys);
    const filterLabels = {};
    filterLineKeys.forEach(k => {
      filterLabels[k] = metroMapState.formatLineLabel(k);
    });
    this._transferMap = metroMapState.getTransferMap();
    this._records = checkin.getRecords();
    this._tick = 0;
    this._scale = 1;
    this._minScale = 0.1;
    this._maxScale = 2;
    this._offsetX = 0;
    this._offsetY = 0;
    this._canvasReady = false;
    this._drawPending = false;
    this._initRetries = 0;
    this._interacting = false;
    this._mapCacheKey = '';
    this._offCanvas = null;

    const global = computeGlobalProgress();
    const nextData = {
      filterLineKeys,
      filterLabels,
      ...global
    };
    if (this._pendingFocusLine) {
      nextData.filterLine = this._pendingFocusLine;
    }
    this.setData(nextData);
  },

  onReady() {
    this._initCanvas();
  },

  onShow() {
    this._records = checkin.getRecords();
    const global = computeGlobalProgress();
    this.setData(global);
    this._startAnimLoop();

    if (this._canvasReady && this._canvasW) {
      this._scheduleDraw();
      return;
    }

    if (this._initTimer) clearTimeout(this._initTimer);
    this._initTimer = setTimeout(() => {
      if (!this._canvasReady) {
        this._initRetries = 0;
        this._initCanvas();
      }
    }, 120);
  },

  onHide() {
    this._stopAnimLoop();
    if (this._initTimer) {
      clearTimeout(this._initTimer);
      this._initTimer = null;
    }
  },

  onUnload() {
    this._stopAnimLoop();
  },

  _startAnimLoop() {
    this._stopAnimLoop();
    const loop = () => {
      if (!this._interacting) {
        this._tick = Date.now();
        this._scheduleDraw();
      }
      this._animFrame = setTimeout(loop, this._interacting ? 250 : 100);
    };
    loop();
  },

  _stopAnimLoop() {
    if (this._animFrame) {
      clearTimeout(this._animFrame);
      this._animFrame = null;
    }
  },

  _initCanvas() {
    this._canvasReady = false;
    const query = wx.createSelectorQuery();
    query.select('#metroCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          this._retryInit();
          return;
        }
        if (!res[0].width || !res[0].height) {
          this._retryInit();
          return;
        }

        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const sys = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        const dpr = Math.min(Math.max(sys.pixelRatio || 2, 2), 3);
        this._dpr = dpr;
        this._canvasW = res[0].width;
        this._canvasH = res[0].height;
        canvas.width = Math.floor(this._canvasW * dpr);
        canvas.height = Math.floor(this._canvasH * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (ctx.imageSmoothingEnabled !== undefined) {
          ctx.imageSmoothingEnabled = true;
        }
        if (ctx.imageSmoothingQuality !== undefined) {
          ctx.imageSmoothingQuality = 'high';
        }
        this._canvas = canvas;
        this._ctx = ctx;
        this._canvasReady = true;
        this._invalidateMapCache();
        if (this.data.filterLine) {
          this._fitToLine(this.data.filterLine);
        } else {
          this._fitToView();
        }
        if (this._pendingFocus) {
          this._focusStation(this._pendingFocus);
          this._pendingFocus = '';
          this._pendingFocusLine = '';
        }
        this._scheduleDraw();

        wx.createSelectorQuery()
          .select('#metroCanvas')
          .boundingClientRect()
          .exec((rectRes) => {
            if (rectRes && rectRes[0]) this._canvasRect = rectRes[0];
          });
      });
  },

  _retryInit() {
    if (this._initRetries >= MAX_INIT_RETRIES) return;
    this._initRetries += 1;
    setTimeout(() => this._initCanvas(), INIT_RETRY_MS);
  },

  onFilterTap(e) {
    const line = e.currentTarget.dataset.line;
    const filterLine = line === undefined ? '' : line;
    this.setData({
      filterLine,
      showStationSheet: false,
      stationSheetData: null
    });
    this._invalidateMapCache();
    if (filterLine) {
      this._fitToLine(filterLine);
    } else {
      this._fitToView();
    }
    this._scheduleDraw();
  },

  onTagFilterTap(e) {
    const tag = e.currentTarget.dataset.tag;
    if (!tag) return;
    const filterTags = {
      ...this.data.filterTags,
      [tag]: !this.data.filterTags[tag]
    };
    this.data.filterTags = filterTags;
    this.setData({
      filterTags,
      showStationSheet: false,
      stationSheetData: null
    });
    this._scheduleDraw();
  },

  _hasActiveFilterTags() {
    const t = this.data.filterTags;
    return !!(t.unchecked || t.transfer || t.weekNew);
  },

  _isLineFocusMode() {
    return !!this.data.filterLine && !this._hasActiveFilterTags();
  },

  _stationOnFilterLine(st) {
    const filterLine = this.data.filterLine;
    return !!(filterLine && st.lines.includes(filterLine));
  },

  _stationMatchesFilter(name, checkedSet, weekNewSet) {
    const tags = this.data.filterTags;
    if (!this._hasActiveFilterTags()) return true;
    if (tags.unchecked && checkedSet.has(name)) return false;
    if (tags.transfer) {
      const info = this._transferMap[name];
      if (!info || info.count < 2) return false;
    }
    if (tags.weekNew && !weekNewSet.has(name)) return false;
    return true;
  },

  _focusStation(name) {
    const st = schematicStations.find(s => s.name === name);
    if (!st || !this._canvasW) return;

    const scale = Math.min(
      this._maxScale,
      Math.max(this._minScale, (this._baseScale || 0.5) * LINE_FIT_SCALE_FACTOR * 1.15)
    );
    this._scale = scale;
    this._offsetX = this._canvasW / 2 - st.x * scale;
    this._offsetY = this._canvasH / 2 - st.y * scale;

    const detail = metroMapState.getStationDetail(
      name,
      this._records,
      this._transferMap
    );
    this.setData({ showStationSheet: true, stationSheetData: detail });
  },

  _invalidateMapCache() {
    this._mapCacheKey = '';
  },

  _getLineStyle(line, filterLine) {
    const isActive = filterLine && line.key === filterLine;
    const isFiltered = !!filterLine;
    if (!isFiltered) return { alpha: 0.72, width: 13, emphasized: false };
    if (isActive) return { alpha: 1, width: 22, emphasized: true };
    return { alpha: 0.2, width: 9, emphasized: false };
  },

  _buildMapCache() {
    const filterLine = this.data.filterLine;
    const cacheKey = filterLine || '__all__';
    if (this._mapCacheKey === cacheKey) return;

    const worldW = Math.ceil(CONTENT_BOUNDS.maxX - CONTENT_BOUNDS.minX);
    const worldH = Math.ceil(CONTENT_BOUNDS.maxY - CONTENT_BOUNDS.minY);
    if (worldW <= 0 || worldH <= 0) return;

    try {
      if (!this._offCanvas) {
        this._offCanvas = wx.createOffscreenCanvas({ type: '2d', width: worldW, height: worldH });
      } else {
        this._offCanvas.width = worldW;
        this._offCanvas.height = worldH;
      }
    } catch (e) {
      this._offCanvas = null;
      return;
    }

    const ctx = this._offCanvas.getContext('2d');
    ctx.clearRect(0, 0, worldW, worldH);
    ctx.save();
    ctx.translate(-CONTENT_BOUNDS.minX, -CONTENT_BOUNDS.minY);

    schematicLines.forEach(line => {
      const style = this._getLineStyle(line, filterLine);
      renderer.drawMetroLine(ctx, line, style);
    });
    schematicStations.forEach(st => {
      const lineFocusMode = this._isLineFocusMode();
      const onLine = filterLine && st.lines.includes(filterLine);
      const isTransfer = st.lines.length > 1;
      if (lineFocusMode && filterLine && !onLine && isTransfer) {
        renderer.drawDarkStation(ctx, st, { subdued: true });
      } else {
        renderer.drawDarkStation(ctx, st);
      }
    });
    ctx.restore();
    this._mapCacheKey = cacheKey;
  },

  onResetView() {
    this._fitToView();
    this._scheduleDraw();
  },

  _getMapCenter() {
    return {
      x: (CONTENT_BOUNDS.minX + CONTENT_BOUNDS.maxX) / 2,
      y: (CONTENT_BOUNDS.minY + CONTENT_BOUNDS.maxY) / 2
    };
  },

  _applyCenteredScale(scale) {
    if (!this._canvasW) return;
    const clamped = Math.min(this._maxScale, Math.max(this._minScale, scale));
    const center = this._getMapCenter();
    this._scale = clamped;
    this._offsetX = this._canvasW / 2 - center.x * clamped;
    this._offsetY = this._canvasH / 2 - center.y * clamped;
  },

  _fitToView() {
    const pad = 36;
    const worldW = CONTENT_BOUNDS.maxX - CONTENT_BOUNDS.minX;
    const worldH = CONTENT_BOUNDS.maxY - CONTENT_BOUNDS.minY;
    if (!this._canvasW || worldW <= 0 || worldH <= 0) return;

    const scaleX = (this._canvasW - pad * 2) / worldW;
    const scaleY = (this._canvasH - pad * 2) / worldH;
    const fitScale = Math.min(scaleX, scaleY);
    this._baseScale = fitScale;
    this._minScale = fitScale * MIN_SCALE_FACTOR;
    this._maxScale = fitScale * MAX_SCALE_MULTIPLIER;
    this._applyCenteredScale(fitScale * ALL_VIEW_INITIAL_SCALE_FACTOR);
  },

  _fitToLine(lineKey) {
    const stations = schematicStations.filter(s => s.lines.includes(lineKey));
    if (!stations.length || !this._canvasW) {
      this._fitToView();
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    stations.forEach(s => {
      minX = Math.min(minX, s.x);
      minY = Math.min(minY, s.y);
      maxX = Math.max(maxX, s.x);
      maxY = Math.max(maxY, s.y);
    });

    const pad = 100;
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;
    const worldW = maxX - minX;
    const worldH = maxY - minY;
    const scaleX = (this._canvasW - 48) / worldW;
    const scaleY = (this._canvasH - 48) / worldH;
    const fitScale = Math.min(scaleX, scaleY);
    this._baseScale = fitScale;
    this._minScale = fitScale * MIN_SCALE_FACTOR;
    this._maxScale = fitScale * MAX_SCALE_MULTIPLIER;
    const scale = fitScale * LINE_FIT_SCALE_FACTOR;
    const clamped = Math.min(this._maxScale, Math.max(this._minScale, scale));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this._scale = clamped;
    this._offsetX = this._canvasW / 2 - cx * clamped;
    this._offsetY = this._canvasH / 2 - cy * clamped;
  },

  _shouldShowLineLabels() {
    if (!this.data.filterLine || !this._baseScale) return false;
    return this._scale >= this._baseScale * LINE_LABEL_SCALE_FACTOR;
  },

  _getFilteredLineColor(lineKey) {
    const line = schematicLines.find(l => l.key === lineKey);
    return line ? line.color : '#E8ECFF';
  },

  _screenToWorld(x, y) {
    return {
      x: (x - this._offsetX) / this._scale,
      y: (y - this._offsetY) / this._scale
    };
  },

  _localTouch(t) {
    const rect = this._canvasRect;
    if (!rect) return { x: t.clientX, y: t.clientY };
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  },

  _localCenter(t1, t2) {
    const a = this._localTouch(t1);
    const b = this._localTouch(t2);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  },

  _scheduleDraw() {
    if (this._drawPending || !this._canvasReady) return;
    this._drawPending = true;
    if (this._canvas && this._canvas.requestAnimationFrame) {
      this._canvas.requestAnimationFrame(() => {
        this._drawPending = false;
        this._draw();
      });
    } else {
      setTimeout(() => {
        this._drawPending = false;
        this._draw();
      }, 16);
    }
  },

  _draw() {
    if (!this._ctx || !this._canvasW) return;

    const ctx = this._ctx;
    const checkedSet = metroMapState.buildCheckedNameSet(this._records);
    const weekNewSet = buildWeekNewSet(this._records);
    const filterLine = this.data.filterLine;
    const hasTagFilter = this._hasActiveFilterTags();
    const lineFocusMode = this._isLineFocusMode();
    const matchFilter = name => this._stationMatchesFilter(name, checkedSet, weekNewSet);
    const selectedName = this.data.stationSheetData
      ? this.data.stationSheetData.name
      : null;
    const tick = this._interacting ? (this._frozenTick || this._tick) : this._tick;
    if (!this._interacting) this._frozenTick = tick;

    renderer.drawNightSkyScreen(ctx, this._canvasW, this._canvasH, tick, {
      dimmed: lineFocusMode
    });
    this._buildMapCache();

    ctx.save();
    ctx.translate(this._offsetX, this._offsetY);
    ctx.scale(this._scale, this._scale);

    if (this._offCanvas && this._mapCacheKey) {
      const worldW = CONTENT_BOUNDS.maxX - CONTENT_BOUNDS.minX;
      const worldH = CONTENT_BOUNDS.maxY - CONTENT_BOUNDS.minY;
      ctx.save();
      if (hasTagFilter) ctx.globalAlpha = FILTER_DIM_ALPHA;
      ctx.drawImage(
        this._offCanvas,
        CONTENT_BOUNDS.minX,
        CONTENT_BOUNDS.minY,
        worldW,
        worldH
      );
      ctx.restore();

      if (hasTagFilter) {
        schematicStations.forEach(st => {
          if (checkedSet.has(st.name)) return;
          if (!matchFilter(st.name)) return;
          renderer.drawDarkStation(ctx, st, { emphasized: true });
        });
      }
    } else {
      schematicLines.forEach(line => {
        ctx.save();
        if (hasTagFilter) ctx.globalAlpha = FILTER_DIM_ALPHA;
        renderer.drawMetroLine(ctx, line, this._getLineStyle(line, filterLine));
        ctx.restore();
      });
      schematicStations.forEach(st => {
        if (checkedSet.has(st.name)) return;
        const emphasized = hasTagFilter && matchFilter(st.name);
        ctx.save();
        if (hasTagFilter && !emphasized) ctx.globalAlpha = FILTER_DIM_ALPHA;
        renderer.drawDarkStation(ctx, st, { emphasized });
        ctx.restore();
      });
    }

    const litSegments = renderer.buildLitSegments(schematicStations, checkedSet);
    litSegments.forEach(seg => {
      const segMatch = !hasTagFilter
        || (matchFilter(seg.fromName) && matchFilter(seg.toName));
      ctx.save();
      if (hasTagFilter && !segMatch) ctx.globalAlpha = FILTER_DIM_ALPHA;
      renderer.drawLitPathSegment(ctx, seg.line, seg.points, tick);
      ctx.restore();
    });

    schematicStations.forEach(st => {
      if (!checkedSet.has(st.name)) return;
      const stMatch = matchFilter(st.name);
      ctx.save();
      if (hasTagFilter && !stMatch) ctx.globalAlpha = FILTER_DIM_ALPHA;
      if (st.lines.length > 1) {
        renderer.drawLitMoon(ctx, st, tick);
      } else {
        renderer.drawLitStar(ctx, st, tick);
      }
      ctx.restore();
    });

    if (this._shouldShowLineLabels()) {
      const lineKey = filterLine;
      const lineColor = this._getFilteredLineColor(lineKey);
      const lineStations = schematicStations.filter(s => s.lines.includes(lineKey));
      renderer.drawStationLabels(ctx, lineStations, lineColor, lineKey);
    }

    if (selectedName) {
      const st = schematicStations.find(s => s.name === selectedName);
      if (st) renderer.drawSelectedStationHighlight(ctx, st, tick);
    }

    ctx.restore();
  },

  _markInteracting() {
    this._interacting = true;
    this._frozenTick = this._tick;
    if (this._interactEndTimer) clearTimeout(this._interactEndTimer);
  },

  _markInteractEnd() {
    if (this._interactEndTimer) clearTimeout(this._interactEndTimer);
    this._interactEndTimer = setTimeout(() => {
      this._interacting = false;
      this._scheduleDraw();
    }, 160);
  },

  onTouchStart(e) {
    this._markInteracting();
    if (e.touches.length >= 2) {
      this._pinching = true;
      this._pinchStartDist = touchDistance(e.touches[0], e.touches[1]);
      this._pinchStartScale = this._scale;
      this._pinchStartOffset = { x: this._offsetX, y: this._offsetY };
      const center = this._localCenter(e.touches[0], e.touches[1]);
      this._pinchAnchorWorld = this._screenToWorld(center.x, center.y);
      this._panStart = null;
      this._tapCandidate = null;
      return;
    }

    if (e.touches.length === 1) {
      this._pinching = false;
      this._pinchStartDist = null;
      this._panStart = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        offsetX: this._offsetX,
        offsetY: this._offsetY
      };
      this._tapCandidate = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY
      };
    }
  },

  onTouchMove(e) {
    this._markInteracting();
    if (e.touches.length >= 2) {
      this._pinching = true;
      this._tapCandidate = null;
      this._panStart = null;
      if (!this._pinchStartDist) {
        this._pinchStartDist = touchDistance(e.touches[0], e.touches[1]);
        this._pinchStartScale = this._scale;
        this._pinchStartOffset = { x: this._offsetX, y: this._offsetY };
        const center = this._localCenter(e.touches[0], e.touches[1]);
        this._pinchAnchorWorld = this._screenToWorld(center.x, center.y);
      }
      const dist = touchDistance(e.touches[0], e.touches[1]);
      const center = this._localCenter(e.touches[0], e.touches[1]);
      let newScale = this._pinchStartScale * (dist / this._pinchStartDist);
      newScale = Math.min(this._maxScale, Math.max(this._minScale, newScale));
      this._scale = newScale;
      this._offsetX = center.x - this._pinchAnchorWorld.x * newScale;
      this._offsetY = center.y - this._pinchAnchorWorld.y * newScale;
      this._scheduleDraw();
      return;
    }

    if (e.touches.length === 1 && this._panStart && !this._pinching) {
      const dx = e.touches[0].clientX - this._panStart.x;
      const dy = e.touches[0].clientY - this._panStart.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        this._tapCandidate = null;
        this._offsetX = this._panStart.offsetX + dx;
        this._offsetY = this._panStart.offsetY + dy;
        this._scheduleDraw();
      }
    }
  },

  onTouchEnd(e) {
    if (this._pinching) {
      if (e.touches.length < 2) {
        this._pinching = false;
        this._pinchStartDist = null;
      }
      this._markInteractEnd();
      return;
    }

    if (this._tapCandidate && e.changedTouches.length === 1) {
      const t = e.changedTouches[0];
      const hit = (rect) => {
        const localX = t.clientX - rect.left;
        const localY = t.clientY - rect.top;
        this._handleTap(localX, localY);
      };
      if (this._canvasRect) hit(this._canvasRect);
      else {
        wx.createSelectorQuery()
          .select('#metroCanvas')
          .boundingClientRect()
          .exec((res) => {
            if (!res || !res[0]) return;
            this._canvasRect = res[0];
            hit(res[0]);
          });
      }
    }
    this._tapCandidate = null;
    this._markInteractEnd();
  },

  closeStationSheet() {
    this.setData({ showStationSheet: false, stationSheetData: null });
    this._scheduleDraw();
  },

  _handleTap(localX, localY) {
    const world = this._screenToWorld(localX, localY);
    let best = null;
    let bestDist = HIT_RADIUS / this._scale;

    schematicStations.forEach(st => {
      const dx = st.x - world.x;
      const dy = st.y - world.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) {
        bestDist = dist;
        best = st;
      }
    });

    if (!best) {
      this.setData({ showStationSheet: false, stationSheetData: null });
      this._scheduleDraw();
      return;
    }

    const detail = metroMapState.getStationDetail(
      best.name,
      this._records,
      this._transferMap
    );
    this.setData({ showStationSheet: true, stationSheetData: detail });
    this._scheduleDraw();
  },

  onUndoCheckin() {
    const { stationSheetData } = this.data;
    if (!stationSheetData || !stationSheetData.checked) return;

    wx.showModal({
      title: '撤销打卡',
      content: `确定撤销 ${stationSheetData.name} 的所有线路打卡记录吗？`,
      success: (res) => {
        if (!res.confirm) return;
        checkin.removeRecordsByName(stationSheetData.name);
        this._records = checkin.getRecords();
        const global = computeGlobalProgress();
        this.setData({
          showStationSheet: false,
          stationSheetData: null,
          ...global
        });
        this._scheduleDraw();
        wx.showToast({ title: '撤销成功' });
      }
    });
  },

  onGoCheckin() {
    const { stationSheetData } = this.data;
    if (!stationSheetData || stationSheetData.checked) return;

    const line = (stationSheetData.lines && stationSheetData.lines[0]) || '';
    const app = getApp();
    app.globalData.pendingNav = {
      line,
      stationName: stationSheetData.name
    };
    this.setData({ showStationSheet: false, stationSheetData: null });
    wx.navigateBack();
  }
});
