(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SegmentEditing = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var MIN_DURATION = 0.05;

  function finiteNumber(value, name) {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(name + " must be a finite number");
    return value;
  }

  function fullSegment(duration) {
    duration = finiteNumber(duration, "duration");
    if (duration <= 0) return [];
    return [{ start: 0, end: duration }];
  }

  function normalizeSegments(value, duration) {
    duration = finiteNumber(duration, "duration");
    if (duration <= 0) return [];
    if (value == null) return fullSegment(duration);
    if (!Array.isArray(value) || !value.length)
      throw new Error("segments must contain at least one segment");

    var normalized = [];
    for (var i = 0; i < value.length; i++) {
      var item = value[i];
      if (!item || typeof item !== "object")
        throw new Error("segment " + (i + 1) + " must be an object");
      var start = finiteNumber(item.start, "segment start");
      var end = finiteNumber(item.end, "segment end");
      if (start < 0) throw new Error("segment start must be at least zero");
      if (end > duration + 0.000001)
        throw new Error("segment end exceeds source duration");
      end = Math.min(end, duration);
      if (end <= start) throw new Error("segment end must be after segment start");
      if (end - start < MIN_DURATION - 0.000001)
        throw new Error("segments must be at least 0.05 seconds");
      if (normalized.length && start < normalized[normalized.length - 1].end - 0.000001)
        throw new Error("segments must be ordered and must not overlap");
      normalized.push({ start: start, end: end });
    }
    return normalized;
  }

  function segmentsForClip(clip, duration) {
    if (clip && Array.isArray(clip.segments) && clip.segments.length)
      return normalizeSegments(clip.segments, duration);
    if (clip && (clip.trimStart != null || clip.trimEnd != null)) {
      return normalizeSegments(
        [
          {
            start: clip.trimStart != null ? clip.trimStart : 0,
            end: clip.trimEnd != null ? clip.trimEnd : duration,
          },
        ],
        duration,
      );
    }
    return fullSegment(duration);
  }

  function selectedDuration(segments) {
    var total = 0;
    for (var i = 0; i < segments.length; i++)
      total += Math.max(0, segments[i].end - segments[i].start);
    return total;
  }

  function isFullSource(segments, duration) {
    return (
      segments.length === 1 &&
      segments[0].start <= 0.001 &&
      segments[0].end >= duration - 0.001
    );
  }

  function editEndpoint(segments, index, endpoint, value, duration) {
    var result = normalizeSegments(segments, duration);
    if (index < 0 || index >= result.length) throw new Error("invalid active segment");
    value = finiteNumber(value, endpoint);
    var current = result[index];
    var previousEnd = index > 0 ? result[index - 1].end : 0;
    var nextStart = index + 1 < result.length ? result[index + 1].start : duration;
    if (endpoint === "start") {
      current.start = Math.max(previousEnd, Math.min(value, current.end - MIN_DURATION));
    } else if (endpoint === "end") {
      current.end = Math.min(nextStart, Math.max(value, current.start + MIN_DURATION));
    } else {
      throw new Error("endpoint must be start or end");
    }
    return result;
  }

  function availableGaps(segments, duration) {
    var result = normalizeSegments(segments, duration);
    var gaps = [];
    var cursor = 0;
    for (var i = 0; i < result.length; i++) {
      if (result[i].start - cursor >= MIN_DURATION - 0.000001)
        gaps.push({ start: cursor, end: result[i].start, insertAt: i });
      cursor = result[i].end;
    }
    if (duration - cursor >= MIN_DURATION - 0.000001)
      gaps.push({ start: cursor, end: duration, insertAt: result.length });
    return gaps;
  }

  function canAddSegment(segments, duration) {
    return availableGaps(segments, duration).length > 0;
  }

  function addSegment(segments, duration, preferredTime) {
    var result = normalizeSegments(segments, duration);
    var at = Number.isFinite(preferredTime) ? preferredTime : duration / 2;
    at = Math.max(0, Math.min(duration, at));
    var gaps = availableGaps(result, duration);
    if (!gaps.length)
      throw new Error("Shorten a segment to create a gap before adding another one");

    var gap = gaps[0];
    for (var g = 0; g < gaps.length; g++) {
      if (at >= gaps[g].start && at <= gaps[g].end) {
        gap = gaps[g];
        break;
      }
      if (gaps[g].end - gaps[g].start > gap.end - gap.start) gap = gaps[g];
    }
    var length = Math.min(1, gap.end - gap.start);
    var start = Math.max(gap.start, Math.min(at - length / 2, gap.end - length));
    var added = { start: start, end: start + length };
    result.splice(gap.insertAt, 0, added);
    return { segments: result, index: gap.insertAt };
  }

  function moveSegment(segments, index, start, duration) {
    var result = normalizeSegments(segments, duration);
    if (index < 0 || index >= result.length) throw new Error("invalid active segment");
    start = finiteNumber(start, "segment start");
    var current = result[index];
    var length = current.end - current.start;
    var minimum = index > 0 ? result[index - 1].end : 0;
    var maximum =
      (index + 1 < result.length ? result[index + 1].start : duration) - length;
    current.start = Math.max(minimum, Math.min(start, maximum));
    current.end = current.start + length;
    return result;
  }

  function removeSegment(segments, index, duration) {
    var result = normalizeSegments(segments, duration);
    if (result.length <= 1) return fullSegment(duration);
    if (index < 0 || index >= result.length) throw new Error("invalid active segment");
    result.splice(index, 1);
    return result;
  }

  function segmentIndexAtTime(segments, time, tolerance) {
    tolerance = tolerance == null ? 0 : tolerance;
    for (var i = 0; i < segments.length; i++) {
      if (time >= segments[i].start - tolerance && time < segments[i].end - tolerance)
        return i;
    }
    return -1;
  }

  function playbackTarget(segments, time, tolerance) {
    tolerance = tolerance == null ? 0.04 : tolerance;
    if (!segments.length) return null;
    if (segmentIndexAtTime(segments, time, tolerance) >= 0) return null;
    for (var i = 0; i < segments.length; i++) {
      if (time < segments[i].start - tolerance) return segments[i].start;
    }
    return segments[0].start;
  }

  return {
    MIN_DURATION: MIN_DURATION,
    fullSegment: fullSegment,
    normalizeSegments: normalizeSegments,
    segmentsForClip: segmentsForClip,
    selectedDuration: selectedDuration,
    isFullSource: isFullSource,
    editEndpoint: editEndpoint,
    availableGaps: availableGaps,
    canAddSegment: canAddSegment,
    addSegment: addSegment,
    moveSegment: moveSegment,
    removeSegment: removeSegment,
    segmentIndexAtTime: segmentIndexAtTime,
    playbackTarget: playbackTarget,
  };
});
